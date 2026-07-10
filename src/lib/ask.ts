// The /ask agent: the fixed tool whitelist the model may call, strict validation of every tool call
// (the model is untrusted — it never writes SQL and never picks whose data to read), the executors
// that map each tool 1:1 onto a server-side data function with the profile_id injected here, and the
// bounded agent loop that ties them together. See src/pages/api/ask.ts for the HTTP entry point.
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getLeaderboard,
  resolveWindowRange,
  type DateRange,
  type LeaderboardKind,
  type LeaderboardWindow,
} from './leaderboard';
import { getListeningSummary, getListeningTrend, pickTrendBucket, type TrendBucket } from './stats';
import { DISPLAY_TIME_ZONE } from './format';
import type { LlmMessage, LlmProvider, LlmToolSchema } from './llm';

export const ASK_KIND = 'ask';
export const ASK_DAILY_LIMIT = 50;

const MAX_TOOL_CALLS = 4; // hard budget across the whole conversation
const MAX_STEPS = 6; // model round-trips — a couple more than the tool budget to leave room to synthesise

const FALLBACK_ANSWER = "Hmm — I couldn't work that one out. Try rephrasing, or ask about your top artists, tracks, minutes, discoveries, or skips.";
const CORRECTIVE_INSTRUCTION =
  'You answered without calling a tool. You may only state listening facts that come from a tool result. Call one of the available tools now, or if the question genuinely cannot be answered with them, say so plainly.';

// ---------------------------------------------------------------------------------------------------
// Validation — every value the model sends is treated as hostile until checked.

export class ToolValidationError extends Error {}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function validateEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new ToolValidationError(`"${field}" must be one of: ${allowed.join(', ')}.`);
}

function validateLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new ToolValidationError('"limit" must be a number.');
  return Math.min(Math.max(Math.floor(n), 1), max);
}

// yyyy-mm-dd → Date (start/end of that day). Mirrors src/lib/params.ts, but throws rather than
// returning null so a bad custom date is a validation error the model gets told about.
function parseDay(value: unknown, field: string, endOfDay: boolean): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ToolValidationError(`"${field}" must be a date in YYYY-MM-DD form.`);
  }
  const date = new Date(endOfDay ? `${value}T23:59:59` : `${value}T00:00:00`);
  if (isNaN(date.getTime())) throw new ToolValidationError(`"${field}" is not a valid date.`);
  return date;
}

const WINDOWS: readonly LeaderboardWindow[] = ['7d', '30d', '6m', 'all', 'custom'];

interface ResolvedRange {
  window: LeaderboardWindow;
  customSince?: Date;
  customUntil?: Date;
  range: DateRange;
  label: string;
}

function labelFor(window: LeaderboardWindow, since?: Date, until?: Date): string {
  switch (window) {
    case '7d':
      return 'the last 7 days';
    case '30d':
      return 'the last 30 days';
    case '6m':
      return 'the last 6 months';
    case 'all':
      return 'all time';
    case 'custom': {
      const fmt = (d: Date) =>
        d.toLocaleDateString('en-GB', { timeZone: DISPLAY_TIME_ZONE, day: 'numeric', month: 'short', year: 'numeric' });
      return `${fmt(since!)} – ${fmt(until!)}`;
    }
  }
}

// Shared range parsing for every tool. `range` is one of the named windows or 'custom'; custom
// requires since/until (YYYY-MM-DD), which must be a non-empty, non-future-anchored span.
function resolveRange(args: Record<string, unknown>): ResolvedRange {
  const window = validateEnum(args.range, WINDOWS, 'range');
  if (window !== 'custom') {
    return { window, range: resolveWindowRange(window), label: labelFor(window) };
  }
  const since = parseDay(args.since, 'since', false);
  let until = parseDay(args.until, 'until', true);
  const now = new Date();
  if (until.getTime() > now.getTime()) until = now; // clamp a future end to now
  if (since.getTime() >= until.getTime()) {
    throw new ToolValidationError('"since" must be before "until".');
  }
  return {
    window,
    customSince: since,
    customUntil: until,
    range: resolveWindowRange('custom', { since, until }),
    label: labelFor('custom', since, until),
  };
}

