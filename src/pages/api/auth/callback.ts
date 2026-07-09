import type { APIRoute } from 'astro';
import { createSupabaseServerClient, createSupabaseServiceClient } from '../../../lib/supabase';
import { encryptToken } from '../../../lib/crypto';
import { exchangeCodeForTokens, getSpotifyProfile, SPOTIFY_SCOPES, SpotifyTokenExpiredError } from '../../../lib/spotify';

// Spotify's redirect target: exchanges the auth code for tokens, encrypts the refresh token,
// and stores the profile. Spotify tokens never reach the client (see CLAUDE.md).
export const GET: APIRoute = async ({ request, cookies, redirect, locals }) => {
  const env = locals.runtime.env;
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  const expectedState = cookies.get('spotify_oauth_state')?.value;
  const codeVerifier = cookies.get('spotify_pkce_verifier')?.value;
  cookies.delete('spotify_oauth_state', { path: '/' });
  cookies.delete('spotify_pkce_verifier', { path: '/' });

  if (error || !code || !state || !codeVerifier || state !== expectedState) {
    return redirect('/connect?error=spotify_auth_failed');
  }

  const supabase = createSupabaseServerClient(request, cookies, env);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirect('/login');

  let tokens: Awaited<ReturnType<typeof exchangeCodeForTokens>>;
  try {
    tokens = await exchangeCodeForTokens({
      clientId: env.SPOTIFY_CLIENT_ID,
      redirectUri: env.SPOTIFY_REDIRECT_URI,
      code,
      codeVerifier,
    });
  } catch (err) {
    if (err instanceof SpotifyTokenExpiredError) {
      return redirect('/connect?error=spotify_auth_failed');
    }
    throw err;
  }

  const spotifyProfile = await getSpotifyProfile(tokens.access_token);
  const refreshTokenEnc = await encryptToken(tokens.refresh_token!, env.TOKEN_ENC_KEY);

  const service = createSupabaseServiceClient(env);
  const { error: upsertError } = await service.from('spotify_profiles').upsert(
    {
      user_id: user.id,
      spotify_user_id: spotifyProfile.id,
      display_name: spotifyProfile.display_name,
      refresh_token_enc: refreshTokenEnc,
      scopes: SPOTIFY_SCOPES,
      connected_at: new Date().toISOString(),
      last_synced_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (upsertError) throw upsertError;

  return redirect('/');
};
