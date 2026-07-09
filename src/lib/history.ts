import type { SupabaseClient } from '@supabase/supabase-js';

// Play History data access — a chronological, filterable page of `plays` plus a matching aggregate
// for the HERO stats. Both go through the plays_history* RPCs (migration 20260709000004) so the
// free-text filter (track name OR any artist name) and date range are applied identically. Called
// with the service-role client after the caller's session is verified (RPCs are service_role-only).

export interface HistoryFilter {
  since?: Date | null;
  until?: Date | null;
  query?: string | null;
}

export interface HistoryPlay {
  playedAt: Date;
  trackId: string;
  trackName: string;
  artistNames: string[];
  albumImage: string | null;
  msPlayed: number | null;
  durationMs: number | null;
}

export interface HistorySummary {
  totalPlays: number;
  distinctTracks: number;
  distinctArtists: number;
  totalMs: number;
}

function rpcArgs(profileId: string, filter: HistoryFilter) {
  return {
    p_profile_id: profileId,
    p_since: filter.since ? filter.since.toISOString() : null,
    p_until: filter.until ? filter.until.toISOString() : null,
    p_query: filter.query && filter.query.trim() !== '' ? filter.query.trim() : null,
  };
}

export async function getHistoryPage(
  supabase: SupabaseClient,
  profileId: string,
  filter: HistoryFilter,
  limit: number,
  offset: number,
): Promise<HistoryPlay[]> {
  const { data, error } = await supabase.rpc('plays_history', {
    ...rpcArgs(profileId, filter),
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    playedAt: new Date(row.played_at as string),
    trackId: row.track_id as string,
    trackName: row.track_name as string,
    artistNames: (row.artist_names as string[]) ?? [],
    albumImage: (row.album_image as string | null) ?? null,
    msPlayed: (row.ms_played as number | null) ?? null,
    durationMs: (row.duration_ms as number | null) ?? null,
  }));
}

export async function getHistorySummary(
  supabase: SupabaseClient,
  profileId: string,
  filter: HistoryFilter,
): Promise<HistorySummary> {
  const { data, error } = await supabase.rpc('plays_history_summary', rpcArgs(profileId, filter));
  if (error) throw error;
  const row = (data?.[0] as Record<string, unknown> | undefined) ?? {};
  return {
    totalPlays: Number(row.total_plays ?? 0),
    distinctTracks: Number(row.distinct_tracks ?? 0),
    distinctArtists: Number(row.distinct_artists ?? 0),
    totalMs: Number(row.total_ms ?? 0),
  };
}
