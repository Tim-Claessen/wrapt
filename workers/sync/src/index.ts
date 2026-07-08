// Cron Worker (every 2h, see wrangler.jsonc) — polls /me/player/recently-played per connected
// profile and upserts into `plays`, so listening history accrues immediately instead of waiting
// on the weekly snapshot cron. Deployed standalone (`wrangler deploy`, not a Pages Function) since
// @astrojs/cloudflare 12.x has no scheduled-handler support at this pin (see CLAUDE.md).
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServiceClient } from '../../../src/lib/supabase';
import { getValidSpotifyAccessToken } from '../../../src/lib/tokens';
import { syncArtistGenres, syncRecentlyPlayed } from '../../../src/lib/plays';
import { SpotifyRateLimitError } from '../../../src/lib/spotify';

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

async function syncProfile(supabase: SupabaseClient, env: SyncEnv, profile: SyncProfile): Promise<void> {
  const tokenInfo = await getValidSpotifyAccessToken(profile.user_id, env);
  if (!tokenInfo) return; // every spotify_profiles row implies a connected account; defensive only

  const result = await syncRecentlyPlayed(
    supabase,
    tokenInfo.accessToken,
    profile.id,
    profile.plays_cursor_after_ms,
  );
  if (result.fetched === 0) return;

  await syncArtistGenres(supabase, tokenInfo.accessToken, result.artistIds);

  if (result.newestPlayedAtMs && result.newestPlayedAtMs > (profile.plays_cursor_after_ms ?? 0)) {
    const { error } = await supabase
      .from('spotify_profiles')
      .update({ plays_cursor_after_ms: result.newestPlayedAtMs })
      .eq('id', profile.id);
    if (error) throw error;
  }
}

async function runSync(env: SyncEnv): Promise<void> {
  const supabase = createSupabaseServiceClient(env);
  const { data: profiles, error } = await supabase
    .from('spotify_profiles')
    .select('id, user_id, plays_cursor_after_ms');
  if (error) throw error;

  console.log(`[sync] found ${profiles?.length ?? 0} profile(s)`);
  for (const profile of profiles ?? []) {
    try {
      await syncProfile(supabase, env, profile);
    } catch (err) {
      if (err instanceof SpotifyRateLimitError) {
        console.warn(
          `[sync] profile ${profile.id} rate limited, skipping this cycle (retry after ${err.retryAfterSeconds}s)`,
        );
        continue;
      }
      console.error(`[sync] profile ${profile.id} failed:`, err);
    }
  }
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
