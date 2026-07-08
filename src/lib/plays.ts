import type { SupabaseClient } from '@supabase/supabase-js';
import { getArtist, getRecentlyPlayed, type SpotifyRecentlyPlayedItem } from './spotify';

const ARTIST_CACHE_STALE_DAYS = 30;

export interface PlayRow {
  profile_id: string;
  played_at: string;
  track_id: string;
  track_name: string;
  artist_ids: string[];
  artist_names: string[];
  album_image: string | null;
  duration_ms: number | null; // null for imports until enrichment backfills the track's true duration
  source: 'live' | 'import';
}

function toPlayRow(profileId: string, item: SpotifyRecentlyPlayedItem): PlayRow {
  return {
    profile_id: profileId,
    played_at: item.played_at,
    track_id: item.track.id,
    track_name: item.track.name,
    artist_ids: item.track.artists.map((a) => a.id),
    artist_names: item.track.artists.map((a) => a.name),
    album_image: item.track.album.images[0]?.url ?? null,
    duration_ms: item.track.duration_ms,
    source: 'live',
  };
}

export interface SyncResult {
  fetched: number;
  newestPlayedAtMs: number | null;
  artistIds: string[];
}

// Pulls recently-played since the profile's cursor and upserts into `plays`. Idempotent — the
// (profile_id, played_at) unique constraint means re-running with the same or an older cursor
// (e.g. after a partial failure) just re-upserts identical rows.
export async function syncRecentlyPlayed(
  supabase: SupabaseClient,
  accessToken: string,
  profileId: string,
  afterMs: number | null,
): Promise<SyncResult> {
  const { items } = await getRecentlyPlayed(accessToken, afterMs);
  if (items.length === 0) return { fetched: 0, newestPlayedAtMs: null, artistIds: [] };

  const rows = items.map((item) => toPlayRow(profileId, item));
  const { error } = await supabase
    .from('plays')
    .upsert(rows, { onConflict: 'profile_id,played_at', ignoreDuplicates: true });
  if (error) throw error;

  const newestPlayedAtMs = Math.max(...items.map((item) => new Date(item.played_at).getTime()));
  const artistIds = [...new Set(rows.flatMap((row) => row.artist_ids))];
  return { fetched: items.length, newestPlayedAtMs, artistIds };
}

// Fills in artists_cache for any of the given artist ids that are missing or stale. Sequential,
// one request per artist (C6 — no batch endpoint); each call already carries its own 429 backoff.
export async function syncArtistGenres(
  supabase: SupabaseClient,
  accessToken: string,
  artistIds: string[],
): Promise<void> {
  if (artistIds.length === 0) return;

  const staleCutoff = new Date(Date.now() - ARTIST_CACHE_STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: cached, error } = await supabase
    .from('artists_cache')
    .select('id, fetched_at')
    .in('id', artistIds);
  if (error) throw error;

  const freshIds = new Set(
    (cached ?? []).filter((row) => row.fetched_at > staleCutoff).map((row) => row.id),
  );
  const toFetch = artistIds.filter((id) => !freshIds.has(id));

  for (const artistId of toFetch) {
    const artist = await getArtist(accessToken, artistId);
    const { error: upsertError } = await supabase.from('artists_cache').upsert({
      id: artist.id,
      name: artist.name,
      genres: artist.genres,
      image: artist.images[0]?.url ?? null,
      fetched_at: new Date().toISOString(),
    });
    if (upsertError) throw upsertError;
  }
}
