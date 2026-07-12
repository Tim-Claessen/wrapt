// Spotify Authorization Code + PKCE flow and server-side token refresh — tokens never touch the client (see CLAUDE.md).

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';

// Read scopes: user-read-recently-played (the sync cron's play log) and playlist-read-private (the
// user's own playlists). Plus exactly one write scope, playlist-modify-private, used only to create a
// private playlist when the user taps "Save to Spotify" on a generated playlist (src/lib/playlist.ts)
// — never to modify an existing playlist, follow/unfollow, or post publicly. Do not add
// playlist-modify-public; that's a different privacy posture and out of scope (see CLAUDE.md).
export const SPOTIFY_SCOPES = ['user-read-recently-played', 'playlist-read-private', 'playlist-modify-private'];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SpotifyRateLimitError extends Error {
  constructor(public retryAfterSeconds: number) {
    super(`Spotify rate limited; retry after ${retryAfterSeconds}s`);
    this.name = 'SpotifyRateLimitError';
  }
}

// Thrown specifically when Spotify rejects a refresh-token grant with `invalid_grant` — the
// refresh token was revoked (user disconnected the app, changed password, etc.) or has expired.
// Distinct from a generic token-request failure so callers can send the user through /connect
// again instead of surfacing a raw error.
export class SpotifyTokenExpiredError extends Error {
  constructor() {
    super('Spotify refresh token is invalid or revoked; user must reconnect');
    this.name = 'SpotifyTokenExpiredError';
  }
}

// Every Spotify call — token or Web API — funnels through here so 429/Retry-After handling (C10)
// is enforced once, not re-implemented at each call site. Retries inline (bounded) since Spotify's
// dev-mode rate limits are a short rolling window; if still limited after that, surfaces the wait
// time so the caller can skip this cycle rather than block indefinitely.
async function spotifyRequest(url: string, init: RequestInit, maxRetries = 2): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    if (response.status !== 429) return response;
    const retryAfterSeconds = Number(response.headers.get('Retry-After') ?? '1') || 1;
    if (attempt >= maxRetries) throw new SpotifyRateLimitError(retryAfterSeconds);
    await sleep(retryAfterSeconds * 1000);
  }
}

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
  const response = await spotifyRequest(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    const bodyText = await response.text();
    // invalid_grant: the refresh token was revoked/expired, or (during the initial code exchange)
    // the auth code itself was stale — either way the fix is the same, send the user through
    // /connect again rather than surfacing a raw error.
    if (response.status === 400 && bodyText.includes('invalid_grant')) {
      throw new SpotifyTokenExpiredError();
    }
    throw new Error(`Spotify token request failed: ${response.status} ${bodyText}`);
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

function authGet(path: string, accessToken: string): Promise<Response> {
  return spotifyRequest(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
}

function authPost(path: string, accessToken: string, body: unknown): Promise<Response> {
  return spotifyRequest(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function getSpotifyProfile(accessToken: string): Promise<SpotifyProfile> {
  const response = await authGet('/me', accessToken);
  if (!response.ok) {
    throw new Error(`Spotify profile request failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export interface SpotifyTrack {
  id: string;
  name: string;
  duration_ms: number;
  artists: { id: string; name: string }[];
  album: { images: { url: string }[] };
}

export interface SpotifyArtist {
  id: string;
  name: string;
  genres: string[];
  images: { url: string }[];
}

export interface SpotifyRecentlyPlayedItem {
  played_at: string;
  track: SpotifyTrack;
}

export interface SpotifyRecentlyPlayedResponse {
  items: SpotifyRecentlyPlayedItem[];
  cursors: { after?: string; before?: string } | null;
}

// The endpoint only ever holds the last 50 plays total, regardless of `after` — it just narrows
// the response server-side so we don't re-walk items we've already ingested.
export async function getRecentlyPlayed(
  accessToken: string,
  afterMs?: number | null,
): Promise<SpotifyRecentlyPlayedResponse> {
  const query = new URLSearchParams({ limit: '50' });
  if (afterMs) query.set('after', String(afterMs));
  const response = await authGet(`/me/player/recently-played?${query}`, accessToken);
  if (!response.ok) {
    throw new Error(`Spotify recently-played request failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

// No batch artist endpoint (C6) — every genre lookup is one request, cached in artists_cache.
export async function getArtist(accessToken: string, artistId: string): Promise<SpotifyArtist> {
  const response = await authGet(`/artists/${artistId}`, accessToken);
  if (!response.ok) {
    throw new Error(`Spotify artist request failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export class SpotifyTrackNotFoundError extends Error {
  constructor(public trackId: string) {
    super(`Spotify track ${trackId} not found`);
    this.name = 'SpotifyTrackNotFoundError';
  }
}

// No batch track endpoint (C6) — one request per track, used to backfill artist ids/album art/true
// duration for imported history rows (the streaming-history export has none of those). A 404 means
// the track is gone/region-locked, not a transient failure, so the caller should stop retrying it
// rather than leaving it pending forever.
export async function getTrack(accessToken: string, trackId: string): Promise<SpotifyTrack> {
  const response = await authGet(`/tracks/${trackId}`, accessToken);
  if (response.status === 404) throw new SpotifyTrackNotFoundError(trackId);
  if (!response.ok) {
    throw new Error(`Spotify track request failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

// Search (C5: capped at 10 results/request) — used by the Playlist pipeline (src/lib/playlist.ts) to
// resolve model-suggested (artist, title) pairs to real tracks. Field filters (track:/artist:) narrow
// the search server-side; the caller still verifies the match itself before trusting a result.
export async function searchTracks(
  accessToken: string,
  artist: string,
  title: string,
  limit = 5,
): Promise<SpotifyTrack[]> {
  const q = `track:${JSON.stringify(title)} artist:${JSON.stringify(artist)}`;
  const query = new URLSearchParams({ q, type: 'track', limit: String(limit) });
  const response = await authGet(`/search?${query}`, accessToken);
  if (!response.ok) {
    throw new Error(`Spotify search request failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { tracks?: { items?: SpotifyTrack[] } };
  return body.tracks?.items ?? [];
}

// Thrown when Spotify rejects a playlist write with 403 — almost always a stored token minted before
// playlist-modify-private was added to SPOTIFY_SCOPES. Callers should prompt a reconnect, not retry.
export class SpotifyScopeError extends Error {
  constructor() {
    super('Spotify rejected the write — the stored token is missing a required scope');
    this.name = 'SpotifyScopeError';
  }
}

export interface SpotifyPlaylist {
  id: string;
  external_urls: { spotify: string };
}

// Playlist write endpoints, post-Feb-2026 names (C9): playlist creation moved from
// POST /users/{user_id}/playlists to POST /me/playlists (owner inferred from the token, no user id
// needed), and item mutation moved from .../tracks to .../items. Build against these, not the old
// names — see the Spotify API constraints register in CLAUDE.md.
export async function createPlaylist(
  accessToken: string,
  name: string,
  description: string,
): Promise<SpotifyPlaylist> {
  const response = await authPost('/me/playlists', accessToken, { name, description, public: false });
  if (response.status === 403) throw new SpotifyScopeError();
  if (!response.ok) {
    throw new Error(`Spotify create-playlist request failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export async function addTracksToPlaylistItems(
  accessToken: string,
  playlistId: string,
  trackUris: string[],
): Promise<void> {
  const response = await authPost(`/playlists/${playlistId}/items`, accessToken, { uris: trackUris });
  if (response.status === 403) throw new SpotifyScopeError();
  if (!response.ok) {
    throw new Error(`Spotify add-items request failed: ${response.status} ${await response.text()}`);
  }
}
