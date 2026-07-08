-- artists_cache: shared cache of Spotify artist metadata (genres, image), keyed by Spotify artist id.
-- Genres only come from the single-artist endpoint (no batch endpoint, C6), so every lookup is fetched
-- one-by-one and cached aggressively here; refreshed lazily (see fetched_at) rather than on a schedule.
create table if not exists public.artists_cache (
  id text primary key,
  name text not null,
  genres text[] not null default '{}',
  image text,
  fetched_at timestamptz not null default now()
);

create index if not exists artists_cache_genres_idx on public.artists_cache using gin (genres);

alter table public.artists_cache enable row level security;

-- Not user-scoped data (public artist metadata) — readable by any authenticated user.
create policy "artists_cache_select_all"
  on public.artists_cache
  for select
  to authenticated
  using (true);

-- Writes are service-role only (the sync cron populates this as it encounters new artists).
revoke all on public.artists_cache from anon, authenticated;
grant select on public.artists_cache to authenticated;
