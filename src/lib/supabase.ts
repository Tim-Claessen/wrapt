import { createServerClient, type CookieOptionsWithName } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import type { AstroCookies } from 'astro';

const cookieOptions: CookieOptionsWithName = {
  path: '/',
  sameSite: 'lax',
  httpOnly: true,
  secure: true,
  maxAge: 60 * 60 * 24 * 365,
};

function parseCookieHeader(header: string | null): { name: string; value: string }[] {
  if (!header) return [];
  return header
    .split(';')
    .map((pair) => {
      const separatorIndex = pair.indexOf('=');
      if (separatorIndex === -1) return null;
      const name = pair.slice(0, separatorIndex).trim();
      const value = pair.slice(separatorIndex + 1).trim();
      return name ? { name, value: decodeURIComponent(value) } : null;
    })
    .filter((c): c is { name: string; value: string } => c !== null);
}

// Bound to the incoming request's cookies — reads/writes the user's session, RLS-scoped via the anon key.
export function createSupabaseServerClient(
  request: Request,
  cookies: AstroCookies,
  env: Pick<Env, 'PUBLIC_SUPABASE_URL' | 'PUBLIC_SUPABASE_ANON_KEY'>,
) {
  return createServerClient(env.PUBLIC_SUPABASE_URL, env.PUBLIC_SUPABASE_ANON_KEY, {
    cookieOptions,
    cookies: {
      getAll: () => parseCookieHeader(request.headers.get('cookie')),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value, options }) => {
          cookies.set(name, value, { ...cookieOptions, ...options });
        });
      },
    },
  });
}

// Service-role client — bypasses RLS. Server-only; must never be reachable from client-side code.
export function createSupabaseServiceClient(env: Pick<Env, 'PUBLIC_SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'>) {
  return createClient(env.PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
