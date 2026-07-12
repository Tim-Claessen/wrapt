// The /ask agent, text-to-SQL edition. The model gets one tool — query_database — and writes a
// read-only SQL SELECT against the listening schema; we validate it, run it through the read-only
// run_ask_sql sandbox (statement timeout + read-only transaction, see the ask_sql migration), and
// feed the rows back so the model can answer. This is a genuine "ask anything" over the data.
//
// Trust posture: the SQL is model-generated and therefore untrusted. It's kept safe by (1) an
// app-layer guard here (single SELECT/WITH, no semicolons/comments/data-modifying CTEs) and (2) the
// DB running it read-only with a timeout. It is NOT profile-isolated at the DB level yet — the model
// is told to filter by the caller's profile_id, which is fine while Tim is the only user (revisit
// before onboarding others; see the migration header).
import type { SupabaseClient } from '@supabase/supabase-js';
import { DISPLAY_TIME_ZONE } from './format';
import type { LlmMessage, LlmProvider, LlmToolSchema } from './llm';
import { bumpUsage, getUsageRemaining, resetUsage, type UsageState } from './usage';

export const ASK_KIND = 'ask';
export const ASK_DAILY_LIMIT = 50;

const MAX_TOOL_CALLS = 4; // SQL attempts across the whole conversation (leaves room to fix a bad query)
const MAX_STEPS = 6; // model round-trips — a couple more than the tool budget to leave room to synthesise

const FALLBACK_ANSWER = "Hmm — I couldn't work that one out. Try rephrasing, maybe naming a specific artist, track, or time range.";
const CORRECTIVE_INSTRUCTION =
  'You answered without querying the database. You may only state listening facts that come from a query result. Call query_database now, or if the question genuinely cannot be answered from the data, say so plainly.';
// Prefix for the user turn that carries query results back to the model. Kept as a user message (not
// role:'tool') because the live Workers AI binding rejects tool-role threading without matching tool
// call ids ("8001: Invalid input") — verified against the model.
const RESULTS_PREAMBLE =
  'Here are the rows your query returned. Answer my question using only these rows — quote their numbers and names verbatim. If a query failed, fix it and try again. If the rows are empty, say nothing matched rather than guessing.';

// ---------------------------------------------------------------------------------------------------
// SQL guard. The DB read-only transaction is the authoritative write-blocker; these checks are
// defense in depth plus they keep the run_ask_sql string-wrapping intact (no stray ';' or comment).

export class SqlValidationError extends Error {}

function sanitizeSql(raw: unknown): string {
  let sql = typeof raw === 'string' ? raw : '';
  sql = sql.trim();
  // Strip ```sql ... ``` fences the model sometimes wraps around the query.
  sql = sql.replace(/^```(?:sql)?\s*/i, '').replace(/\s*```$/, '').trim();
  // Strip trailing semicolons/whitespace (the wrapper adds its own structure).
  sql = sql.replace(/;+\s*$/, '').trim();
  return sql;
}

