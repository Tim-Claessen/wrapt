import type { SupabaseClient } from '@supabase/supabase-js';

// Data access for the /artist page — a single-artist deep dive reached by searching a name.
// Both RPCs (supabase/migrations/20260711000000_artist_page.sql) are service_role-only, same trust
// boundary as leaderboard_*/plays_history*.

export interface ArtistSearchResult {
  artistName: string;
  playCount: number;
  image: string | null;
}

export async function searchArtists(
  supabase: SupabaseClient,
  profileId: string,
  query: string,
  limit = 8,
): Promise<ArtistSearchResult[]> {
  const { data, error } = await supabase.rpc('artist_search', {
    p_profile_id: profileId,
    p_query: query,
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    artistName: row.artist_name as string,
    playCount: Number(row.play_count ?? 0),
    image: (row.image as string | null) ?? null,
  }));
}

export interface ArtistChip {
  artistName: string;
  image: string | null;
}

export async function getRandomArtists(
  supabase: SupabaseClient,
  profileId: string,
  limit = 10,
): Promise<ArtistChip[]> {
  const { data, error } = await supabase.rpc('artist_random_sample', {
    p_profile_id: profileId,
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    artistName: row.artist_name as string,
    image: (row.image as string | null) ?? null,
  }));
}

export interface ArtistSummary {
  artistName: string;
  totalPlays: number;
  totalMs: number;
  firstPlayedAt: Date | null;
  firstTrackName: string | null;
  bestYear: number | null;
  bestYearMs: number;
  image: string | null;
}

export async function getArtistSummary(
  supabase: SupabaseClient,
  profileId: string,
  artist: string,
): Promise<ArtistSummary | null> {
  const { data, error } = await supabase.rpc('artist_summary', {
    p_profile_id: profileId,
    p_artist: artist,
  });
  if (error) throw error;
  const row = data?.[0] as Record<string, unknown> | undefined;
  if (!row || Number(row.total_plays ?? 0) === 0) return null;
  return {
    artistName: (row.artist_name as string | null) ?? artist,
    totalPlays: Number(row.total_plays ?? 0),
    totalMs: Number(row.total_ms ?? 0),
    firstPlayedAt: row.first_played_at ? new Date(row.first_played_at as string) : null,
    firstTrackName: (row.first_track_name as string | null) ?? null,
    bestYear: (row.best_year as number | null) ?? null,
    bestYearMs: Number(row.best_year_ms ?? 0),
    image: (row.image as string | null) ?? null,
  };
}
