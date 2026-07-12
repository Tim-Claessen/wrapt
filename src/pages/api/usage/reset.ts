import type { APIRoute } from 'astro';
import { createSupabaseServerClient, createSupabaseServiceClient } from '../../../lib/supabase';
import { resetAskUsage } from '../../../lib/ask';
import { resetPlaylistUsage } from '../../../lib/playlist';

// Self-serve escape hatch on /settings: zero today's Ask and/or Playlist usage for the caller's own
// profile, rather than waiting for the AWST-midnight reset. Always scoped to the signed-in user's
// own profile_id (never a body-supplied one) — this is a household convenience, not an admin tool.
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
    body = {};
  }
  const kind = (body as { kind?: unknown })?.kind;

  try {
    if (kind === 'ask') {
      await resetAskUsage(service, profileId);
    } else if (kind === 'playlist') {
      await resetPlaylistUsage(service, profileId);
    } else {
      await Promise.all([resetAskUsage(service, profileId), resetPlaylistUsage(service, profileId)]);
    }
    return json({ ok: true });
  } catch (err) {
    console.error('usage reset failed', err);
    return json({ error: 'reset_failed' }, 500);
  }
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
