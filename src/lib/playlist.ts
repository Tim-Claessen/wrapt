// The Playlist tab on /ask: brief + familiarity dial -> LLM drafts candidate tracks -> every candidate
// is resolved against the real Spotify Search API -> validated real tracks render -> user-initiated
// save creates a private playlist. Hallucination control lives entirely in validateCandidates: nothing
// renders, and nothing can be saved, unless it round-tripped through Spotify's own catalog first.
import type { SupabaseClient } from '@supabase/supabase-js';
import { getLeaderboard } from './leaderboard';
import type { LlmProvider } from './llm';
import { searchTracks, type SpotifyTrack } from './spotify';
import { bumpUsage, getUsageRemaining, resetUsage, type UsageState } from './usage';

export const PLAYLIST_KIND = 'playlist';
export const PLAYLIST_DAILY_LIMIT = 10;

export type FamiliarityDial = 'my_music' | 'mix' | 'discovery';

const DRAFT_TARGET = 28; // over-generate; validation culls
const RENDER_MAX = 20;
// Below this, still render whatever resolved (with a "struggled" note) rather than refuse outright —
// a thin, honestly-flagged result beats a flat apology. Only a genuinely empty result is a hard fail.
const RENDER_MIN = 12;
const RECENCY_PATTERN = /\b(new|newest|latest|recent(ly)?|this week|just released|just dropped)\b/i;

export function bumpPlaylistUsage(service: SupabaseClient, profileId: string): Promise<UsageState> {
  return bumpUsage(service, profileId, PLAYLIST_KIND, PLAYLIST_DAILY_LIMIT);
}

export function getPlaylistRemaining(service: SupabaseClient, profileId: string): Promise<{ used: number; remaining: number; limit: number }> {
  return getUsageRemaining(service, profileId, PLAYLIST_KIND, PLAYLIST_DAILY_LIMIT);
}

export function resetPlaylistUsage(service: SupabaseClient, profileId: string): Promise<void> {
  return resetUsage(service, profileId, PLAYLIST_KIND);
}

// ---------------------------------------------------------------------------------------------------
// 1. Profile assembly — top ~30 artists/tracks over 6 months (reusing the leaderboard RPCs verbatim,
// no new query). Kept compact (~30/30 short lines, comfortably under the ~1,500 token budget) rather
// than token-counted precisely.
//
// There's no "Top genres" line any more: Spotify removed genres from the artist object (C11), so
// artists_cache.genres is always empty and that line only ever emitted a placeholder. The model infers
// style from the artist and track names instead, which is what it was really doing regardless.