// ---------------------------------------------------------------------------------------------------
// Rich payloads — the one optional structured block the UI renders alongside the text answer.

export interface RichRow {
  rank: number;
  title: string;
  subtitle: string | null;
  metric: string; // pre-formatted, mono-rendered (e.g. "34 plays · 120m", "72% skipped")
  image: string | null;
}

export type RichPayload =
  | { type: 'list'; title: string; shape: 'circle' | 'square'; rows: RichRow[] }
  | { type: 'trend'; title: string; unit: string; points: { label: string; value: number }[] };

// ---------------------------------------------------------------------------------------------------
// Tool executors — each returns a compact JSON `result` fed back to the model (numbers verbatim) and
// an optional `rich` block for the UI.

interface ToolContext {
  service: SupabaseClient;
  profileId: string;
}
interface ToolOutcome {
  result: unknown;
  rich?: RichPayload;
}
type ToolExecutor = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>;

const toMinutes = (totalMs: number) => Math.round(totalMs / 60000);

async function execListeningSummary(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const { range, label } = resolveRange(args);
  const summary = await getListeningSummary(ctx.service, ctx.profileId, range);
  const cur = summary.current;
  const prev = summary.previous;
  return {
    result: {
      range: label,
      minutes: toMinutes(cur.totalMs),
      plays: cur.totalPlays,
      distinctArtists: cur.distinctArtists,
      distinctTracks: cur.distinctTracks,
      activeDays: cur.activeDays,
      previousPeriod: prev
        ? { minutes: toMinutes(prev.totalMs), plays: prev.totalPlays, distinctArtists: prev.distinctArtists }
        : null,
    },
  };
}

async function execLeaderboard(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const { window, customSince, customUntil, label } = resolveRange(args);
  const kind = validateEnum<LeaderboardKind>(args.kind, ['artists', 'tracks'], 'kind');
  const limit = validateLimit(args.limit, 10, 25);
  const { entries, hasMovement } = await getLeaderboard({
    supabase: ctx.service,
    profileId: ctx.profileId,
    kind,
    window,
    customSince,
    customUntil,
    limit,
  });
  const result = {
    kind,
    range: label,
    entries: entries.map((e) => ({
      rank: e.rank,
      name: e.title,
      artist: e.subtitle,
      plays: e.playCount,
      minutes: e.totalMs ? toMinutes(e.totalMs) : 0,
      movement: !hasMovement ? null : e.prevRank === null ? 'new' : e.prevRank - e.rank,
    })),
  };
  const rich: RichPayload = {
    type: 'list',
    title: kind === 'artists' ? `Top artists · ${label}` : `Top tracks · ${label}`,
    shape: kind === 'artists' ? 'circle' : 'square',
    rows: entries.map((e) => ({
      rank: e.rank,
      title: e.title,
      subtitle: e.subtitle,
      metric: `${e.playCount ?? 0} plays${e.totalMs && e.totalMs > 0 ? ` · ${toMinutes(e.totalMs)}m` : ''}`,
      image: e.image,
    })),
  };
  return { result, rich };
}

