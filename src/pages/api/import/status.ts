import type { APIRoute } from 'astro';
import { createSupabaseServerClient, createSupabaseServiceClient } from '../../../lib/supabase';
import { getImportProgress } from '../../../lib/import';
import { getPlaysHistorySince } from '../../../lib/leaderboard';

export const GET: APIRoute = async ({ request, cookies, locals }) => {
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

  const [{ count: importedPlays }, historySince, enrichment] = await Promise.all([
    service.from('plays').select('id', { count: 'exact', head: true }).eq('profile_id', profile.id).eq('source', 'import'),
    getPlaysHistorySince(service, profile.id),
    getImportProgress(service, profile.id),
  ]);

  return new Response(
    JSON.stringify({
      importedPlays: importedPlays ?? 0,
      historySince,
      enrichment,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
