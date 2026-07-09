import type { AstroGlobal } from 'astro';
import type { User } from '@supabase/supabase-js';
import { createSupabaseServerClient, createSupabaseServiceClient } from './supabase';

type ServerClient = ReturnType<typeof createSupabaseServerClient>;
type ServiceClient = ReturnType<typeof createSupabaseServiceClient>;

export interface RequireUserResult {
  user: User;
  supabase: ServerClient;
}

// Session gate shared by every authed page: server client → getUser() → redirect /login if none.
// Returns the resolved context, or a redirect Response the page must return as-is.
export async function requireUser(astro: AstroGlobal): Promise<RequireUserResult | Response> {
  const supabase = createSupabaseServerClient(astro.request, astro.cookies, astro.locals.runtime.env);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return astro.redirect('/login');
  return { user, supabase };
}

export interface RequireProfileResult<TProfile> extends RequireUserResult {
  profile: TProfile;
  service: ServiceClient;
}

// The full auth + Spotify-connection gate: requireUser, then load the user's spotify_profiles row
// (RLS-scoped to their own row), redirecting to /connect if they haven't linked Spotify. `columns`
// is the select list, so each page fetches only what it needs. Also hands back a service-role client
// for the page's own (RLS-bypassing) data reads. Returns the context or a redirect Response.
export async function requireProfile<TProfile = Record<string, any>>(
  astro: AstroGlobal,
  columns: string,
): Promise<RequireProfileResult<TProfile> | Response> {
  const gate = await requireUser(astro);
  if (gate instanceof Response) return gate;
  const { user, supabase } = gate;

  const { data: profile } = await supabase
    .from('spotify_profiles')
    .select(columns)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!profile) return astro.redirect('/connect');

  const service = createSupabaseServiceClient(astro.locals.runtime.env);
  return { user, profile: profile as TProfile, supabase, service };
}
