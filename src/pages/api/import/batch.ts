import type { APIRoute } from 'astro';
import { createSupabaseServerClient, createSupabaseServiceClient } from '../../../lib/supabase';
import { ingestImportBatch, type RawImportEntry } from '../../../lib/import';

const MAX_ROWS_PER_BATCH = 1000; // mirrors the client's own batch size — rejects a buggy/hostile client rather than trusting it.

export const POST: APIRoute = async ({ request, cookies, locals }) => {
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

  let body: { rows?: RawImportEntry[] };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 });
  }

  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return new Response(JSON.stringify({ error: 'rows_required' }), { status: 400 });
  }
  if (rows.length > MAX_ROWS_PER_BATCH) {
    return new Response(JSON.stringify({ error: 'batch_too_large' }), { status: 400 });
  }

  const result = await ingestImportBatch(service, profile.id, rows);
  return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
};
