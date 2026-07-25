// Cron Worker (every 2h, see wrangler.jsonc) — polls /me/player/recently-played per connected
// profile and upserts into `plays`, so listening history accrues immediately instead of waiting
// on the weekly snapshot cron. Deployed standalone (`wrangler deploy`, not a Pages Function) since
// @astrojs/cloudflare 12.x has no scheduled-handler support at this pin (see CLAUDE.md).
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServiceClient } from '../../../src/lib/supabase';
import { getValidSpotifyAccessToken } from '../../../src/lib/tokens';
import { backfillTopArtistImages, syncArtistMetadata, syncRecentlyPlayed } from '../../../src/lib/plays';
import { drainGlobalEnrichmentBacklog } from '../../../src/lib/import';
import { SpotifyRateLimitError, SpotifyTokenExpiredError } from '../../../src/lib/spotify';

// Larger than the /import page's own foreground tick (25) since this runs unattended and can
// afford to spend more of the cron's own time budget per cycle. Drained over several rounds with
// gentle per-request pacing so a big imported backlog actually shrinks each cycle instead of
// tripping the dev-mode rate window on the first request and abandoning the whole cycle.
const ENRICHMENT_DRAIN_BATCH_SIZE = 100;
const ENRICHMENT_MAX_ROUNDS = 4;
const ENRICHMENT_PACING_MS = 150;
const ENRICHMENT_RATE_LIMIT_SLEEP_CAP_S = 15;

// Artist-artwork backfill. syncArtistMetadata only covers artists seen in *live* plays, so artists
// known only from imported history have no artists_cache row and the leaderboard renders a gradient
// placeholder for them. Each cycle we check the top ARTIST_IMAGE_SCAN_LIMIT artists and fill in a few
// of whichever are missing — small enough to stay well clear of the dev-mode rate window (C10) even
// stacked on top of the enrichment drain, and it converges over a handful of cycles.
const ARTIST_IMAGE_SCAN_LIMIT = 250;
const ARTIST_IMAGE_FETCH_PER_CYCLE = 25;
const ARTIST_IMAGE_PACING_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type SyncEnv = {
  SPOTIFY_CLIENT_ID: string;
  PUBLIC_SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  TOKEN_ENC_KEY: string;
};

interface SyncProfile {
  id: string;
  user_id: string;
  plays_cursor_after_ms: number | null;
}

// Returns the access token on success so the caller can reuse it for the (non-user-specific) import
// enrichment drain step below, without fetching a token a second time.
async function syncProfile(supabase: SupabaseClient, env: SyncEnv, profile: SyncProfile): Promise<string | null> {
  const tokenInfo = await getValidSpotifyAccessToken(profile.user_id, env);
  if (!tokenInfo) return null; // every spotify_profiles row implies a connected account; defensive only

  const result = await syncRecentlyPlayed(
    supabase,
    tokenInfo.accessToken,
    profile.id,
    profile.plays_cursor_after_ms,
  );
  if (result.fetched === 0) return tokenInfo.accessToken;

  await syncArtistMetadata(supabase, tokenInfo.accessToken, result.artistIds);

  if (result.newestPlayedAtMs && result.newestPlayedAtMs > (profile.plays_cursor_after_ms ?? 0)) {
    const { error } = await supabase
      .from('spotify_profiles')
      .update({ plays_cursor_after_ms: result.newestPlayedAtMs })
      .eq('id', profile.id);
    if (error) throw error;
  }

  return tokenInfo.accessToken;
}

