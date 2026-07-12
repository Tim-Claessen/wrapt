import type { APIRoute } from 'astro';
import { createSupabaseServerClient, createSupabaseServiceClient } from '../../../lib/supabase';
import { searchArtists } from '../../../lib/artist';

// Backs the live-filter dropdown on /artist — same artist_search RPC the full-page fallback uses,
// just returned as JSON for the as-you-type enhancement instead of a server-rendered pick-list.
export const GET: APIRoute = async ({ request, cookies, locals, url }) => {
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

  const q = (url.searchParams.get('q') ?? '').trim();
  if (q.length < 2) {
    return new Response(JSON.stringify({ matches: [] }), { headers: { 'Content-Type': 'application/json' } });
  }

  const matches = await searchArtists(service, profile.id, q, 8);
  return new Response(JSON.stringify({ matches }), { headers: { 'Content-Type': 'application/json' } });
};
