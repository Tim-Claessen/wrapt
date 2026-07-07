import type { APIRoute } from 'astro';
import { createSupabaseServerClient } from '../../../lib/supabase';
import { generateCodeChallenge, generateCodeVerifier, generateState } from '../../../lib/pkce';
import { buildAuthorizeUrl } from '../../../lib/spotify';

const PKCE_COOKIE_MAX_AGE = 60 * 10; // 10 minutes — the round trip through Spotify's consent screen.

// Starts the Spotify Authorization Code + PKCE flow. Requires an active Supabase session.
export const GET: APIRoute = async ({ request, cookies, redirect, locals }) => {
  const env = locals.runtime.env;
  const supabase = createSupabaseServerClient(request, cookies, env);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirect('/login');

  const codeVerifier = generateCodeVerifier();
  const state = generateState();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const cookieOptions = {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    maxAge: PKCE_COOKIE_MAX_AGE,
  };
  cookies.set('spotify_pkce_verifier', codeVerifier, cookieOptions);
  cookies.set('spotify_oauth_state', state, cookieOptions);

  const authorizeUrl = buildAuthorizeUrl({
    clientId: env.SPOTIFY_CLIENT_ID,
    redirectUri: env.SPOTIFY_REDIRECT_URI,
    state,
    codeChallenge,
  });

  return redirect(authorizeUrl);
};
