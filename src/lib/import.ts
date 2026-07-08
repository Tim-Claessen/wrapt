import type { SupabaseClient } from '@supabase/supabase-js';
import { getTrack, SpotifyRateLimitError, SpotifyTrackNotFoundError } from './spotify';
import type { PlayRow } from './plays';

const MIN_MS_PLAYED = 30_000; // matches the live recently-played endpoint's effective threshold (C10-adjacent — Spotify itself only logs plays past a similar bar), so historical and live rankings stay comparable.
const LIVE_OVERLAP_TOLERANCE_MS = 2_000; // import `ts` is second-precision, live `played_at` is millisecond-precision — same play can land up to ~1s apart between the two sources.
const TRACK_URI_PREFIX = 'spotify:track:';

// Wire shape sent by the /import page's client script — already filtered/mapped client-side, but
// every check here is repeated server-side too (never trust the client).
export interface RawImportEntry {
  ts: string;
  msPlayed: number;
  trackUri: string;
  trackName: string;
  artistName: string;
  albumName: string | null;
}

export function parseTrackId(trackUri: string): string | null {
  return trackUri.startsWith(TRACK_URI_PREFIX) ? trackUri.slice(TRACK_URI_PREFIX.length) : null;
}

export interface IngestResult {
  received: number;
  imported: number;
  skipped: number;
}

// Ingests one batch of parsed export rows into `plays` with source='import'. Idempotent (same
// unique constraint + ignoreDuplicates as syncRecentlyPlayed) and safe to re-run the same file.
export async function ingestImportBatch(
  supabase: SupabaseClient,
  profileId: string,
  rows: RawImportEntry[],
): Promise<IngestResult> {
  const received = rows.length;

  const candidates = rows
    .filter((row) => row.msPlayed >= MIN_MS_PLAYED)
    .map((row) => ({ row, trackId: parseTrackId(row.trackUri), epochMs: new Date(row.ts).getTime() }))
    .filter(
      (c): c is { row: RawImportEntry; trackId: string; epochMs: number } =>
        c.trackId !== null && Number.isFinite(c.epochMs),
    );

  if (candidates.length === 0) return { received, imported: 0, skipped: received };

  // One ranged query per batch (not per row) — cheap since a batch's own timestamps already bound
  // the range tightly, unlike scanning a profile's entire live history.
  const minMs = Math.min(...candidates.map((c) => c.epochMs));
  const maxMs = Math.max(...candidates.map((c) => c.epochMs));
  const { data: liveRows, error: liveError } = await supabase
    .from('plays')
    .select('track_id, played_at')
    .eq('profile_id', profileId)
    .eq('source', 'live')
    .gte('played_at', new Date(minMs - LIVE_OVERLAP_TOLERANCE_MS).toISOString())
    .lte('played_at', new Date(maxMs + LIVE_OVERLAP_TOLERANCE_MS).toISOString());
  if (liveError) throw liveError;

  const liveByTrack = new Map<string, number[]>();
  for (const liveRow of liveRows ?? []) {
    const epochMs = new Date(liveRow.played_at as string).getTime();
    const list = liveByTrack.get(liveRow.track_id as string);
    if (list) list.push(epochMs);
    else liveByTrack.set(liveRow.track_id as string, [epochMs]);
  }

  const survivors = candidates.filter((c) => {
    const liveEpochs = liveByTrack.get(c.trackId);
    if (!liveEpochs) return true;
    return !liveEpochs.some((liveMs) => Math.abs(liveMs - c.epochMs) <= LIVE_OVERLAP_TOLERANCE_MS);
  });

  if (survivors.length === 0) return { received, imported: 0, skipped: received };

  const playRows: PlayRow[] = survivors.map((c) => ({
    profile_id: profileId,
    played_at: c.row.ts,
    track_id: c.trackId,
    track_name: c.row.trackName,
    artist_ids: [],
    artist_names: [c.row.artistName],
    album_image: null,
    duration_ms: null,
    source: 'import',
  }));

  const { data: inserted, error: insertError } = await supabase
    .from('plays')
    .upsert(playRows, { onConflict: 'profile_id,played_at', ignoreDuplicates: true })
    .select('id');
  if (insertError) throw insertError;

  const distinctTrackIds = [...new Set(survivors.map((c) => c.trackId))];
  const { error: registerError } = await supabase.rpc('import_register_tracks', { p_track_ids: distinctTrackIds });
  if (registerError) throw registerError;

  const imported = inserted?.length ?? 0;
  return { received, imported, skipped: received - imported };
}