async function buildListeningProfile(service: SupabaseClient, profileId: string): Promise<string> {
  const [artists, tracks] = await Promise.all([
    getLeaderboard({ supabase: service, profileId, kind: 'artists', window: '6m', limit: 30 }),
    getLeaderboard({ supabase: service, profileId, kind: 'tracks', window: '6m', limit: 30 }),
  ]);

  const artistLines = artists.entries.map((e) => e.title).join(', ') || '(no listening history yet)';
  const trackLines = tracks.entries.map((e) => `${e.title} — ${e.subtitle ?? 'unknown artist'}`).join('\n') || '(no listening history yet)';

  return [
    `Top artists (last 6 months): ${artistLines}`,
    'Top tracks (last 6 months):',
    trackLines,
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------
// 2. Draft — one LLM call, strict JSON out.

export interface Candidate {
  artist: string;
  title: string;
}

interface DraftResult {
  name: string;
  description: string;
  candidates: Candidate[];
}

const DIAL_INSTRUCTIONS: Record<FamiliarityDial, string> = {
  my_music:
    "About 90% of the tracks should be by artists or exact tracks already in the listener's profile above — lean hard into what they already love, this should feel like a familiar favourites mix. Up to ~10% can be a close, similar suggestion.",
  mix: "Roughly half the tracks should be by artists/tracks from the listener's profile, and half should be new-to-them artists that are stylistically adjacent to their taste (similar genres/era/energy).",
  discovery:
    "Nearly all tracks should be by artists NOT in the listener's profile above, but stylistically adjacent to their taste (their genres, era, energy) — a genuine discovery mix, not a rehash of what they already play. It's fine for your picks to skew older/canonical rather than brand-new.",
};

// Regenerate context: the previous draft's tracks + the listener's plain-English feedback on it
// ("more upbeat", "less Bon Iver", "swap the sad ones"). Folded into the system prompt as an extra
// section rather than a special code path — the model just gets more to work with.
interface FeedbackContext {
  feedback: string;
  previousTracks: Candidate[];
}

function buildDraftSystemPrompt(profile: string, dial: FamiliarityDial, feedbackCtx?: FeedbackContext): string {
  const feedbackSection = feedbackCtx
    ? [
        '',
        'REGENERATE WITH FEEDBACK:',
        "The listener already saw a draft for this brief and asked for changes. Produce a fresh full set of tracks that takes their feedback into account — keep whatever still fits, replace whatever doesn't, and don't just repeat the previous list unchanged.",
        `Their feedback: "${feedbackCtx.feedback}"`,
        'Previously suggested tracks (for context, not necessarily to avoid — only drop the ones the feedback pushes against):',
        feedbackCtx.previousTracks.map((t) => `${t.artist} - ${t.title}`).join('; '),
      ].join('\n')
    : '';

  return [
    "You are Wrapt's music curator. Wrapt is a personal Spotify listening dashboard. Given the listener's own listening profile and a plain-English brief, propose a playlist.",
    '',
    "LISTENER'S PROFILE:",
    profile,
    '',
    `BRIEF DIAL ("${dial}"): ${DIAL_INSTRUCTIONS[dial]}`,
    feedbackSection,
    '',
    'RULES:',
    '- CRITICAL: every track you suggest must be a REAL, existing song by a real artist. A separate step will verify every suggestion against Spotify\'s catalog and silently drop anything that does not resolve — so it is fine to be unsure, but never invent a title or artist to fit the brief.',
    '- Your knowledge of very recent releases may be incomplete or outdated. If the brief asks for brand-new/latest music, do your best but favour tracks you are confident are real over guessing at exact new releases.',
    `- Suggest about ${DRAFT_TARGET} tracks, no duplicates, matching the brief's mood/activity/genre.`,
    '- Give the playlist a short, playful name (<=40 characters) and a one-sentence, warm, honest description (<=100 characters) reflecting the brief.',
    '',
    'Respond with ONLY a JSON object, no prose, no markdown fences:',
    '{"name": "...", "description": "...", "tracks": [{"artist": "...", "title": "..."}]}',
  ].join('\n');
}

// A ~28-track JSON payload needs real headroom — the provider's own default (see DEFAULT_MAX_TOKENS
// in src/lib/llm.ts) is sized for short answers/SQL, not this. Generous on purpose: a truncated
// completion is invalid JSON and silently yields zero candidates (see parseJsonObject below).
const DRAFT_MAX_TOKENS = 2048;

function stripFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

// Defensive JSON parse: strict parse first, then fall back to the first balanced-looking {...}
// substring in case the model wrapped the object in prose despite instructions not to. Logs on total
// failure (including a truncated/cut-off completion, which is otherwise indistinguishable from the
// model simply returning nothing) so a systemic issue is visible in server logs instead of just
// surfacing as "couldn't find any real matches" to the user.
function parseJsonObject(raw: string, context: string): Record<string, unknown> {
  const text = stripFences(raw);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        // fall through to logging below
      }
    }
    console.error(`playlist ${context}: model response wasn't valid JSON (length ${text.length}):`, text.slice(0, 500));
    return {};
  }
}

function parseCandidateRows(raw: unknown): Candidate[] {
  if (!Array.isArray(raw)) return [];
  const rows: Candidate[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const artist = (entry as Record<string, unknown>).artist;
    const title = (entry as Record<string, unknown>).title;
    if (typeof artist === 'string' && artist.trim() && typeof title === 'string' && title.trim()) {
      rows.push({ artist: artist.trim(), title: title.trim() });
    }
  }
  return rows;
}

