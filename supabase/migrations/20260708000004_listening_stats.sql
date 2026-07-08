-- Deep-dive dashboard stats over public.plays: headline totals, a bucketed trend (for the
-- "listening over time" chart), and a weekday x hour heatmap (for "when do you listen").
-- Same trust boundary as leaderboard_* — service_role only, called after the caller's session
-- is already verified (see src/lib/stats.ts).

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
    count(distinct date_trunc('day', played_at))::bigint as active_days
  from scoped;
$$;

-- p_bucket is 'day' or 'week' (a fixed field name passed to date_trunc, not interpolated SQL —
-- no injection surface). Callers choose the granularity client-side based on the window span.
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
    coalesce(sum(duration_ms), 0)::bigint as total_ms
  from public.plays
  where profile_id = p_profile_id
    and played_at >= p_since
    and played_at < p_until
  group by 1
  order by 1;
$$;

-- weekday: 0=Sunday..6=Saturday (Postgres extract(dow)); hour: 0..23. Sparse — callers fill the
-- 7x24 grid themselves and treat missing cells as zero.
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
    extract(dow from played_at)::int as weekday,
    extract(hour from played_at)::int as hour,
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
