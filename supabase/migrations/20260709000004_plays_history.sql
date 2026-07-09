-- Play History view: a chronological, filterable log of every play (Song · Artist · when), plus a
-- matching aggregate for the page's HERO stats and pagination total. Both filter identically —
-- optional date range on played_at and an optional free-text query matched against the track name
-- OR any artist name — so the stats always describe exactly the rows the table is paging through.
-- service_role-only, same trust boundary as the leaderboard_* functions: called from the /history
-- page via the service client after the caller's session is verified.

create or replace function public.plays_history(
  p_profile_id uuid,
  p_since timestamptz default null,
  p_until timestamptz default null,
  p_query text default null,
  p_limit int default 50,
  p_offset int default 0
)
returns table (
  played_at timestamptz,
  track_id text,
  track_name text,
  artist_names text[],
  album_image text,
  ms_played int,
  duration_ms int
)
language sql
stable
as $$
  select pl.played_at, pl.track_id, pl.track_name, pl.artist_names, pl.album_image, pl.ms_played, pl.duration_ms
  from public.plays pl
  where pl.profile_id = p_profile_id
    and (p_since is null or pl.played_at >= p_since)
    and (p_until is null or pl.played_at < p_until)
    and (
      p_query is null or p_query = ''
      or pl.track_name ilike '%' || p_query || '%'
      or exists (select 1 from unnest(pl.artist_names) an where an ilike '%' || p_query || '%')
    )
  order by pl.played_at desc
  limit p_limit offset p_offset;
$$;

create or replace function public.plays_history_summary(
  p_profile_id uuid,
  p_since timestamptz default null,
  p_until timestamptz default null,
  p_query text default null
)
returns table (
  total_plays bigint,
  distinct_tracks bigint,
  distinct_artists bigint,
  total_ms bigint
)
language sql
stable
as $$
  with filtered as (
    select pl.track_id, pl.artist_names, coalesce(pl.ms_played, pl.duration_ms, 0) as ms
    from public.plays pl
    where pl.profile_id = p_profile_id
      and (p_since is null or pl.played_at >= p_since)
      and (p_until is null or pl.played_at < p_until)
      and (
        p_query is null or p_query = ''
        or pl.track_name ilike '%' || p_query || '%'
        or exists (select 1 from unnest(pl.artist_names) an where an ilike '%' || p_query || '%')
      )
  )
  select
    count(*)::bigint as total_plays,
    count(distinct track_id)::bigint as distinct_tracks,
    (select count(distinct lower(an)) from filtered f, unnest(f.artist_names) an)::bigint as distinct_artists,
    coalesce(sum(ms), 0)::bigint as total_ms
  from filtered;
$$;

grant execute on function public.plays_history to service_role;
grant execute on function public.plays_history_summary to service_role;