function validateSql(sql: string): void {
  if (!sql) throw new SqlValidationError('Write a SELECT query.');
  if (!/^(with|select)\b/i.test(sql)) {
    throw new SqlValidationError('Only SELECT queries are allowed (start with SELECT or WITH).');
  }
  if (sql.includes(';')) throw new SqlValidationError('Use a single statement — remove the ";".');
  if (/--|\/\*/.test(sql)) throw new SqlValidationError('Remove SQL comments from the query.');
  // Data-modifying CTE (WITH x AS (DELETE ...)) — precise match, won't false-positive on string
  // literals. Any other write is already blocked by the SELECT/WITH-only start + the read-only txn.
  if (/\bas\s*\(\s*(insert|update|delete|merge)\b/i.test(sql)) {
    throw new SqlValidationError('Read-only SELECTs only — no data-modifying CTEs.');
  }
}

// ---------------------------------------------------------------------------------------------------
// Rich payload — an optional table of the query result rendered under the answer.

export interface RichTable {
  type: 'table';
  title: string;
  columns: string[];
  rows: string[][];
}
export type RichPayload = RichTable;

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function buildTableRich(rows: Record<string, unknown>[]): RichTable {
  const columns = Object.keys(rows[0]);
  return {
    type: 'table',
    title: `Result · ${rows.length} row${rows.length === 1 ? '' : 's'}`,
    columns,
    rows: rows.slice(0, 12).map((r) => columns.map((c) => formatCell(r[c]))),
  };
}

// ---------------------------------------------------------------------------------------------------
// The one tool: run a read-only SELECT.

interface ToolContext {
  service: SupabaseClient;
  profileId: string;
}
interface ToolOutcome {
  result: unknown;
  rich?: RichPayload;
}

async function execQueryDatabase(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const sql = sanitizeSql(args.sql);
  try {
    validateSql(sql);
  } catch (err) {
    // Report guard failures back to the model so it can rewrite the query within its budget.
    if (err instanceof SqlValidationError) return { result: { error: err.message } };
    throw err;
  }

  const { data, error } = await ctx.service.rpc('run_ask_sql', { p_sql: sql });
  if (error) {
    // Surface the DB error (e.g. syntax, unknown column) so the model can correct its SQL — this is
    // the caller's own data, not sensitive, and it makes the agent self-correcting.
    return { result: { error: `SQL error: ${error.message}` } };
  }

  const rows = (Array.isArray(data) ? data : []) as Record<string, unknown>[];
  return {
    result: { rowCount: rows.length, rows: rows.slice(0, 50), truncated: rows.length > 50 },
    rich: rows.length > 0 ? buildTableRich(rows) : undefined,
  };
}

export const TOOL_SCHEMAS: LlmToolSchema[] = [
  {
    name: 'query_database',
    description:
      "Run one read-only PostgreSQL SELECT against the user's listening database and get the matching rows back. Use it for every factual question about their listening.",
    parameters: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description:
            "A single read-only SELECT (or WITH … SELECT). Must filter by the user's profile_id. No semicolons, comments, or writes.",
        },
      },
      required: ['sql'],
    },
  },
];

// ---------------------------------------------------------------------------------------------------
// System prompt — the schema + the house rules for writing good, safe SQL.

