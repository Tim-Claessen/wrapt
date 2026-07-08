import type { SupabaseClient } from '@supabase/supabase-js';

// Every window is computed from the `plays` log — there are no Spotify-native windows anymore. So
// each window diffs against the immediately-preceding equal-length period for real rank-change
// (NEW / ▲ / ▼) from day one, 6-month view included. `all` is the exception: "everything, ever"
// has no comparable previous period, so it carries no movement (see hasMovement in getLeaderboard).
export type LeaderboardWindow = '7d' | '30d' | '6m' | 'all' | 'custom';
export type LeaderboardKind = 'artists' | 'tracks' | 'genres';

const COMPUTED_WINDOW_DAYS: Record<'7d' | '30d' | '6m', number> = { '7d': 7, '30d': 30, '6m': 183 };

// Safely before any real Spotify listening data (Spotify launched 2008) — used as `all`'s `since`
// so the query is just "everything," without needing a per-profile earliest-play lookup.
const ALL_TIME_START = new Date('2000-01-01T00:00:00Z');

export interface LeaderboardEntry {
  id: string;
  title: string;
  subtitle: string | null;
  image: string | null;
  playCount: number | null; // always a number now (every window is computed from plays); kept null-tolerant for safety
  totalMs: number | null; // minutes listened for this entry — sum(coalesce(ms_played, duration_ms, 0)); 0 until backfilled
  rank: number;
  prevRank: number | null; // null means NEW this period — no rank in the immediately-preceding window
}

export interface LeaderboardResult {
  computed: boolean; // always true now (no native windows left); retained so callers/tests don't churn
  hasMovement: boolean; // false only for `all` — no comparable previous period to diff against
  entries: LeaderboardEntry[];
}

export interface DateRange {
  since: Date;
  until: Date;
  prevSince: Date;
  prevUntil: Date;
}

function computedRange(window: LeaderboardWindow, custom?: { since: Date; until: Date }): DateRange {
  return resolveWindowRange(window, custom);
}

// Date range (plus an equal-length "previous period" for deltas) for any window. Every window is
// sliced from `plays`, so the previous period is always available except for `all`, which is
// deliberately zero-width (nothing meaningful to diff "everything, ever" against).
export function resolveWindowRange(
  window: LeaderboardWindow,
  custom?: { since: Date; until: Date },
): DateRange {
  if (window === 'all') {
    // Zero-width prior window — "everything, ever" has no comparable previous period. Callers that
    // need to know whether a delta is meaningful check for this (see hasMovement / getListeningSummary).
    const until = new Date();
    return { since: ALL_TIME_START, until, prevSince: ALL_TIME_START, prevUntil: ALL_TIME_START };
  }
  if (window === 'custom') {
    if (!custom) throw new Error('custom window requires since/until');
    const spanMs = custom.until.getTime() - custom.since.getTime();
    return {
      since: custom.since,
      until: custom.until,
      prevSince: new Date(custom.since.getTime() - spanMs),
      prevUntil: custom.since,
    };
  }
  const days = COMPUTED_WINDOW_DAYS[window];
  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    since,
    until,
    prevSince: new Date(since.getTime() - days * 24 * 60 * 60 * 1000),
    prevUntil: since,
  };
}

async function computedArtists(
  supabase: SupabaseClient,
  profileId: string,
  range: DateRange,
  genre: string | null,
  limit: number,
): Promise<LeaderboardEntry[]> {
  const { data, error } = await supabase.rpc('leaderboard_top_artists', {
    p_profile_id: profileId,
    p_since: range.since.toISOString(),
    p_until: range.until.toISOString(),
    p_prev_since: range.prevSince.toISOString(),
    p_prev_until: range.prevUntil.toISOString(),
    p_genre: genre,
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.artist_id as string,
    title: row.artist_name as string,
    subtitle: null,
    image: (row.image as string) ?? null,
    playCount: row.play_count as number,
    totalMs: (row.total_ms as number) ?? 0,
    rank: row.rank as number,
    prevRank: (row.prev_rank as number | null) ?? null,
  }));
}

