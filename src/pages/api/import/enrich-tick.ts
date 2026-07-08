import type { APIRoute } from 'astro';
import { createSupabaseServerClient, createSupabaseServiceClient } from '../../../lib/supabase';
import { getValidSpotifyAccessToken } from '../../../lib/tokens';
import { enrichNextBatch } from '../../../lib/import';
import { SpotifyTokenExpiredError } from '../../../lib/spotify';

const TICK_BATCH_SIZE = 25; // small on purpose — this runs in the foreground while a tab is open.

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const env = locals.runtime.env;
  const supabase = createSupabaseServerClient(request, cookies, env);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 });

  const service = createSupabaseServiceClient(env);
  const { data: profile } = await service
    .from('spotify_profiles')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!profile) return new Response(JSON.stringify({ error: 'no_spotify_profile' }), { status: 404 });

  let tokenInfo: Awaited<ReturnType<typeof getValidSpotifyAccessToken>>;
  try {
    tokenInfo = await getValidSpotifyAccessToken(user.id, env);
  } catch (err) {
    if (err instanceof SpotifyTokenExpiredError) {
      return new Response(JSON.stringify({ error: 'spotify_reconnect_required' }), { status: 409 });
    }
    throw err;
  }
  if (!tokenInfo) return new Response(JSON.stringify({ error: 'not_connected' }), { status: 404 });

  const result = await enrichNextBatch(service, tokenInfo.accessToken, profile.id, TICK_BATCH_SIZE);
  return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
};