function buildSystemPrompt(profileId: string): string {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: DISPLAY_TIME_ZONE }); // YYYY-MM-DD, AWST
  return [
    "You are Wrapt's listening assistant. Wrapt is a personal Spotify listening dashboard. You answer questions about the user's OWN listening by writing ONE read-only SQL query, running it with the query_database tool, then answering warmly and briefly from the rows.",
    `Today is ${today} (Australia/Perth). Use it to resolve relative dates like "this year" or "last month".`,
    `The user's profile_id is '${profileId}'. EVERY query must filter with: profile_id = '${profileId}'.`,
    '',
    'DATABASE (PostgreSQL):',
    '  plays(profile_id uuid, played_at timestamptz [UTC], track_id text, track_name text,',
    '        artist_ids text[], artist_names text[], album_image text, duration_ms int,',
    "        ms_played int, source text ['live'|'import'], created_at timestamptz)",
    '  artists_cache(id text  -- spotify artist id, name text, genres text[], image text)',
    '',
    'RULES:',
    '- Write a SINGLE read-only SELECT or WITH…SELECT. No INSERT/UPDATE/DELETE/DDL, no semicolons, no comments.',
    `- Always include: WHERE profile_id = '${profileId}'.`,
    '- There is NO artist_name column. Artists live in the text[] column artist_names (one play can have several). To rank, count, or filter by an individual artist you MUST unnest it: FROM plays p CROSS JOIN LATERAL unnest(p.artist_names) AS a(artist_name). Group/compare on lower(a.artist_name); match names with ILIKE (names include words like "The", e.g. "The Dreggs").',
    '- Track names are in track_name (a plain column). Listened time per play = coalesce(ms_played, duration_ms, 0) milliseconds; minutes = that / 60000.0.',
    '- Genres: join unnest(artist_ids) to artists_cache.id and use its genres array. Genre coverage is incomplete — if a genre query returns little, say so.',
    "- Timestamps are UTC. For local day/hour/month buckets use (played_at at time zone 'Australia/Perth').",
    '- To answer "where does artist/track X rank", rank ALL of them with a window function, then filter to X — do not just count X alone.',
    '- Always ORDER BY sensibly and LIMIT to <= 50 rows unless you aggregate to a single row.',
    '- Audio features (tempo, energy, valence, danceability, mood) do NOT exist in this data — say you can’t answer those rather than guessing.',
    '',
    'EXAMPLES:',
    `- Top artists by plays: SELECT a.artist_name, count(*) AS plays FROM plays p CROSS JOIN LATERAL unnest(p.artist_names) AS a(artist_name) WHERE p.profile_id = '${profileId}' GROUP BY lower(a.artist_name), a.artist_name ORDER BY plays DESC LIMIT 10`,
    `- Where a named artist ranks: WITH ranked AS (SELECT a.artist_name, count(*) AS plays, rank() OVER (ORDER BY count(*) DESC) AS position FROM plays p CROSS JOIN LATERAL unnest(p.artist_names) AS a(artist_name) WHERE p.profile_id = '${profileId}' GROUP BY lower(a.artist_name), a.artist_name) SELECT position, artist_name, plays FROM ranked WHERE lower(artist_name) ILIKE '%dreggs%'`,
    '',
    'After the rows come back, answer in 1-3 sentences using the exact numbers from the rows (do not put quotes or backticks around them). If a query errors, fix it and retry. STYLE: playful, warm, clarity first. Plain text only — no markdown or code formatting.',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------
// The agent loop.

export interface AskResult {
  answer: string;
  rich: RichPayload | null;
  toolsUsed: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export async function runAskAgent(params: {
  llm: LlmProvider;
  service: SupabaseClient;
  profileId: string;
  question: string;
}): Promise<AskResult> {
  const { llm, service, profileId, question } = params;
  const ctx: ToolContext = { service, profileId };
  const system = buildSystemPrompt(profileId);

  const messages: LlmMessage[] = [{ role: 'user', content: question }];
  let rich: RichPayload | null = null;
  const toolsUsed: string[] = [];
  let toolBudget = MAX_TOOL_CALLS;
  let correctiveTried = false;

  for (let step = 0; step < MAX_STEPS; step++) {
    // Once the budget is spent, drop the tools so the model must synthesise a text answer from the
    // rows already in context.
    const tools = toolBudget > 0 ? TOOL_SCHEMAS : [];
    const resp = await llm.chat({ system, messages, tools });

    if (tools.length > 0 && resp.toolCalls.length > 0) {
      const calls = resp.toolCalls.slice(0, toolBudget);
      messages.push({
        role: 'assistant',
        content: resp.text?.trim() || JSON.stringify(calls.map((c) => ({ name: c.name, arguments: c.arguments }))),
      });
      const toolResults: { tool: string; output: unknown }[] = [];
      for (const call of calls) {
        toolBudget--;
        toolsUsed.push(call.name);
        let output: unknown;
        try {
          if (call.name !== 'query_database') {
            output = { error: `Unknown tool "${call.name}". The only tool is query_database.` };
          } else {
            const outcome = await execQueryDatabase(asRecord(call.arguments), ctx);
            if (outcome.rich) rich = outcome.rich;
            output = outcome.result;
          }
        } catch (err) {
          console.error(`ask tool "${call.name}" failed`, err);
          output = { error: 'tool_unavailable' };
        }
        toolResults.push({ tool: call.name, output });
      }
      messages.push({ role: 'user', content: `${RESULTS_PREAMBLE}\n\n${JSON.stringify({ toolResults })}` });
      continue;
    }

    // Text answer path.
    const text = resp.text?.trim() ?? '';

    // A text answer with no query ever run is ungrounded. Retry once with a corrective nudge; if it
    // still won't ground, return the neutral fallback rather than an unsupported claim.
    if (toolsUsed.length === 0) {
      if (!correctiveTried) {
        correctiveTried = true;
        messages.push({ role: 'assistant', content: text || '…' });
        messages.push({ role: 'user', content: CORRECTIVE_INSTRUCTION });
        continue;
      }
      return { answer: FALLBACK_ANSWER, rich: null, toolsUsed };
    }

    return { answer: text || FALLBACK_ANSWER, rich, toolsUsed };
  }

  return { answer: FALLBACK_ANSWER, rich, toolsUsed };
}

// ---------------------------------------------------------------------------------------------------
// Usage cap — thin wrappers over the shared ai_usage helpers in ./usage (see also src/lib/playlist.ts,
// which caps the Playlist tab the same way with kind='playlist').

export type { UsageState };

export function bumpAskUsage(service: SupabaseClient, profileId: string): Promise<UsageState> {
  return bumpUsage(service, profileId, ASK_KIND, ASK_DAILY_LIMIT);
}

export function getAskRemaining(service: SupabaseClient, profileId: string): Promise<{ used: number; remaining: number; limit: number }> {
  return getUsageRemaining(service, profileId, ASK_KIND, ASK_DAILY_LIMIT);
}

export function resetAskUsage(service: SupabaseClient, profileId: string): Promise<void> {
  return resetUsage(service, profileId, ASK_KIND);
}