export interface ImportProgress {
  total: number;
  done: number;
  failed: number;
  pending: number;
}

export async function getImportProgress(supabase: SupabaseClient, profileId: string): Promise<ImportProgress> {
  const { data, error } = await supabase.rpc('import_progress', { p_profile_id: profileId });
  if (error) throw error;
  const row = (data?.[0] as Record<string, number> | undefined) ?? { total: 0, done: 0, failed: 0, pending: 0 };
  return { total: Number(row.total), done: Number(row.done), failed: Number(row.failed), pending: Number(row.pending) };
}

export interface EnrichTickResult {
  processed: number;
  resolved: number;
  failed: number;
  remaining: number; // ids requested in this call that weren't handled (nonzero only when rate-limited)
  rateLimited: boolean;
  retryAfterSeconds?: number;
}

// Resolves each track id via Spotify's single-track endpoint (no batch endpoint, C6), applying
// metadata to every profile's matching plays rows at once (enrich_apply_track_metadata is shared,
// not profile-scoped). Stops immediately on a rate limit so the caller can back off instead of
// hammering Spotify with the rest of the batch.
async function resolveTracks(
  supabase: SupabaseClient,
  accessToken: string,
  trackIds: string[],
): Promise<EnrichTickResult> {
  let processed = 0;
  let resolved = 0;
  let failed = 0;

  for (const trackId of trackIds) {
    try {
      const track = await getTrack(accessToken, trackId);
      const { error } = await supabase.rpc('enrich_apply_track_metadata', {
        p_track_id: trackId,
        p_artist_ids: track.artists.map((a) => a.id),
        p_artist_names: track.artists.map((a) => a.name),
        p_album_image: track.album.images[0]?.url ?? null,
        p_duration_ms: track.duration_ms,
      });
      if (error) throw error;
      resolved++;
      processed++;
    } catch (err) {
      if (err instanceof SpotifyRateLimitError) {
        return {
          processed,
          resolved,
          failed,
          remaining: trackIds.length - processed,
          rateLimited: true,
          retryAfterSeconds: err.retryAfterSeconds,
        };
      }
      if (err instanceof SpotifyTrackNotFoundError) {
        const { error } = await supabase.rpc('mark_track_enrichment_failed', {
          p_track_id: trackId,
          p_error: err.message,
        });
        if (error) throw error;
        failed++;
        processed++;
        continue;
      }
      // Transient (network blip, unexpected 5xx) — leave it pending for a later tick rather than
      // burning one of the 3 permanent-failure attempts on a non-Spotify-verdict error.
      console.error(`[import] track ${trackId} enrichment attempt failed:`, err instanceof Error ? err.message : String(err));
      processed++;
    }
  }

  return { processed, resolved, failed, remaining: trackIds.length - processed, rateLimited: false };
}

// Drains one profile's own pending backlog, heaviest-rotation tracks first — used by the /import
// page's foreground tick loop.
export async function enrichNextBatch(
  supabase: SupabaseClient,
  accessToken: string,
  profileId: string,
  limit: number,
): Promise<EnrichTickResult> {
  const { data, error } = await supabase.rpc('import_pending_for_profile', { p_profile_id: profileId, p_limit: limit });
  if (error) throw error;
  const trackIds = (data ?? []).map((row: { track_id: string }) => row.track_id);
  return resolveTracks(supabase, accessToken, trackIds);
}

// Drains the shared global backlog regardless of which profile it belongs to — used by the 2-hourly
// sync cron so import enrichment keeps progressing even with no /import tab open.
export async function drainGlobalEnrichmentBacklog(
  supabase: SupabaseClient,
  accessToken: string,
  limit: number,
): Promise<EnrichTickResult> {
  const { data, error } = await supabase
    .from('import_track_enrichment')
    .select('track_id')
    .eq('status', 'pending')
    .order('updated_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  const trackIds = (data ?? []).map((row) => row.track_id as string);
  return resolveTracks(supabase, accessToken, trackIds);
}
