-- Leaderboard aggregation over public.plays, cross-filterable by genre (via artists_cache) and
-- compared against an immediately-preceding equal-length window to derive rank-change (NEW/climb/fall)
-- without waiting on weekly snapshots. Called via supabase-js .rpc() from the service-role client.

create or replace function public.leaderboard_top_tracks(
  p_profile_id uuid,
  p_since timestamptz,
  p_until timestamptz,
  p_prev_since timestamptz,
  p_prev_until timestamptz,
  p_genre text default null,
  p_limit int default 10
)
returns table (
  track_id text,
  track_name text,
  artist_names text[],
  album_image text,
  play_count bigint,
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
      count(*) as play_count
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
    group by pl.track_id
  ),
  prev_ranked as (
    select *, row_number() over (order by play_count desc) as rank
    from prev
  )
  select
    c.track_id, c.track_name, c.artist_names, c.album_image, c.play_count,
    c.rank::int, pr.rank::int as prev_rank
  from cur_ranked c
  left join prev_ranked pr on pr.track_id = c.track_id
  order by c.rank
  limit p_limit;
$$;

create or replace function public.leaderboard_top_artists(
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
  rank int,
  prev_rank int
)
language sql
stable
as $$
  with cur_plays as (
    select u.artist_id, u.artist_name
    from public.plays pl
    cross join lateral unnest(pl.artist_ids, pl.artist_names) as u(artist_id, artist_name)
    where pl.profile_id = p_profile_id
      and pl.played_at >= p_since
      and pl.played_at < p_until
      and (
        p_genre is null
        or exists (
          select 1 from public.artists_cache ac
          where ac.id = u.artist_id and p_genre = any(ac.genres)
        )
      )
  ),
  cur as (
    select artist_id, max(artist_name) as artist_name, count(*) as play_count
    from cur_plays
    group by artist_id
  ),
  cur_ranked as (
    select *, row_number() over (order by play_count desc, artist_name asc) as rank
    from cur
  ),
  prev_plays as (
    select u.artist_id
    from public.plays pl
    cross join lateral unnest(pl.artist_ids, pl.artist_names) as u(artist_id, artist_name)
    where pl.profile_id = p_profile_id
      and pl.played_at >= p_prev_since
      and pl.played_at < p_prev_until
      and (
        p_genre is null
        or exists (
          select 1 from public.artists_cache ac
          where ac.id = u.artist_id and p_genre = any(ac.genres)
        )
      )
  ),
  prev as (
    select artist_id, count(*) as play_count from prev_plays group by artist_id
  ),
  prev_ranked as (
    select *, row_number() over (order by play_count desc) as rank from prev
  )
  select
    c.artist_id, c.artist_name, ac.image, c.play_count, c.rank::int, pr.rank::int as prev_rank
  from cur_ranked c
  left join prev_ranked pr on pr.artist_id = c.artist_id
  left join public.artists_cache ac on ac.id = c.artist_id
  order by c.rank
  limit p_limit;
$$;

create or replace function public.leaderboard_top_genres(
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
  rank int,
  prev_rank int
)
language sql
stable
as $$
  with cur_play_genres as (
    select distinct pl.id as play_id, g.genre
    from public.plays pl
    cross join lateral unnest(pl.artist_ids) as aid(artist_id)
    join public.artists_cache ac on ac.id = aid.artist_id
    cross join lateral unnest(ac.genres) as g(genre)
    where pl.profile_id = p_profile_id
      and pl.played_at >= p_since
      and pl.played_at < p_until
  ),
  cur as (
    select genre, count(*) as play_count from cur_play_genres group by genre
  ),
  cur_ranked as (
    select *, row_number() over (order by play_count desc, genre asc) as rank from cur
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
  select c.genre, c.play_count, c.rank::int, pr.rank::int as prev_rank
  from cur_ranked c
  left join prev_ranked pr on pr.genre = c.genre
  order by c.rank
  limit p_limit;
$$;

-- Distinct genres present in a window, for the genre slicer's chip list.
create or replace function public.leaderboard_available_genres(
  p_profile_id uuid,
  p_since timestamptz,
  p_until timestamptz,
  p_limit int default 12
)
returns table (genre text, play_count bigint)
language sql
stable
as $$
  with play_genres as (
    select distinct pl.id as play_id, g.genre
    from public.plays pl
    cross join lateral unnest(pl.artist_ids) as aid(artist_id)
    join public.artists_cache ac on ac.id = aid.artist_id
    cross join lateral unnest(ac.genres) as g(genre)
    where pl.profile_id = p_profile_id
      and pl.played_at >= p_since
      and pl.played_at < p_until
  )
  select genre, count(*) as play_count
  from play_genres
  group by genre
  order by play_count desc, genre asc
  limit p_limit;
$$;

-- These run only via the service-role client (server-side, after the caller's session is already
-- verified — see src/lib/leaderboard.ts), same trust boundary as every other write path in this app.
grant execute on function public.leaderboard_top_tracks to service_role;
grant execute on function public.leaderboard_top_artists to service_role;
grant execute on function public.leaderboard_top_genres to service_role;
grant execute on function public.leaderboard_available_genres to service_role;
