import type { APIRoute } from 'astro';
import { createSupabaseServerClient, createSupabaseServiceClient } from '../../../lib/supabase';
import { getValidSpotifyAccessToken } from '../../../lib/tokens';
import { createPlaylist, addTracksToPlaylistItems, SpotifyScopeError, SpotifyTokenExpiredError } from '../../../lib/spotify';

const TRACK_URI = /^spotify:track:[A-Za-z0-9]+$/;
const MAX_TRACKS = 100; // Spotify's own add-items cap in one call; our playlists are ~20 anyway

// Save a previously-generated playlist to the user's Spotify account as a private playlist. User-
// initiated only (a button tap), never automatic. Uncapped — the daily limit is on generation, not
// saving. Needs playlist-modify-private; a token minted before that scope existed gets a 403 from
// Spotify, which we surface as scope_missing so the UI can prompt a reconnect instead of erroring.
export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const env = locals.runtime.env;
  const supabase = createSupabaseServerClient(request, cookies, env);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: 'unauthenticated' }, 401);

  const service = createSupabaseServiceClient(env);
  const { data: profile } = await service
    .from('spotify_profiles')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!profile) return json({ error: 'no_spotify_profile' }, 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const name = (body as { name?: unknown })?.name;
  const description = (body as { description?: unknown })?.description;
  const trackUris = (body as { trackUris?: unknown })?.trackUris;
  if (typeof name !== 'string' || !name.trim()) return json({ error: 'invalid_name' }, 400);
  if (typeof description !== 'string') return json({ error: 'invalid_description' }, 400);
  if (!Array.isArray(trackUris) || trackUris.length === 0 || trackUris.length > MAX_TRACKS) {
    return json({ error: 'invalid_tracks' }, 400);
  }
  if (!trackUris.every((uri) => typeof uri === 'string' && TRACK_URI.test(uri))) {
    return json({ error: 'invalid_tracks' }, 400);
  }

  let token: Awaited<ReturnType<typeof getValidSpotifyAccessToken>>;
  try {
    token = await getValidSpotifyAccessToken(user.id, env);
  } catch (err) {
    if (err instanceof SpotifyTokenExpiredError) return json({ error: 'reconnect_required' });
    throw err;
  }
  if (!token) return json({ error: 'no_spotify_profile' }, 404);

  try {
    const playlist = await createPlaylist(token.accessToken, name.trim().slice(0, 100), description.trim().slice(0, 300));
    await addTracksToPlaylistItems(token.accessToken, playlist.id, trackUris as string[]);
    return json({ ok: true, url: playlist.external_urls.spotify });
  } catch (err) {
    if (err instanceof SpotifyScopeError) return json({ error: 'scope_missing' });
    console.error('playlist save failed', err);
    return json({ error: 'save_failed', message: "Couldn't save that playlist — try again in a moment." }, 500);
  }
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