async function computedTracks(
  supabase: SupabaseClient,
  profileId: string,
  range: DateRange,
  genre: string | null,
  limit: number,
  artist: string | null = null,
): Promise<LeaderboardEntry[]> {
  const { data, error } = await supabase.rpc('leaderboard_top_tracks', {
    p_profile_id: profileId,
    p_since: range.since.toISOString(),
    p_until: range.until.toISOString(),
    p_prev_since: range.prevSince.toISOString(),
    p_prev_until: range.prevUntil.toISOString(),
    p_genre: genre,
    p_limit: limit,
    p_artist: artist,
  });
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.track_id as string,
    title: row.track_name as string,
    subtitle: (row.artist_names as string[]).join(', '),
    image: (row.album_image as string) ?? null,
    playCount: row.play_count as number,
    totalMs: (row.total_ms as number) ?? 0,
    rank: row.rank as number,
    prevRank: (row.prev_rank as number | null) ?? null,
  }));
}

async function computedGenres(
  supabase: SupabaseClient,
  profileId: string,
  range: DateRange,
  limit: number,
): Promise<LeaderboardEntry[]> {
  const { data, error } = await supabase.rpc('leaderboard_top_genres', {
    p_profile_id: profileId,
    p_since: range.since.toISOString(),
    p_until: range.until.toISOString(),
    p_prev_since: range.prevSince.toISOString(),
    p_prev_until: range.prevUntil.toISOString(),
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.genre as string,
    title: row.genre as string,
    subtitle: null,
    image: null,
    playCount: row.play_count as number,
    totalMs: (row.total_ms as number) ?? 0,
    rank: row.rank as number,
    prevRank: (row.prev_rank as number | null) ?? null,
  }));
}

export interface GetLeaderboardParams {
  supabase: SupabaseClient; // service-role client — see leaderboard_* function grants
  profileId: string;
  kind: LeaderboardKind;
  window: LeaderboardWindow;
  customSince?: Date;
  customUntil?: Date;
  genre?: string | null;
  artist?: string | null; // drill-down: when set (with kind 'tracks'), restrict to one artist's tracks
  limit?: number;
}

export async function getLeaderboard(params: GetLeaderboardParams): Promise<LeaderboardResult> {
  const { supabase, profileId, kind, window, customSince, customUntil, genre = null, artist = null, limit = 10 } =
    params;

  const range = computedRange(window, window === 'custom' ? { since: customSince!, until: customUntil! } : undefined);
  const entries =
    kind === 'artists'
      ? await computedArtists(supabase, profileId, range, genre, limit)
      : kind === 'tracks'
        ? await computedTracks(supabase, profileId, range, genre, limit, artist)
        : await computedGenres(supabase, profileId, range, limit);
  // Every window is computed; only `all` lacks a comparable prior period, so it's the one window
  // without movement indicators.
  return { computed: true, hasMovement: window !== 'all', entries };
}

// Available genre chips for the slicer, scoped to whatever window is currently selected.
export async function getAvailableGenres(
  supabase: SupabaseClient,
  profileId: string,
  window: LeaderboardWindow,
  customSince?: Date,
  customUntil?: Date,
): Promise<string[]> {
  const range = computedRange(window, window === 'custom' ? { since: customSince!, until: customUntil! } : undefined);
  const { data, error } = await supabase.rpc('leaderboard_available_genres', {
    p_profile_id: profileId,
    p_since: range.since.toISOString(),
    p_until: range.until.toISOString(),
    p_limit: 12,
  });
  if (error) throw error;
  return (data ?? []).map((row: { genre: string }) => row.genre);
}

// Top genres for the dashboard's "genre mix" chart — a thin wrapper around computedGenres that
// drops the prev-rank movement data callers don't need for a plain magnitude bar chart. Genre
// data only exists for computed windows (see NATIVE_WINDOWS note on getLeaderboard).
export async function getTopGenresForRange(
  supabase: SupabaseClient,
  profileId: string,
  range: DateRange,
  limit = 6,
): Promise<{ genre: string; playCount: number }[]> {
  const entries = await computedGenres(supabase, profileId, range, limit);
  return entries.map((entry) => ({ genre: entry.title, playCount: entry.playCount ?? 0 }));
}

// "History since <date>" note — lets sparse early computed windows read as expected, not broken.
export async function getPlaysHistorySince(supabase: SupabaseClient, profileId: string): Promise<Date | null> {
  const { data, error } = await supabase
    .from('plays')
    .select('played_at')
    .eq('profile_id', profileId)
    .order('played_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? new Date(data.played_at as string) : null;
}
