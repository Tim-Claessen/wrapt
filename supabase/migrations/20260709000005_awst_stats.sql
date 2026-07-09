-- Bucket the deep-dive stats in the household's wall-clock zone (AWST / Australia/Perth, UTC+8, no
-- DST) instead of the DB session default (UTC). `plays.played_at` is timestamptz, so extract(dow) /
-- extract(hour) / date_trunc were slicing by UTC — for an AWST user that shifted the heatmap ~8h
-- (evenings showed as midday) and could push plays into the wrong day bucket near midnight.
-- Mirror of src/lib/format.ts DISPLAY_TIME_ZONE. Signatures unchanged, so create-or-replace is safe.
-- `<ts> at time zone 'Australia/Perth'` yields the local wall-clock as a `timestamp`; we then read
-- weekday/hour/day off that. For the trend, we re-stamp the truncated local timestamp as UTC so the
-- returned timestamptz carries the intended local date regardless of the caller's session zone
-- (the UI labels it with server-UTC formatting).

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
    coalesce(sum(duration_ms), 0)::bigint as total_ms,
    count(*)::bigint as total_plays,
    count(distinct track_id)::bigint as distinct_tracks,
    (select count(distinct aid) from scoped, unnest(artist_ids) as aid)::bigint as distinct_artists,
    count(distinct date_trunc('day', played_at at time zone 'Australia/Perth'))::bigint as active_days
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
    (date_trunc(p_bucket, played_at at time zone 'Australia/Perth')) at time zone 'UTC' as bucket_start,
    count(*)::bigint as play_count,
    coalesce(sum(duration_ms), 0)::bigint as total_ms
  from public.plays
  where profile_id = p_profile_id
    and played_at >= p_since
    and played_at < p_until
  group by 1
  order by 1;
$$;

create or replace function public.listening_heatmap(
  p_profile_id uuid,
  p_since timestamptz,
  p_until timestamptz
)
returns table (
  weekday int,
  hour int,
  play_count bigint
)
language sql
stable
as $$
  select
    extract(dow from played_at at time zone 'Australia/Perth')::int as weekday,
    extract(hour from played_at at time zone 'Australia/Perth')::int as hour,
    count(*)::bigint as play_count
  from public.plays
  where profile_id = p_profile_id
    and played_at >= p_since
    and played_at < p_until
  group by 1, 2;
$$;

grant execute on function public.listening_summary to service_role;
grant execute on function public.listening_trend to service_role;
grant execute on function public.listening_heatmap to service_role;
