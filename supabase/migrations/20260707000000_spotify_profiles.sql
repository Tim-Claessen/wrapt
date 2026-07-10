-- spotify_profiles: one row per authorised user's Spotify connection (see CLAUDE.md).
create table if not exists public.spotify_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  spotify_user_id text not null unique,
  display_name text,
  refresh_token_enc text not null,
  scopes text[] not null default '{}',
  connected_at timestamptz not null default now(),
  last_synced_at timestamptz
);

alter table public.spotify_profiles enable row level security;

-- A user may see their own connection status (but not the token — see column grants below).
create policy "spotify_profiles_select_own"
  on public.spotify_profiles
  for select
  to authenticated
  using (auth.uid() = user_id);

-- No insert/update/delete policies for authenticated/anon: writes happen exclusively via
-- Pages Functions using the service-role key, which bypasses RLS entirely.

-- Column-level lockdown: refresh_token_enc is never selectable via anon/authenticated,
-- even for a user's own row — only the server-side service role can read it.
revoke all on public.spotify_profiles from anon, authenticated;
grant select (id, user_id, spotify_user_id, display_name, scopes, connected_at, last_synced_at)
  on public.spotify_profiles to authenticated;
