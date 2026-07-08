-- Two dashboard additions:
--   1. Every leaderboard row now carries total_ms (minutes listened) alongside play_count, so the
--      top-10 can show "N plays · Xm" per entry. Minutes = sum(coalesce(ms_played, duration_ms, 0)),
--      same rule as listening_summary.
--   2. leaderboard_top_tracks gains an optional p_artist filter — the artist drill-down ("click an
--      artist, see their song chart") reuses the same ranked/diffed tracks query, scoped to one
--      artist by name (names are what imports carry; matches the name-based artist ranking).
--
-- Adding an OUT column / a parameter changes each function's signature, and `create or replace`
-- can't change a function's return type — so drop first, then recreate.

drop function if exists public.leaderboard_top_tracks(uuid, timestamptz, timestamptz, timestamptz, timestamptz, text, int);
drop function if exists public.leaderboard_top_artists(uuid, timestamptz, timestamptz, timestamptz, timestamptz, text, int);
drop function if exists public.leaderboard_top_genres(uuid, timestamptz, timestamptz, timestamptz, timestamptz, int);

create function public.leaderboard_top_tracks(
  p_profile_id uuid,
  p_since timestamptz,
  p_until timestamptz,
  p_prev_since timestamptz,
  p_prev_until timestamptz,
  p_genre text default null,
  p_limit int default 10,
  p_artist text default null
)
returns table (
  track_id text,
  track_name text,
  artist_names text[],
  album_image text,
  play_count bigint,
  total_ms bigint,
  rank int,
  prev_rank int
)
language sql
stable
as $$
  with cur as (
    select
      pl.track_id,
      max(pl.track_name) as track_name,
      max(pl.artist_names) as artist_names,
      max(pl.album_image) as album_image,
      count(*) as play_count,
      sum(coalesce(pl.ms_played, pl.duration_ms, 0))::bigint as total_ms
    from public.plays pl
    where pl.profile_id = p_profile_id
      and pl.played_at >= p_since
      and pl.played_at < p_until
      and (
        p_genre is null
        or exists (
          select 1 from unnest(pl.artist_ids) aid
          join public.artists_cache ac on ac.id = aid
          where p_genre = any(ac.genres)
        )
      )
      and (
        p_artist is null
        or exists (select 1 from unnest(pl.artist_names) an where lower(an) = lower(p_artist))
      )
    group by pl.track_id
  ),
  cur_ranked as (
    select *, row_number() over (order by play_count desc, track_name asc) as rank
    from cur
  ),
  prev as (
    select pl.track_id, count(*) as play_count
    from public.plays pl
    where pl.profile_id = p_profile_id
      and pl.played_at >= p_prev_since
      and pl.played_at < p_prev_until
      and (
        p_genre is null
        or exists (
          select 1 from unnest(pl.artist_ids) aid
          join public.artists_cache ac on ac.id = aid
          where p_genre = any(ac.genres)
        )
      )
      and (
        p_artist is null
        or exists (select 1 from unnest(pl.artist_names) an where lower(an) = lower(p_artist))
      )
    group by pl.track_id
  ),
  prev_ranked as (
    select *, row_number() over (order by play_count desc) as rank
    from prev
  )
  select
    c.track_id, c.track_name, c.artist_names, c.album_image, c.play_count, c.total_ms,
    c.rank::int, pr.rank::int as prev_rank
  from cur_ranked c
  left join prev_ranked pr on pr.track_id = c.track_id
  order by c.rank
  limit p_limit;
$$;

-- Artist ranking by lowercased name (see 20260709000001), now with total_ms.
create function public.leaderboard_top_artists(
  p_profile_id uuid,
  p_since timestamptz,
  p_until timestamptz,
  p_prev_since timestamptz,
  p_prev_until timestamptz,
  p_genre text default null,
  p_limit int default 10
)
returns table (
  artist_id text,
  artist_name text,
  image text,
  play_count bigint,
  total_ms bigint,
  rank int,
  prev_rank int
)
language sql
stable
as $$
  with cur_plays as (
    select u.artist_name, u.artist_id, coalesce(pl.ms_played, pl.duration_ms, 0) as ms
    from public.plays pl
    cross join lateral unnest(pl.artist_names, pl.artist_ids) as u(artist_name, artist_id)
    where pl.profile_id = p_profile_id
      and pl.played_at >= p_since
      and pl.played_at < p_until
      and u.artist_name is not null
      and (
        p_genre is null
        or exists (select 1 from public.artists_cache ac where ac.id = u.artist_id and p_genre = any(ac.genres))
      )
  ),
  cur as (
    select
      lower(artist_name) as artist_key,
      max(artist_name) as artist_name,
      max(artist_id) as artist_id,
      count(*) as play_count,
      sum(ms)::bigint as total_ms
    from cur_plays
    group by lower(artist_name)
  ),
  cur_ranked as (
    select *, row_number() over (order by play_count desc, artist_name asc) as rank
    from cur
  ),
  prev_plays as (
    select u.artist_name, u.artist_id
    from public.plays pl
    cross join lateral unnest(pl.artist_names, pl.artist_ids) as u(artist_name, artist_id)
    where pl.profile_id = p_profile_id
      and pl.played_at >= p_prev_since
      and pl.played_at < p_prev_until
      and u.artist_name is not null
      and (
        p_genre is null
        or exists (select 1 from public.artists_cache ac where ac.id = u.artist_id and p_genre = any(ac.genres))
      )
  ),
  prev as (
    select lower(artist_name) as artist_key, count(*) as play_count
    from prev_plays
    group by lower(artist_name)
  ),
  prev_ranked as (
    select *, row_number() over (order by play_count desc) as rank
    from prev
  )
  select
    c.artist_id, c.artist_name, ac.image, c.play_count, c.total_ms, c.rank::int, pr.rank::int as prev_rank
  from cur_ranked c
  left join prev_ranked pr on pr.artist_key = c.artist_key
  left join public.artists_cache ac on ac.id = c.artist_id
  order by c.rank
  limit p_limit;
$$;

create function public.leaderboard_top_genres(
  p_profile_id uuid,
  p_since timestamptz,
  p_until timestamptz,
  p_prev_since timestamptz,
  p_prev_until timestamptz,
  p_limit int default 10
)
returns table (
  genre text,
  play_count bigint,
  total_ms bigint,
  rank int,
  prev_rank int
)
language sql
stable
as $$
  with cur_play_genres as (
    select distinct pl.id as play_id, coalesce(pl.ms_played, pl.duration_ms, 0) as ms, g.genre
    from public.plays pl
    cross join lateral unnest(pl.artist_ids) as aid(artist_id)
    join public.artists_cache ac on ac.id = aid.artist_id
    cross join lateral unnest(ac.genres) as g(genre)
    where pl.profile_id = p_profile_id
      and pl.played_at >= p_since
      and pl.played_at < p_until
  ),
  cur as (
    select genre, count(*) as play_count, sum(ms)::bigint as total_ms
    from cur_play_genres
    group by genre
  ),
  cur_ranked as (
    select *, row_number() over (order by play_count desc, genre asc) as rank
    from cur
  ),
  prev_play_genres as (
    select distinct pl.id as play_id, g.genre
    from public.plays pl
    cross join lateral unnest(pl.artist_ids) as aid(artist_id)
    join public.artists_cache ac on ac.id = aid.artist_id
    cross join lateral unnest(ac.genres) as g(genre)
    where pl.profile_id = p_profile_id
      and pl.played_at >= p_prev_since
      and pl.played_at < p_prev_until
  ),
  prev as (
    select genre, count(*) as play_count from prev_play_genres group by genre
  ),
  prev_ranked as (
    select *, row_number() over (order by play_count desc) as rank from prev
  )
  select c.genre, c.play_count, c.total_ms, c.rank::int, pr.rank::int as prev_rank
  from cur_ranked c
  left join prev_ranked pr on pr.genre = c.genre
  order by c.rank
  limit p_limit;
$$;

grant execute on function public.leaderboard_top_tracks to service_role;
grant execute on function public.leaderboard_top_artists to service_role;
grant execute on function public.leaderboard_top_genres to service_role;