async function execListeningTrend(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const { range, label } = resolveRange(args);
  const bucket =
    args.bucket === undefined ? pickTrendBucket(range) : validateEnum<TrendBucket>(args.bucket, ['day', 'week'], 'bucket');
  const trend = await getListeningTrend(ctx.service, ctx.profileId, range, bucket);
  const fmtLabel = (d: Date) =>
    d.toLocaleDateString('en-GB', {
      timeZone: DISPLAY_TIME_ZONE,
      ...(bucket === 'week' ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' }),
    });
  const points = trend.map((p) => ({ label: fmtLabel(p.bucketStart), plays: p.playCount, minutes: toMinutes(p.totalMs) }));
  const peak = points.reduce<{ label: string; plays: number } | null>(
    (best, p) => (best === null || p.plays > best.plays ? { label: p.label, plays: p.plays } : best),
    null,
  );
  const result = {
    range: label,
    bucket,
    totalPlays: points.reduce((a, p) => a + p.plays, 0),
    peak,
    points,
  };
  const rich: RichPayload = {
    type: 'trend',
    title: `Plays over ${label}`,
    unit: 'plays',
    points: points.map((p) => ({ label: p.label, value: p.plays })),
  };
  return { result, rich };
}

async function execFirstPlays(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const { range, label } = resolveRange(args);
  const displayLimit = validateLimit(args.limit, 12, 50);
  // Pull a generous cap so `newArtistCount` is exact for the "am I discovering more?" comparison,
  // then only surface the top few to the model / UI.
  const COUNT_CAP = 500;
  const { data, error } = await ctx.service.rpc('first_plays', {
    p_profile_id: ctx.profileId,
    p_since: range.since.toISOString(),
    p_until: range.until.toISOString(),
    p_limit: COUNT_CAP,
  });
  if (error) throw error;
  const rows = (data ?? []) as { artist_name: string; first_played_at: string; play_count: number }[];
  const shown = rows.slice(0, displayLimit);
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString('en-GB', { timeZone: DISPLAY_TIME_ZONE, day: 'numeric', month: 'short', year: 'numeric' });
  const result = {
    range: label,
    newArtistCount: rows.length,
    countCapped: rows.length === COUNT_CAP,
    showing: shown.length,
    artists: shown.map((r) => ({ name: r.artist_name, discovered: fmt(r.first_played_at), playsSince: Number(r.play_count) })),
  };
  const rich: RichPayload = {
    type: 'list',
    title: `New artists · ${label}`,
    shape: 'circle',
    rows: shown.map((r, i) => ({
      rank: i + 1,
      title: r.artist_name,
      subtitle: `discovered ${fmt(r.first_played_at)}`,
      metric: `${Number(r.play_count)} plays since`,
      image: null,
    })),
  };
  return { result, rich };
}

async function execSkipStats(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const { range, label } = resolveRange(args);
  const limit = validateLimit(args.limit, 10, 25);
  const { data, error } = await ctx.service.rpc('skip_stats', {
    p_profile_id: ctx.profileId,
    p_since: range.since.toISOString(),
    p_until: range.until.toISOString(),
    p_limit: limit,
  });
  if (error) throw error;
  const rows = (data ?? []) as {
    track_id: string;
    track_name: string;
    artist_names: string[];
    plays: number;
    skips: number;
    skip_rate: number;
  }[];
  const result = {
    range: label,
    note: 'Skip = under 30s listened, or under half the track when its length is known. Only imported plays record listened-time, so live-only tracks never show as skipped.',
    tracks: rows.map((r) => ({
      name: r.track_name,
      artist: (r.artist_names ?? []).join(', '),
      plays: Number(r.plays),
      skips: Number(r.skips),
      skipRatePct: Math.round(Number(r.skip_rate) * 100),
    })),
  };
  const rich: RichPayload = {
    type: 'list',
    title: `Most skipped · ${label}`,
    shape: 'square',
    rows: rows.map((r, i) => ({
      rank: i + 1,
      title: r.track_name,
      subtitle: (r.artist_names ?? []).join(', ') || null,
      metric: `${Math.round(Number(r.skip_rate) * 100)}% skipped · ${r.skips}/${r.plays}`,
      image: null,
    })),
  };
  return { result, rich };
}

const EXECUTORS: Record<string, ToolExecutor> = {
  listening_summary: execListeningSummary,
  leaderboard: execLeaderboard,
  listening_trend: execListeningTrend,
  first_plays: execFirstPlays,
  skip_stats: execSkipStats,
};

export const TOOL_NAMES = Object.keys(EXECUTORS);

// ---------------------------------------------------------------------------------------------------
// Tool schemas advertised to the model. Kept in lockstep with EXECUTORS (a name here with no executor,
// or vice-versa, is a bug). `range` is shared shape across all five.

const RANGE_PROPS = {
  range: {
    type: 'string',
    enum: ['7d', '30d', '6m', 'all', 'custom'],
    description:
      "Time window. '7d'/'30d'/'6m' are the last N days/months from today; 'all' is all history; 'custom' needs since+until. For a specific month or year (e.g. 'in March', 'this year'), use 'custom' with explicit dates.",
  },
  since: { type: 'string', description: "Start date YYYY-MM-DD (only when range='custom')." },
  until: { type: 'string', description: "End date YYYY-MM-DD, inclusive (only when range='custom')." },
};

export const TOOL_SCHEMAS: LlmToolSchema[] = [
  {
    name: 'listening_summary',
    description:
      'Headline totals for a window — minutes listened, total plays, distinct artists/tracks, active days — plus the previous equal period for comparison. Use for "how much did I listen", "was I more active than last month".',
    parameters: { type: 'object', properties: { ...RANGE_PROPS }, required: ['range'] },
  },
  {
    name: 'leaderboard',
    description:
      'Top artists or tracks for a window, ranked by plays, with movement vs the previous period. Use for "who/what did I listen to most", "my #1 artist in March".',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['artists', 'tracks'], description: 'Rank artists or tracks.' },
        ...RANGE_PROPS,
        limit: { type: 'number', description: 'How many to return (1-25, default 10).' },
      },
      required: ['kind', 'range'],
    },
  },
  {
    name: 'listening_trend',
    description:
      'Plays and minutes bucketed over time (by day or week) for a window. Use for "when did I listen most", "how has my listening changed".',
    parameters: {
      type: 'object',
      properties: {
        ...RANGE_PROPS,
        bucket: { type: 'string', enum: ['day', 'week'], description: 'Bucket size; omit to auto-pick.' },
      },
      required: ['range'],
    },
  },
  {
    name: 'first_plays',
    description:
      'Artists first ever heard within a window (newest discovery first), with a total count of new artists in that window. Use for "what did I discover", "am I finding more new artists this year".',
    parameters: {
      type: 'object',
      properties: { ...RANGE_PROPS, limit: { type: 'number', description: 'How many to list (1-50, default 12).' } },
      required: ['range'],
    },
  },
  {
    name: 'skip_stats',
    description:
      'Tracks you skip most in a window (proxy: under 30s listened, or under half the track), needing 5+ plays to rank. Use for "what do I skip the most".',
    parameters: {
      type: 'object',
      properties: { ...RANGE_PROPS, limit: { type: 'number', description: 'How many to return (1-25, default 10).' } },
      required: ['range'],
    },
  },
];

