import type { APIRoute } from 'astro';
import { createSupabaseServerClient, createSupabaseServiceClient } from '../../../lib/supabase';
import { createWorkersAiProvider } from '../../../lib/llm';
import { getValidSpotifyAccessToken } from '../../../lib/tokens';
import { SpotifyTokenExpiredError } from '../../../lib/spotify';
import { PLAYLIST_DAILY_LIMIT, bumpPlaylistUsage, generatePlaylist, type FamiliarityDial } from '../../../lib/playlist';

const MAX_BRIEF_LEN = 200;
const DIALS: FamiliarityDial[] = ['my_music', 'mix', 'discovery'];
const CAP_MESSAGE = "That's today's 10 playlists — back tomorrow. 🌙";

// Generate (but do not save) a playlist from a free-text brief + familiarity dial. Same auth/usage
// pattern as api/ask.ts: verify the session, resolve the caller's profile, charge the daily cap before
// doing the paid work. Generation only needs a valid Spotify token for search — it works on tokens
// minted before playlist-modify-private existed; only /api/playlist/save needs the new scope.
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
  const profileId = (profile as { id: string }).id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const brief = (body as { brief?: unknown })?.brief;
  const dial = (body as { dial?: unknown })?.dial;
  if (typeof brief !== 'string' || brief.trim().length === 0) {
    return json({ error: 'empty_brief' }, 400);
  }
  if (brief.length > MAX_BRIEF_LEN) {
    return json({ error: 'brief_too_long' }, 400);
  }
  if (typeof dial !== 'string' || !DIALS.includes(dial as FamiliarityDial)) {
    return json({ error: 'invalid_dial' }, 400);
  }

  // Charge the request against today's cap before doing any work; a blocked request isn't charged.
  // Fails open (same posture as bumpAskUsage) so the feature still works if ai_usage isn't pasted yet.
  let usage;
  try {
    usage = await bumpPlaylistUsage(service, profileId);
  } catch (err) {
    console.error('playlist usage check failed (ai_usage migration not applied?)', err);
    usage = { allowed: true, used: 0, remaining: PLAYLIST_DAILY_LIMIT };
  }
  if (!usage.allowed) {
    return json({ capped: true, remaining: 0, message: CAP_MESSAGE });
  }

  let token: Awaited<ReturnType<typeof getValidSpotifyAccessToken>>;
  try {
    token = await getValidSpotifyAccessToken(user.id, env);
  } catch (err) {
    if (err instanceof SpotifyTokenExpiredError) {
      return json({ error: 'reconnect_required' }, 200);
    }
    throw err;
  }
  if (!token) return json({ error: 'no_spotify_profile' }, 404);

  try {
    const llm = createWorkersAiProvider(env.AI);
    const result = await generatePlaylist({
      llm,
      service,
      profileId,
      accessToken: token.accessToken,
      brief: brief.trim(),
      dial: dial as FamiliarityDial,
    });
    if (!result.ok) return json({ ok: false, message: result.message, remaining: usage.remaining });
    return json({
      ok: true,
      name: result.name,
      description: result.description,
      tracks: result.tracks,
      recencyCaveat: result.recencyCaveat,
      remaining: usage.remaining,
    });
  } catch (err) {
    console.error('playlist generation failed', err);
    return json({ error: 'generate_failed', message: 'Something went wrong on my end — try that again in a moment.' }, 500);
  }
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
