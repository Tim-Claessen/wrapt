-- plays: durable log of every track played, captured incrementally by the sync cron (2-hourly)
-- so listening history accrues from day one instead of waiting on weekly snapshots.
create table if not exists public.plays (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.spotify_profiles (id) on delete cascade,
  played_at timestamptz not null,
  track_id text not null,
  track_name text not null,
  artist_ids text[] not null default '{}',
  artist_names text[] not null default '{}',
  album_image text,
  duration_ms integer,
  source text not null default 'live' check (source in ('live', 'import')),
  created_at timestamptz not null default now(),
  unique (profile_id, played_at)
);

create index if not exists plays_profile_played_at_idx on public.plays (profile_id, played_at desc);
create index if not exists plays_track_id_idx on public.plays (track_id);
create index if not exists plays_artist_ids_idx on public.plays using gin (artist_ids);

alter table public.plays enable row level security;

-- A user may read their own plays (via their spotify_profiles row); writes are service-role only.
create policy "plays_select_own"
  on public.plays
  for select
  to authenticated
  using (
    exists (
      select 1 from public.spotify_profiles p
      where p.id = plays.profile_id and p.user_id = auth.uid()
    )
  );

-- No insert/update/delete policies for authenticated/anon: the sync cron and any on-visit
-- sync write exclusively via the service-role client, bypassing RLS.
revoke all on public.plays from anon, authenticated;
grant select on public.plays to authenticated;

-- Cursor for the recently-played sync: the latest played_at (ms since epoch) we've successfully
-- ingested for this profile, passed back to Spotify as the `after` query param. Null = never synced.
alter table public.spotify_profiles
  add column if not exists plays_cursor_after_ms bigint;
