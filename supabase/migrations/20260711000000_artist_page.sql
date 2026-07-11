-- Backs the new /artist page: a single-artist deep-dive reached by searching an artist name.
--
-- Two RPCs, same trust boundary as leaderboard_*/plays_history* (service_role-only, called from
-- Astro frontmatter after the caller's session is verified):
--   * artist_search — free-text substring match over every artist name this profile has ever
--     played, grouped by lowercased name (same convention as leaderboard_top_artists — imported
--     plays only ever carry a name, not a resolved artist_id), ranked by all-time play count. Used
--     both to resolve a loose search query and to disambiguate when it matches more than one artist.
--   * artist_summary — all-time totals for one exact (case-insensitive) artist name: total plays,
--     total minutes, first play ever logged (and which track that was), and the calendar year with
--     the most listening time. Year is bucketed in the household's pinned display zone (see
--     DISPLAY_TIME_ZONE / src/lib/format.ts) — keep that string in sync with this one.

create or replace function public.artist_search(
  p_profile_id uuid,
  p_query text,
  p_limit int default 8
)
returns table (
  artist_name text,
  play_count bigint,
  image text
)
language sql
stable
as $$
  with matched as (
    select u.artist_name, u.artist_id
    from public.plays pl
    cross join lateral unnest(pl.artist_names, pl.artist_ids) as u(artist_name, artist_id)
    where pl.profile_id = p_profile_id
      and u.artist_name ilike '%' || p_query || '%'
  ),
  grouped as (
    select
      lower(artist_name) as artist_key,
      max(artist_name) as artist_name,
      max(artist_id) as artist_id,
      count(*) as play_count
    from matched
    group by lower(artist_name)
  )
  select g.artist_name, g.play_count, ac.image
  from grouped g
  left join public.artists_cache ac on ac.id = g.artist_id
  order by g.play_count desc, g.artist_name asc
  limit p_limit;
$$;

create or replace function public.artist_summary(
  p_profile_id uuid,
  p_artist text
)
returns table (
  artist_name text,
  total_plays bigint,
  total_ms bigint,
  first_played_at timestamptz,
  first_track_name text,
  best_year int,
  best_year_ms bigint,
  image text
)
language sql
stable
as $$
  with matched as (
    select
      pl.played_at,
      pl.track_name,
      coalesce(pl.ms_played, pl.duration_ms, 0) as ms,
      u.artist_name,
      u.artist_id
    from public.plays pl
    cross join lateral unnest(pl.artist_names, pl.artist_ids) as u(artist_name, artist_id)
    where pl.profile_id = p_profile_id
      and lower(u.artist_name) = lower(p_artist)
  ),
  totals as (
    select max(artist_name) as artist_name, count(*)::bigint as total_plays, sum(ms)::bigint as total_ms
    from matched
  ),
  first_play as (
    select played_at, track_name from matched order by played_at asc limit 1
  ),
  yearly as (
    select
      extract(year from played_at at time zone 'Australia/Perth')::int as yr,
      sum(ms)::bigint as yr_ms
    from matched
    group by yr
    order by yr_ms desc
    limit 1
  ),
  img as (
    select ac.image
    from matched m
    join public.artists_cache ac on ac.id = m.artist_id
    limit 1
  )
  select
    t.artist_name,
    coalesce(t.total_plays, 0),
    coalesce(t.total_ms, 0),
    fp.played_at,
    fp.track_name,
    y.yr,
    coalesce(y.yr_ms, 0),
    img.image
  from totals t
  left join first_play fp on true
  left join yearly y on true
  left join img on true;
$$;

grant execute on function public.artist_search to service_role;
grant execute on function public.artist_summary to service_role;
