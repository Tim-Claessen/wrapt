// Spotify Authorization Code + PKCE flow (SDD §4.1) and server-side token refresh (SDD §2 — tokens never touch the client).

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

// Read-only scopes only — no playlist-modify-* (CLAUDE.md privacy commitment: "we only read what you play, never post").
// SDD §4.1 lists modify scopes for the Mark 2 AI-playlist push, deferred until that feature is actually built.
export const SPOTIFY_SCOPES = ['user-top-read', 'user-read-recently-played', 'playlist-read-private'];

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  url.searchParams.set('scope', SPOTIFY_SCOPES.join(' '));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', params.codeChallenge);
  return url.toString();
}

interface SpotifyTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  refresh_token?: string;
}

async function postToken(body: URLSearchParams): Promise<SpotifyTokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(`Spotify token request failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export function exchangeCodeForTokens(params: {
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<SpotifyTokenResponse> {
  return postToken(
    new URLSearchParams({
      client_id: params.clientId,
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    }),
  );
}

export function refreshAccessToken(params: {
  clientId: string;
  refreshToken: string;
}): Promise<SpotifyTokenResponse> {
  return postToken(
    new URLSearchParams({
      client_id: params.clientId,
      grant_type: 'refresh_token',
      refresh_token: params.refreshToken,
    }),
  );
}

export interface SpotifyProfile {
  id: string;
  display_name: string | null;
}

export async function getSpotifyProfile(accessToken: string): Promise<SpotifyProfile> {
  const response = await fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Spotify profile request failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}
