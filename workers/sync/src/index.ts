// Cron Worker (every 2h, see wrangler.jsonc) — polls /me/player/recently-played per connected
// profile and upserts into `plays`, so listening history accrues immediately instead of waiting
// on the weekly snapshot cron. Deployed standalone (`wrangler deploy`, not a Pages Function) since
// @astrojs/cloudflare 12.x has no scheduled-handler support at this pin (see CLAUDE.md).
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServiceClient } from '../../../src/lib/supabase';
import { getValidSpotifyAccessToken } from '../../../src/lib/tokens';
import { syncArtistGenres, syncRecentlyPlayed } from '../../../src/lib/plays';
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

  await syncArtistGenres(supabase, tokenInfo.accessToken, result.artistIds);

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
        // Not a bug — the user needs to reconnect via /connect. No "needs reconnect" flag is
        // persisted (out of scope); this just keeps it out of the generic error log below so a
        // dead refresh token doesn't read as a real failure on every single cron cycle.
        console.warn(`[sync] profile ${profile.id} needs reconnect (refresh token invalid/revoked)`);
        continue;
      }
      console.error(`[sync] profile ${profile.id} failed:`, err);
    }
  }

  // Track lookups are public catalog data, not user-specific — any profile's token works for
  // resolving anyone's import-enrichment backlog, same reasoning as the shared artists_cache.
  if (!lastAccessToken) {
    console.log('[sync] import enrichment: no usable access token this cycle, skipping');
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