// ---------------------------------------------------------------------------------------------------
// System prompt.

function buildSystemPrompt(): string {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: DISPLAY_TIME_ZONE }); // YYYY-MM-DD, AWST
  return [
    "You are Wrapt's listening assistant. Wrapt is a personal Spotify listening dashboard. You answer questions about the user's OWN listening history, warmly and briefly.",
    `Today is ${today} (Australia/Perth time). Use this to resolve relative dates like "this year" or "last month".`,
    '',
    'RULES:',
    '- Answer ONLY from tool results. Every number, name, artist, and date in your answer must come verbatim from a tool result. Never estimate, guess, or invent.',
    '- To state any fact about listening, call a tool first. Do not answer listening questions from memory.',
    '- You may call up to 4 tools, then give a final answer. Prefer the fewest tools that answer the question. For comparisons (e.g. "more than last year?"), call the same tool twice with different ranges.',
    '- If the tools cannot answer, say so plainly. In particular: genre questions are unreliable (genre data is incomplete) and mood/energy/tempo/"vibe"/danceability questions are impossible (Spotify no longer exposes audio features) — say you can\'t do those rather than guessing.',
    '- Minutes-listened and skip stats mostly reflect imported history; if a number looks thin, it may be because live plays don\'t record listened-time. Mention this only if relevant.',
    '',
    'STYLE: playful, warm, human — one light touch is fine, clarity first. 1-3 sentences. Numbers read naturally (e.g. "You played Radiohead 42 times").',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------
// The agent loop.

export interface AskResult {
  answer: string;
  rich: RichPayload | null;
  toolsUsed: string[];
}

async function runToolCall(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const executor = EXECUTORS[name];
  if (!executor) throw new ToolValidationError(`Unknown tool "${name}".`);
  return executor(args, ctx);
}

export async function runAskAgent(params: {
  llm: LlmProvider;
  service: SupabaseClient;
  profileId: string;
  question: string;
}): Promise<AskResult> {
  const { llm, service, profileId, question } = params;
  const ctx: ToolContext = { service, profileId };
  const system = buildSystemPrompt();

  const messages: LlmMessage[] = [{ role: 'user', content: question }];
  let rich: RichPayload | null = null;
  const toolsUsed: string[] = [];
  let toolBudget = MAX_TOOL_CALLS;
  let correctiveTried = false;

  for (let step = 0; step < MAX_STEPS; step++) {
    // Once the budget is spent, drop the tools so the model is forced to synthesise a text answer
    // from the results already in context.
    const tools = toolBudget > 0 ? TOOL_SCHEMAS : [];
    const resp = await llm.chat({ system, messages, tools });

    if (tools.length > 0 && resp.toolCalls.length > 0) {
      const calls = resp.toolCalls.slice(0, toolBudget);
      messages.push({
        role: 'assistant',
        content: JSON.stringify(calls.map((c) => ({ name: c.name, arguments: c.arguments }))),
      });
      for (const call of calls) {
        toolBudget--;
        toolsUsed.push(call.name);
        let output: unknown;
        try {
          const outcome = await runToolCall(call.name, asRecord(call.arguments), ctx);
          if (outcome.rich) rich = outcome.rich;
          output = outcome.result;
        } catch (err) {
          // Validation failures and unknown tools are reported back to the model as tool output so it
          // can correct itself; real DB errors surface as a generic failure (never leak internals).
          output = err instanceof ToolValidationError ? { error: err.message } : { error: 'tool_unavailable' };
        }
        messages.push({ role: 'tool', content: JSON.stringify({ tool: call.name, output }) });
      }
      continue;
    }

    // Text answer path.
    const text = resp.text?.trim() ?? '';

    // A text answer with no tool ever called is ungrounded. Retry once with a corrective nudge; if it
    // still won't ground, return the neutral fallback rather than surfacing an unsupported claim.
    if (toolsUsed.length === 0) {
      if (!correctiveTried) {
        correctiveTried = true;
        messages.push({ role: 'user', content: CORRECTIVE_INSTRUCTION });
        continue;
      }
      return { answer: FALLBACK_ANSWER, rich: null, toolsUsed };
    }

    return { answer: text || FALLBACK_ANSWER, rich, toolsUsed };
  }

  // Exhausted the step budget without a clean final answer.
  return { answer: FALLBACK_ANSWER, rich, toolsUsed };
}

// ---------------------------------------------------------------------------------------------------
// Usage cap.

export interface UsageState {
  allowed: boolean;
  used: number;
  remaining: number;
}

// Atomically count this request against today's cap. Call once per accepted question, before the
// agent runs; a blocked request is not charged (see bump_ai_usage).
export async function bumpAskUsage(service: SupabaseClient, profileId: string): Promise<UsageState> {
  const { data, error } = await service.rpc('bump_ai_usage', {
    p_profile_id: profileId,
    p_kind: ASK_KIND,
    p_limit: ASK_DAILY_LIMIT,
  });
  if (error) throw error;
  const row = (data?.[0] ?? {}) as { allowed?: boolean; used?: number; remaining?: number };
  return {
    allowed: Boolean(row.allowed),
    used: Number(row.used ?? 0),
    remaining: Number(row.remaining ?? 0),
  };
}

// Read-only remaining count for today (no increment) — for the quiet counter on /settings and the
// /ask composer hint. Fails open (assumes a full allowance) rather than throwing, so a not-yet-pasted
// `ai_usage` table can't 500 the pages that display it — this is a display concern, not enforcement.
export async function getAskRemaining(service: SupabaseClient, profileId: string): Promise<{ used: number; remaining: number; limit: number }> {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: DISPLAY_TIME_ZONE }); // YYYY-MM-DD, AWST
  try {
    const { data, error } = await service
      .from('ai_usage')
      .select('count')
      .eq('profile_id', profileId)
      .eq('day', day)
      .eq('kind', ASK_KIND)
      .maybeSingle();
    if (error) throw error;
    const used = Number((data as { count?: number } | null)?.count ?? 0);
    return { used, remaining: Math.max(ASK_DAILY_LIMIT - used, 0), limit: ASK_DAILY_LIMIT };
  } catch {
    return { used: 0, remaining: ASK_DAILY_LIMIT, limit: ASK_DAILY_LIMIT };
  }
}
