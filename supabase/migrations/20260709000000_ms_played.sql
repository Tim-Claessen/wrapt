-- ms_played: the actual milliseconds listened for a play. The Extended Streaming History export
-- records this per row; the live /recently-played endpoint does not (it only tells us a track was
-- played at all). So imported rows carry their true listened-time from day one, while live rows
-- leave it null and fall back to the track's full duration_ms for "minutes listened".
--
-- Why this matters: before this, imported plays stored duration_ms = null until per-track
-- enrichment backfilled it — meaning years of imported history contributed *zero* minutes to the
-- headline "Minutes listened" stat until a slow, one-request-per-track backfill finished. ms_played
-- is already in the export we ingest, so minutes become real the instant history lands, no Spotify
-- calls required. (It's also strictly more accurate than the live path, which approximates with the
-- track's full length regardless of how much was actually played.)
alter table public.plays add column if not exists ms_played integer;

-- Recreate the two stats functions that total listening time so they prefer the real ms_played and
-- only fall back to duration_ms (live rows, or not-yet-set) — everything else is unchanged from
-- 20260708000004_listening_stats.sql.
create or replace function public.listening_summary(
  p_profile_id uuid,
  p_since timestamptz,
  p_until timestamptz
)
returns table (
  total_ms bigint,
  total_plays bigint,
  distinct_tracks bigint,
  distinct_artists bigint,
  active_days bigint
)
language sql
stable
as $$
  with scoped as (
    select *
    from public.plays
    where profile_id = p_profile_id
      and played_at >= p_since
      and played_at < p_until
  )
  select
    coalesce(sum(coalesce(ms_played, duration_ms, 0)), 0)::bigint as total_ms,
    count(*)::bigint as total_plays,
    count(distinct track_id)::bigint as distinct_tracks,
    (select count(distinct aid) from scoped, unnest(artist_ids) as aid)::bigint as distinct_artists,
    count(distinct date_trunc('day', played_at))::bigint as active_days
  from scoped;
$$;

create or replace function public.listening_trend(
  p_profile_id uuid,
  p_since timestamptz,
  p_until timestamptz,
  p_bucket text default 'day'
)
returns table (
  bucket_start timestamptz,
  play_count bigint,
  total_ms bigint
)
language sql
stable
as $$
  select
    date_trunc(p_bucket, played_at) as bucket_start,
    count(*)::bigint as play_count,
    coalesce(sum(coalesce(ms_played, duration_ms, 0)), 0)::bigint as total_ms
  from public.plays
  where profile_id = p_profile_id
    and played_at >= p_since
    and played_at < p_until
  group by 1
  order by 1;
$$;

-- Ingest a batch of imported plays. Replaces the plain supabase-js upsert so that re-uploading a
-- file backfills ms_played onto rows that already exist, WITHOUT clobbering columns a later
-- enrichment pass fills in (artist_ids / artist_names / album_image / duration_ms) — a full upsert
-- would overwrite those with the import's empty/null placeholders. New rows insert in full; existing
-- rows update ms_played only (and only when the incoming value is non-null).
--
-- Returns the count of genuinely-new rows (xmax = 0 distinguishes insert from conflict-update within
-- the one statement), so the /import progress UI stays truthful on a re-run instead of counting
-- backfilled rows as freshly imported.
create or replace function public.ingest_import_plays(p_rows jsonb)
returns integer
language plpgsql
as $$
declare
  v_inserted integer;
begin
  with incoming as (
    select
      (r->>'profile_id')::uuid                as profile_id,
      (r->>'played_at')::timestamptz          as played_at,
      r->>'track_id'                          as track_id,
      r->>'track_name'                        as track_name,
      array(select jsonb_array_elements_text(r->'artist_names')) as artist_names,
      nullif(r->>'ms_played', '')::integer    as ms_played
    from jsonb_array_elements(p_rows) as r
  ),
  ins as (
    insert into public.plays
      (profile_id, played_at, track_id, track_name, artist_ids, artist_names, album_image, duration_ms, ms_played, source)
    select
      profile_id, played_at, track_id, track_name, '{}'::text[], artist_names, null, null, ms_played, 'import'
    from incoming
    on conflict (profile_id, played_at) do update
      set ms_played = coalesce(excluded.ms_played, public.plays.ms_played)
    returning (xmax = 0) as was_insert
  )
  select count(*) filter (where was_insert)::integer into v_inserted from ins;
  return v_inserted;
end;
$$;

grant execute on function public.ingest_import_plays to service_role;
