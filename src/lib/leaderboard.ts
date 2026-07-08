import type { SupabaseClient } from '@supabase/supabase-js';
import { getTopItems, type SpotifyArtist, type SpotifyTopTimeRange, type SpotifyTrack } from './spotify';

// Native windows read straight from Spotify's own top endpoints — no rank-change data available
// there without our own snapshot history, so they render without movement indicators.
// Computed windows (7d/30d/custom/lifetime) are sliced from `plays`, which lets us diff against the
// immediately-preceding equal-length window for real rank-change from day one. `lifetime` has no
// meaningful "previous period" (see hasMovement below), but still benefits from imported history the
// same way the other computed windows do.
export type LeaderboardWindow = '7d' | '30d' | '4w' | '6m' | 'all' | 'custom' | 'lifetime';
export type LeaderboardKind = 'artists' | 'tracks' | 'genres';

const NATIVE_WINDOWS = new Set<LeaderboardWindow>(['4w', '6m', 'all']);
const NATIVE_TIME_RANGE: Record<'4w' | '6m' | 'all', SpotifyTopTimeRange> = {
  '4w': 'short_term',
  '6m': 'medium_term',
  all: 'long_term',
};
const COMPUTED_WINDOW_DAYS: Record<'7d' | '30d', number> = { '7d': 7, '30d': 30 };
// Approximate day-spans mirroring Spotify's short/medium_term windows — used only to give the
// dashboard's own stats (which read from `plays`, not the Spotify top endpoints) a comparable
// "previous period" for native windows, which otherwise have no rank-change data at all.
const NATIVE_WINDOW_DAYS: Record<'4w' | '6m', number> = { '4w': 28, '6m': 183 };

// Safely before any real Spotify listening data (Spotify launched 2008) — used as `lifetime`'s
// `since` so the query is just "everything," without needing a per-profile earliest-play lookup.
const LIFETIME_START = new Date('2000-01-01T00:00:00Z');

export interface LeaderboardEntry {
  id: string;
  title: string;
  subtitle: string | null;
  image: string | null;
  playCount: number | null; // null for native windows — Spotify's top endpoints don't expose counts
  rank: number;
  prevRank: number | null; // null under `computed: true` means NEW; meaningless under `computed: false`
}

export interface LeaderboardResult {
  computed: boolean;
  hasMovement: boolean; // false for native windows *and* lifetime (no meaningful "previous lifetime" to diff against)
  entries: LeaderboardEntry[];
}

export interface DateRange {
  since: Date;
  until: Date;
  prevSince: Date;
  prevUntil: Date;
}

function computedRange(
  window: '7d' | '30d' | 'custom' | 'lifetime',
  custom?: { since: Date; until: Date },
): DateRange {
  return resolveWindowRange(window, custom);
}

// Date range (plus an equal-length "previous period" for deltas) for *any* window, including the
// native Spotify ones (4w/6m/all) — those have no rank-change data from Spotify's top endpoints,
// but the dashboard's own stats read from `plays` directly, so they can still show a trend.
export function resolveWindowRange(
  window: LeaderboardWindow,
  custom?: { since: Date; until: Date },
): DateRange {
  if (window === 'lifetime' || window === 'all') {
    // Zero-width prior window — "previous lifetime" isn't meaningful. Callers that need to know
    // whether a delta is meaningful check for this (see hasMovement / getListeningSummary).
    const until = new Date();
    return { since: LIFETIME_START, until, prevSince: LIFETIME_START, prevUntil: LIFETIME_START };
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
  const days = window === '4w' || window === '6m' ? NATIVE_WINDOW_DAYS[window] : COMPUTED_WINDOW_DAYS[window];
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
): Promise<LeaderboardEntry[]> {
  const { data, error } = await supabase.rpc('leaderboard_top_tracks', {
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
    id: row.track_id as string,
    title: row.track_name as string,
    subtitle: (row.artist_names as string[]).join(', '),
    image: (row.album_image as string) ?? null,
    playCount: row.play_count as number,
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
    rank: row.rank as number,
    prevRank: (row.prev_rank as number | null) ?? null,
  }));
}

async function nativeTop(
  accessToken: string,
  kind: 'artists' | 'tracks',
  window: '4w' | '6m' | 'all',
  limit: number,
): Promise<LeaderboardEntry[]> {
  const { items } = await getTopItems(accessToken, kind, NATIVE_TIME_RANGE[window], limit);
  return items.map((item, index) => {
    if (kind === 'artists') {
      const artist = item as SpotifyArtist;
      return {
        id: artist.id,
        title: artist.name,
        subtitle: null,
        image: artist.images[0]?.url ?? null,
        playCount: null,
        rank: index + 1,
        prevRank: null,
      };
    }
    const track = item as SpotifyTrack;
    return {
      id: track.id,
      title: track.name,
      subtitle: track.artists.map((a) => a.name).join(', '),
      image: track.album.images[0]?.url ?? null,
      playCount: null,
      rank: index + 1,
      prevRank: null,
    };
  });
}

export interface GetLeaderboardParams {
  supabase: SupabaseClient; // service-role client — see leaderboard_* function grants
  accessToken: string | null; // only required for native windows (4w/6m/all)
  profileId: string;
  kind: LeaderboardKind;
  window: LeaderboardWindow;
  customSince?: Date;
  customUntil?: Date;
  genre?: string | null;
  limit?: number;
}

export async function getLeaderboard(params: GetLeaderboardParams): Promise<LeaderboardResult> {
  const { supabase, accessToken, profileId, kind, window, customSince, customUntil, genre = null, limit = 10 } =
    params;

  if (NATIVE_WINDOWS.has(window)) {
    if (kind === 'genres') return { computed: false, hasMovement: false, entries: [] }; // no genre data from native top endpoints
    if (!accessToken) return { computed: false, hasMovement: false, entries: [] };
    return {
      computed: false,
      hasMovement: false,
      entries: await nativeTop(accessToken, kind, window as '4w' | '6m' | 'all', limit),
    };
  }

  const range = computedRange(
    window as '7d' | '30d' | 'custom' | 'lifetime',
    window === 'custom' ? { since: customSince!, until: customUntil! } : undefined,
  );
  const entries =
    kind === 'artists'
      ? await computedArtists(supabase, profileId, range, genre, limit)
      : kind === 'tracks'
        ? await computedTracks(supabase, profileId, range, genre, limit)
        : await computedGenres(supabase, profileId, range, limit);
  return { computed: true, hasMovement: window !== 'lifetime', entries };
}

// Available genre chips for the slicer, scoped to whatever window is currently selected.
export async function getAvailableGenres(
  supabase: SupabaseClient,
  profileId: string,
  window: LeaderboardWindow,
  customSince?: Date,
  customUntil?: Date,
): Promise<string[]> {
  if (NATIVE_WINDOWS.has(window)) return [];
  const range = computedRange(
    window as '7d' | '30d' | 'custom' | 'lifetime',
    window === 'custom' ? { since: customSince!, until: customUntil! } : undefined,
  );
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