async function runSync(env: SyncEnv): Promise<void> {
  const supabase = createSupabaseServiceClient(env);
  const { data: profiles, error } = await supabase
    .from('spotify_profiles')
    .select('id, user_id, plays_cursor_after_ms');
  if (error) throw error;

  console.log(`[sync] found ${profiles?.length ?? 0} profile(s)`);
  let lastAccessToken: string | null = null;
  // Rate limits are expected/self-healing (C10) and stay a warn-only skip. Everything else here —
  // an expired/revoked token, or a genuine unexpected error — means this profile silently stopped
  // syncing. console.error/warn alone never surfaces in Cloudflare's own error-rate metrics (a
  // caught error doesn't fail the invocation), so a real regression here could run for days without
  // tripping any alert. Collecting failures and throwing once at the end turns that into a real
  // Workers invocation error, which Cloudflare's alerting *can* see.
  const failures: string[] = [];
  for (const profile of profiles ?? []) {
    try {
      const accessToken = await syncProfile(supabase, env, profile);
      if (accessToken) lastAccessToken = accessToken;
    } catch (err) {
      if (err instanceof SpotifyRateLimitError) {
        console.warn(
          `[sync] profile ${profile.id} rate limited, skipping this cycle (retry after ${err.retryAfterSeconds}s)`,
        );
        continue;
      }
      if (err instanceof SpotifyTokenExpiredError) {
        console.warn(`[sync] profile ${profile.id} needs reconnect (refresh token invalid/revoked)`);
        failures.push(`${profile.id}: needs reconnect (refresh token invalid/revoked)`);
        continue;
      }
      console.error(`[sync] profile ${profile.id} failed:`, err);
      failures.push(`${profile.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Thrown (not just logged) so a cycle where every profile failed shows up as a real Workers
  // invocation error, not just quiet log lines — see the failures comment above the profile loop.
  function throwIfFailures(): void {
    if (failures.length > 0) {
      throw new Error(`[sync] ${failures.length} profile(s) failed this cycle:\n${failures.join('\n')}`);
    }
  }

  // Track lookups are public catalog data, not user-specific — any profile's token works for
  // resolving anyone's import-enrichment backlog, same reasoning as the shared artists_cache.
  if (!lastAccessToken) {
    console.log('[sync] import enrichment: no usable access token this cycle, skipping');
    throwIfFailures();
    return;
  }
  let totalResolved = 0;
  let totalFailed = 0;
  for (let round = 0; round < ENRICHMENT_MAX_ROUNDS; round++) {
    let result;
    try {
      result = await drainGlobalEnrichmentBacklog(
        supabase,
        lastAccessToken,
        ENRICHMENT_DRAIN_BATCH_SIZE,
        ENRICHMENT_PACING_MS,
      );
    } catch (err) {
      if (err instanceof SpotifyRateLimitError) {
        console.warn(`[sync] import enrichment rate limited (retry after ${err.retryAfterSeconds}s), stopping drain for this cycle`);
        break;
      }
      console.error('[sync] import enrichment drain failed:', err);
      break;
    }
    totalResolved += result.resolved;
    totalFailed += result.failed;
    // Rate-limited mid-round: the unprocessed tracks are still pending, so wait out the window
    // (bounded) and take another round rather than abandoning the cycle.
    if (result.rateLimited) {
      const waitS = Math.min(result.retryAfterSeconds ?? 30, ENRICHMENT_RATE_LIMIT_SLEEP_CAP_S);
      console.warn(`[sync] import enrichment hit rate limit; waiting ${waitS}s then continuing`);
      await sleep(waitS * 1000);
      continue;
    }
    if (result.processed === 0) break; // backlog drained
  }
  console.log(`[sync] import enrichment: resolved ${totalResolved}, failed ${totalFailed}`);

  // Artist artwork for the top of each profile's board (see the constants above). Runs after
  // enrichment because enrichment is what populates plays.artist_ids in the first place — an imported
  // artist has no id to look up until its tracks resolve. Rate limits end the step for this cycle
  // rather than failing it: the missing artists are simply picked up next time.
  for (const profile of profiles ?? []) {
    try {
      const result = await backfillTopArtistImages(supabase, lastAccessToken, profile.id, {
        scanLimit: ARTIST_IMAGE_SCAN_LIMIT,
        fetchLimit: ARTIST_IMAGE_FETCH_PER_CYCLE,
        pacingMs: ARTIST_IMAGE_PACING_MS,
      });
      if (result.missing > 0) {
        console.log(
          `[sync] artist images: cached ${result.cached}, ${result.missing - result.cached} still missing in the top ${ARTIST_IMAGE_SCAN_LIMIT} for profile ${profile.id}`,
        );
      }
    } catch (err) {
      if (err instanceof SpotifyRateLimitError) {
        console.warn(`[sync] artist image backfill rate limited (retry after ${err.retryAfterSeconds}s), stopping for this cycle`);
        break;
      }
      // Cosmetic backfill — never let it fail the cycle or mask a real sync failure.
      console.error(`[sync] artist image backfill failed for profile ${profile.id}:`, err);
    }
  }

  throwIfFailures();
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      runSync(env).catch((err) => {
        console.error('[sync] run failed:', err instanceof Error ? (err.stack ?? err.message) : JSON.stringify(err));
        throw err;
      }),
    );
  },
} satisfies ExportedHandler<SyncEnv>;
