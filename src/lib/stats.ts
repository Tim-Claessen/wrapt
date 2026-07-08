// Deep-dive dashboard stats — headline totals (with a delta vs the previous equal period),
// a bucketed listening trend, and a weekday x hour "when do you listen" heatmap. All three read
// from `plays` via the listening_* RPCs (supabase/migrations/20260708000004_listening_stats.sql),
// so — unlike the leaderboard's native windows — they're available for every window, since they
// never need Spotify's top endpoints.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DateRange } from './leaderboard';

export interface ListeningSummary {
  totalMs: number;
  totalPlays: number;
  distinctTracks: number;
  distinctArtists: number;
  activeDays: number;
}

export interface ListeningSummaryResult {
  current: ListeningSummary;
  // null when the window has no meaningful "previous period" to diff against (all/lifetime — see
  // resolveWindowRange's zero-width prev range for those).
  previous: ListeningSummary | null;
}

function toSummary(row: Record<string, unknown> | null): ListeningSummary {
  return {
    totalMs: Number(row?.total_ms ?? 0),
    totalPlays: Number(row?.total_plays ?? 0),
    distinctTracks: Number(row?.distinct_tracks ?? 0),
    distinctArtists: Number(row?.distinct_artists ?? 0),
    activeDays: Number(row?.active_days ?? 0),
  };
}

export async function getListeningSummary(
  supabase: SupabaseClient,
  profileId: string,
  range: DateRange,
): Promise<ListeningSummaryResult> {
  const hasPrevPeriod = range.prevSince.getTime() !== range.prevUntil.getTime();

  const [{ data: curData, error: curError }, prevResult] = await Promise.all([
    supabase.rpc('listening_summary', {
      p_profile_id: profileId,
      p_since: range.since.toISOString(),
      p_until: range.until.toISOString(),
    }),
    hasPrevPeriod
      ? supabase.rpc('listening_summary', {
          p_profile_id: profileId,
          p_since: range.prevSince.toISOString(),
          p_until: range.prevUntil.toISOString(),
        })
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (curError) throw curError;
  if (prevResult.error) throw prevResult.error;

  return {
    current: toSummary(curData?.[0] ?? null),
    previous: hasPrevPeriod ? toSummary(prevResult.data?.[0] ?? null) : null,
  };
}

export type TrendBucket = 'day' | 'week';

// Longer windows get weekly buckets so the chart stays readable (a 6-month window would otherwise
// be ~180 bars).
export function pickTrendBucket(range: DateRange): TrendBucket {
  const spanDays = (range.until.getTime() - range.since.getTime()) / (24 * 60 * 60 * 1000);
  return spanDays > 60 ? 'week' : 'day';
}

export interface TrendPoint {
  bucketStart: Date;
  playCount: number;
  totalMs: number;
}

export async function getListeningTrend(
  supabase: SupabaseClient,
  profileId: string,
  range: DateRange,
  bucket: TrendBucket,
): Promise<TrendPoint[]> {
  const { data, error } = await supabase.rpc('listening_trend', {
    p_profile_id: profileId,
    p_since: range.since.toISOString(),
    p_until: range.until.toISOString(),
    p_bucket: bucket,
  });
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    bucketStart: new Date(row.bucket_start as string),
    playCount: Number(row.play_count),
    totalMs: Number(row.total_ms),
  }));
}

// 7 (Sun..Sat, matching Postgres extract(dow)) x 24 (hour of day) grid of play counts. Sparse from
// the RPC — every cell is filled in here so callers never have to guard against missing entries.
export type HeatmapGrid = number[][];

export async function getListeningHeatmap(
  supabase: SupabaseClient,
  profileId: string,
  range: DateRange,
): Promise<{ grid: HeatmapGrid; max: number }> {
  const { data, error } = await supabase.rpc('listening_heatmap', {
    p_profile_id: profileId,
    p_since: range.since.toISOString(),
    p_until: range.until.toISOString(),
  });
  if (error) throw error;

  const grid: HeatmapGrid = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const weekday = Number(row.weekday);
    const hour = Number(row.hour);
    const count = Number(row.play_count);
    if (weekday < 0 || weekday > 6 || hour < 0 || hour > 23) continue;
    grid[weekday][hour] = count;
    if (count > max) max = count;
  }
  return { grid, max };
}

export interface RecentPlay {
  playedAt: Date;
  trackName: string;
  artistNames: string[];
  albumImage: string | null;
}

export async function getRecentPlays(
  supabase: SupabaseClient,
  profileId: string,
  limit = 8,
): Promise<RecentPlay[]> {
  const { data, error } = await supabase
    .from('plays')
    .select('played_at, track_name, artist_names, album_image')
    .eq('profile_id', profileId)
    .order('played_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    playedAt: new Date(row.played_at as string),
    trackName: row.track_name as string,
    artistNames: (row.artist_names as string[]) ?? [],
    albumImage: (row.album_image as string | null) ?? null,
  }));
}