async function draftCandidates(
  llm: LlmProvider,
  profile: string,
  brief: string,
  dial: FamiliarityDial,
  feedbackCtx?: FeedbackContext,
): Promise<DraftResult> {
  const system = buildDraftSystemPrompt(profile, dial, feedbackCtx);
  const resp = await llm.chat({
    system,
    messages: [{ role: 'user', content: brief }],
    tools: [],
    maxTokens: DRAFT_MAX_TOKENS,
  });
  const parsed = parseJsonObject(resp.text ?? '', 'draft');
  const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim().slice(0, 60) : 'Your mix';
  const description = typeof parsed.description === 'string' ? parsed.description.trim().slice(0, 160) : '';
  return { name, description, candidates: parseCandidateRows(parsed.tracks).slice(0, DRAFT_TARGET + 4) };
}

// One corrective call for the backfill pass — same house rules, asked to avoid repeating what's
// already been tried (resolved or rejected), no name/description needed this time.
async function draftReplacements(
  llm: LlmProvider,
  profile: string,
  brief: string,
  dial: FamiliarityDial,
  avoid: string[],
  count: number,
  feedbackCtx?: FeedbackContext,
): Promise<Candidate[]> {
  const system = buildDraftSystemPrompt(profile, dial, feedbackCtx);
  const message = [
    `${avoid.length} of your earlier suggestions could not be found on Spotify (typos, or they don't exist). Suggest ${count} NEW replacement tracks, different from all of these already tried:`,
    avoid.join('; '),
    '',
    'Respond with ONLY JSON: {"tracks": [{"artist": "...", "title": "..."}]}',
  ].join('\n');
  const resp = await llm.chat({
    system,
    messages: [
      { role: 'user', content: brief },
      { role: 'assistant', content: '(earlier draft omitted)' },
      { role: 'user', content: message },
    ],
    tools: [],
    maxTokens: DRAFT_MAX_TOKENS,
  });
  const parsed = parseJsonObject(resp.text ?? '', 'backfill');
  return parseCandidateRows(parsed.tracks).slice(0, count + 4);
}

// ---------------------------------------------------------------------------------------------------
// 3. Validation — the critical stage. Nothing renders or saves unless it resolves here.

export interface ResolvedTrack {
  id: string;
  uri: string;
  name: string;
  artists: string[];
  image: string | null;
  durationMs: number;
}

// Diacritics stripped, lowercased, bracketed content (feat./remaster/live year etc.) and trailing
// "feat./ft./featuring" clauses removed, punctuation collapsed to spaces. A candidate is accepted only
// on exact match after this normalisation — no fuzzy/edit-distance matching (a wrong-song "match" is
// worse than a dropped one).
const COMBINING_DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');

