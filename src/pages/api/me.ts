import type { APIRoute } from 'astro';
import { createSupabaseServerClient } from '../../lib/supabase';
import { getValidSpotifyAccessToken } from '../../lib/tokens';
import { getSpotifyProfile } from '../../lib/spotify';

// Smoke endpoint: proves the full round trip — session → stored refresh token → live Spotify call.
export const GET: APIRoute = async ({ request, cookies, locals }) => {
  const env = locals.runtime.env;
  const supabase = createSupabaseServerClient(request, cookies, env);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 });

  const tokenInfo = await getValidSpotifyAccessToken(user.id, env);
  if (!tokenInfo) return new Response(JSON.stringify({ connected: false }), { status: 404 });

  const profile = await getSpotifyProfile(tokenInfo.accessToken);
  return new Response(
    JSON.stringify({ connected: true, spotifyUserId: profile.id, displayName: profile.display_name }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
