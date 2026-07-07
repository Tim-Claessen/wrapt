import type { APIRoute } from 'astro';
import { createSupabaseServerClient } from '../../../lib/supabase';

// Supabase magic-link redirect target: exchanges the PKCE `code` for a session and sets session cookies.
export const GET: APIRoute = async ({ request, cookies, redirect, locals }) => {
  const code = new URL(request.url).searchParams.get('code');
  if (!code) return redirect('/login');

  const supabase = createSupabaseServerClient(request, cookies, locals.runtime.env);
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return redirect('/login');

  return redirect('/connect');
};