function normalise(s: string): string {
  return s
    .normalize('NFD')
    .replace(COMBINING_DIACRITICS, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\[.*?\]/g, ' ')
    .replace(/\b(feat|featuring|ft)\.?\s+.*/, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function isMatch(candidate: Candidate, track: SpotifyTrack): boolean {
  if (normalise(candidate.title) !== normalise(track.name)) return false;
  const wantArtist = normalise(candidate.artist);
  return track.artists.some((a) => {
    const gotArtist = normalise(a.name);
    return gotArtist === wantArtist || (wantArtist.length > 2 && gotArtist.includes(wantArtist)) || (gotArtist.length > 2 && wantArtist.includes(gotArtist));
  });
}

function toResolvedTrack(track: SpotifyTrack): ResolvedTrack {
  return {
    id: track.id,
    uri: `spotify:track:${track.id}`,
    name: track.name,
    artists: track.artists.map((a) => a.name),
    image: track.album.images[0]?.url ?? null,
    durationMs: track.duration_ms,
  };
}

// Cloudflare's free Workers plan hard-caps a request at 50 outbound fetches ("Too many subrequests"),
// and the Supabase/auth/token calls before validation already spend ~8 of them. Budget what's left
// across BOTH validation passes (each search is one fetch, a 429 retry another — hence the slack),
// and stop searching once the render target is met; unattempted candidates are just dropped.
const SEARCH_BUDGET = 34;

interface SearchBudget {
  remaining: number;
}

async function validateCandidates(
  accessToken: string,
  candidates: Candidate[],
  budget: SearchBudget,
  target: number,
): Promise<{ resolved: ResolvedTrack[]; rejected: Candidate[] }> {
  const resolved: ResolvedTrack[] = [];
  const rejected: Candidate[] = [];
  // Sequential, not concurrent — politely respects Spotify's dev-mode rolling rate limit (C10);
  // spotifyRequest already retries 429s with backoff underneath searchTracks.
  for (const candidate of candidates) {
    if (resolved.length >= target || budget.remaining <= 0) break;
    budget.remaining--;
    let results: SpotifyTrack[] = [];
    try {
      results = await searchTracks(accessToken, candidate.artist, candidate.title);
    } catch (err) {
      // Logged, not swallowed — a systemic failure here (rate limit, expired token) would otherwise
      // look identical to "the model's suggestions weren't real" by the time it reaches the user.
      console.error(`playlist search failed for "${candidate.artist} - ${candidate.title}":`, err);
      rejected.push(candidate);
      continue;
    }
    const match = results.find((t) => isMatch(candidate, t));
    if (match) resolved.push(toResolvedTrack(match));
    else rejected.push(candidate);
  }
  return { resolved, rejected };
}

function dedupeById(tracks: ResolvedTrack[]): ResolvedTrack[] {
  const seen = new Map<string, ResolvedTrack>();
  for (const t of tracks) if (!seen.has(t.id)) seen.set(t.id, t);
  return [...seen.values()];
}

// ---------------------------------------------------------------------------------------------------
// 4. Orchestration.

export type PlaylistResult =
  | { ok: true; name: string; description: string; tracks: ResolvedTrack[]; recencyCaveat: boolean; struggled: boolean }
  | { ok: false; message: string };

export async function generatePlaylist(params: {
  llm: LlmProvider;
  service: SupabaseClient;
  profileId: string;
  accessToken: string;
  brief: string;
  dial: FamiliarityDial;
  feedback?: string;
  previousTracks?: Candidate[];
}): Promise<PlaylistResult> {
  const { llm, service, profileId, accessToken, brief, dial, feedback, previousTracks } = params;
  const feedbackCtx: FeedbackContext | undefined =
    feedback && previousTracks && previousTracks.length > 0 ? { feedback, previousTracks } : undefined;

  const profile = await buildListeningProfile(service, profileId);
  const draft = await draftCandidates(llm, profile, brief, dial, feedbackCtx);

  const budget: SearchBudget = { remaining: SEARCH_BUDGET };
  let { resolved, rejected } = await validateCandidates(accessToken, draft.candidates, budget, RENDER_MAX);
  resolved = dedupeById(resolved);

  if (resolved.length < RENDER_MAX && budget.remaining > 0 && (resolved.length > 0 || draft.candidates.length > 0)) {
    const needed = RENDER_MAX - resolved.length;
    const avoidNames = [
      ...resolved.map((r) => `${r.artists[0] ?? ''} - ${r.name}`),
      ...rejected.map((c) => `${c.artist} - ${c.title}`),
    ];
    const replacements = await draftReplacements(llm, profile, brief, dial, avoidNames, needed, feedbackCtx);
    if (replacements.length > 0) {
      const backfill = await validateCandidates(accessToken, replacements, budget, needed);
      resolved = dedupeById([...resolved, ...backfill.resolved]);
    }
  }

  const tracks = resolved.slice(0, RENDER_MAX);
  if (tracks.length === 0) {
    return {
      ok: false,
      message: "I couldn't find any real matches for that brief — try naming an artist, genre, or mood a bit more specifically.",
    };
  }

  return {
    ok: true,
    name: draft.name,
    description: draft.description,
    tracks,
    recencyCaveat: RECENCY_PATTERN.test(brief),
    struggled: tracks.length < RENDER_MIN,
  };
}
