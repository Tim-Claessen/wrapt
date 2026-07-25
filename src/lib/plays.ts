import type { SupabaseClient } from '@supabase/supabase-js';
import { getArtist, getRecentlyPlayed, type SpotifyRecentlyPlayedItem } from './spotify';

const ARTIST_CACHE_STALE_DAYS = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PlayRow {
  profile_id: string;
  played_at: string;
  track_id: string;
  track_name: string;
  artist_ids: string[];
  artist_names: string[];
  album_image: string | null;
  duration_ms: number | null; // null for imports until enrichment backfills the track's true duration
  ms_played: number | null; // actual listened-time; known for imports (from the export), null for live (falls back to duration_ms)
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
    ms_played: null, // recently-played doesn't report actual listened-time; minutes fall back to duration_ms
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
//
// This used to be about genres; Spotify has since removed genres from the artist object (C11), so the
// only thing worth caching now is the artist name and image — which is what the leaderboard's artist
// artwork reads. Renamed from syncArtistGenres to say what it actually does.
export async function syncArtistMetadata(
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
      genres: artist.genres ?? [], // always [] in practice — Spotify stopped returning genres (C11)
      image: artist.images[0]?.url ?? null,
      fetched_at: new Date().toISOString(),
    });
    if (upsertError) throw upsertError;
  }
}

export interface ArtistImageBackfillResult {
  missing: number; // top-ranked artists still without a cached image, before this run
  cached: number; // how many we resolved this run
}

// Backfills artists_cache for the artists the dashboard actually shows.
//
// Why this exists: syncArtistMetadata only ever sees artist ids from *live* recently-played rows, so
// an artist known only from imported history never gets a cache row — and the leaderboard reads its
// artwork solely from artists_cache (`left join` in leaderboard_top_artists), falling back to the
// gradient tile. After a big history import that's nearly every artist on the board.
//
// Rather than scanning every artist id in `plays` (a full unnest of the play log — slow enough to hit
// the statement timeout), it reuses leaderboard_top_artists to take the most-played artists and fills
// in whichever are missing an image. That prioritises exactly what's visible and converges over a few
// cron cycles instead of trying to do everything at once.
//
// It sweeps several windows, not just all-time: the dashboard defaults to 30d, and an artist heavy in
// recent rotation can sit well outside the all-time top few hundred. Windows are swept newest-first so
// a bounded fetchLimit spends its budget on the board most likely to be on screen.
const BACKFILL_SCAN_WINDOW_DAYS = [30, 183, null]; // null = all time; mirrors the dashboard's windows

export async function backfillTopArtistImages(
  supabase: SupabaseClient,
  accessToken: string,
  profileId: string,
  options: { scanLimit: number; fetchLimit: number; pacingMs?: number },
): Promise<ArtistImageBackfillResult> {
  const { scanLimit, fetchLimit, pacingMs = 0 } = options;
  const now = new Date();
  const allTimeStart = '2000-01-01T00:00:00Z'; // matches ALL_TIME_START in src/lib/leaderboard.ts

  const missingIds: string[] = [];
  const seen = new Set<string>();
  for (const days of BACKFILL_SCAN_WINDOW_DAYS) {
    const since = days === null ? allTimeStart : new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase.rpc('leaderboard_top_artists', {
      p_profile_id: profileId,
      p_since: since,
      p_until: now.toISOString(),
      // Zero-width prior window — we only want the current ranking, never the rank-movement diff.
      p_prev_since: allTimeStart,
      p_prev_until: allTimeStart,
      p_genre: null,
      p_limit: scanLimit,
    });
    if (error) throw error;
    for (const row of (data ?? []) as { artist_id: string | null; image: string | null }[]) {
      if (!row.artist_id || row.image || seen.has(row.artist_id)) continue;
      seen.add(row.artist_id);
      missingIds.push(row.artist_id);
    }
  }
  if (missingIds.length === 0) return { missing: 0, cached: 0 };

  let cached = 0;
  for (const artistId of missingIds.slice(0, fetchLimit)) {
    if (pacingMs > 0 && cached > 0) await sleep(pacingMs);
    // A rate limit here propagates to the caller (SpotifyRateLimitError from spotifyRequest) — the
    // remaining ids stay missing and the next cycle picks them up, same as the enrichment drain.
    const artist = await getArtist(accessToken, artistId);
    const { error: upsertError } = await supabase.from('artists_cache').upsert({
      id: artist.id,
      name: artist.name,
      genres: artist.genres ?? [], // always [] — Spotify no longer returns genres (C11)
      image: artist.images[0]?.url ?? null,
      fetched_at: new Date().toISOString(),
    });
    if (upsertError) throw upsertError;
    cached++;
  }

  return { missing: missingIds.length, cached };
}
