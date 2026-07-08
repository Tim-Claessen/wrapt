-- import_track_enrichment: tracks which Spotify track ids still need a /v1/tracks/{id} lookup to
-- backfill artist_ids/artist_names/album_image/duration_ms on imported `plays` rows (the Extended
-- Streaming History export has none of those — only a track uri, name, and a single artist name
-- string). Global/shared, not profile-scoped, like `artists_cache` — a track resolved for one
-- profile's import is resolved for every profile, and many `plays` rows share one track_id, so the
-- unit of lookup work is per-track, not per-row.
create table if not exists public.import_track_enrichment (
  track_id text primary key,
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  attempts int not null default 0,
  last_error text,
  updated_at timestamptz not null default now()
);

create index if not exists import_track_enrichment_status_idx
  on public.import_track_enrichment (status, updated_at);

alter table public.import_track_enrichment enable row level security;

-- Not sensitive (Spotify track ids + a status string) — same reasoning as artists_cache_select_all.
create policy "import_track_enrichment_select_all"
  on public.import_track_enrichment
  for select
  to authenticated
  using (true);

-- Writes are service-role only: the import batch endpoint registers new tracks, the enrichment
-- tick/cron resolve them.
revoke all on public.import_track_enrichment from anon, authenticated;
grant select on public.import_track_enrichment to authenticated;

-- Backs "which of this profile's imported tracks are still unresolved" without scanning every row.
create index if not exists plays_import_track_idx
  on public.plays (profile_id, track_id)
  where source = 'import';

-- Registers newly-ingested track ids as pending lookups. Conflict-safe so re-importing an
-- overlapping file never resets an already-done/failed track back to pending.
create or replace function public.import_register_tracks(p_track_ids text[])
returns void
language sql
as $$
  insert into public.import_track_enrichment (track_id)
  select unnest(p_track_ids)
  on conflict (track_id) do nothing;
$$;

-- Pending track ids for one profile's imported plays, heaviest-rotation first so the tracks that
-- matter most to that person's rankings resolve before rarely-played ones.
create or replace function public.import_pending_for_profile(p_profile_id uuid, p_limit int default 25)
returns table (track_id text, play_count bigint)
language sql
stable
as $$
  select pl.track_id, count(*) as play_count
  from public.plays pl
  join public.import_track_enrichment ite on ite.track_id = pl.track_id
  where pl.profile_id = p_profile_id
    and pl.source = 'import'
    and ite.status = 'pending'
  group by pl.track_id
  order by play_count desc
  limit p_limit;
$$;

-- Enrichment progress for one profile's imported tracks, for the /import page's progress bar and
-- the dashboard callout. Coalesces to 'pending' for the brief window between a batch insert and its
-- import_register_tracks call.
create or replace function public.import_progress(p_profile_id uuid)
returns table (total bigint, done bigint, failed bigint, pending bigint)
language sql
stable
as $$
  with imported as (
    select distinct track_id
    from public.plays
    where profile_id = p_profile_id and source = 'import'
  )
  select
    count(*) as total,
    count(*) filter (where coalesce(ite.status, 'pending') = 'done') as done,
    count(*) filter (where coalesce(ite.status, 'pending') = 'failed') as failed,
    count(*) filter (where coalesce(ite.status, 'pending') = 'pending') as pending
  from imported i
  left join public.import_track_enrichment ite on ite.track_id = i.track_id;
$$;

-- Applies a resolved track's metadata to every plays row still carrying the import placeholder
-- (empty artist_ids), across every profile that has it — not profile-scoped, mirroring the shared
-- nature of the enrichment queue itself.
create or replace function public.enrich_apply_track_metadata(
  p_track_id text,
  p_artist_ids text[],
  p_artist_names text[],
  p_album_image text,
  p_duration_ms int
)
returns void
language plpgsql
as $$
begin
  update public.plays
  set artist_ids = p_artist_ids,
      artist_names = p_artist_names,
      album_image = p_album_image,
      duration_ms = p_duration_ms
  where track_id = p_track_id
    and artist_ids = '{}';

  update public.import_track_enrichment
  set status = 'done', updated_at = now()
  where track_id = p_track_id;
end;
$$;

-- Records a failed lookup attempt. Caps at 3 attempts so a permanently-gone (delisted/region-locked)
-- track stops being retried forever; below the cap it stays 'pending' for a later tick/cron pass.
create or replace function public.mark_track_enrichment_failed(p_track_id text, p_error text)
returns void
language plpgsql
as $$
begin
  update public.import_track_enrichment
  set attempts = attempts + 1,
      status = case when attempts + 1 >= 3 then 'failed' else 'pending' end,
      last_error = p_error,
      updated_at = now()
  where track_id = p_track_id;
end;
$$;

-- These run only via the service-role client (server-side, after the caller's session is already
-- verified — see src/lib/import.ts), same trust boundary as leaderboard_functions.sql.
grant execute on function public.import_register_tracks to service_role;
grant execute on function public.import_pending_for_profile to service_role;
grant execute on function public.import_progress to service_role;
grant execute on function public.enrich_apply_track_metadata to service_role;
grant execute on function public.mark_track_enrichment_failed to service_role;
