-- Rank artists by NAME, not by Spotify artist id.
--
-- The old leaderboard_top_artists grouped by artist_id (unnested from plays.artist_ids). Imported
-- plays carry only an artist *name* string (artist_ids = '{}' until per-track enrichment resolves
-- them), so every un-enriched import collapsed into a single NULL-id group — one bogus "top artist"
-- with a huge count. Rankings were therefore broken for freshly-imported history.
--
-- Grouping on lower(artist_name) instead unifies live + imported plays (both always have names) so
-- artist rankings are correct the instant history lands. A representative artist_id is still carried
-- through (max() over the group — any resolved id) purely to look up the artist image / genres from
-- artists_cache once enrichment has run; it's null until then, which just means no image yet.
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
    select u.artist_name, u.artist_id
    from public.plays pl
    cross join lateral unnest(pl.artist_names, pl.artist_ids) as u(artist_name, artist_id)
    where pl.profile_id = p_profile_id
      and pl.played_at >= p_since
      and pl.played_at < p_until
      and u.artist_name is not null
      and (
        p_genre is null
        or exists (
          select 1 from public.artists_cache ac
          where ac.id = u.artist_id and p_genre = any(ac.genres)
        )
      )
  ),
  cur as (
    select
      lower(artist_name) as artist_key,
      max(artist_name) as artist_name,
      max(artist_id) as artist_id,   -- any resolved id, for the image/genre join; null until enriched
      count(*) as play_count
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
        or exists (
          select 1 from public.artists_cache ac
          where ac.id = u.artist_id and p_genre = any(ac.genres)
        )
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
    c.artist_id, c.artist_name, ac.image, c.play_count, c.rank::int, pr.rank::int as prev_rank
  from cur_ranked c
  left join prev_ranked pr on pr.artist_key = c.artist_key
  left join public.artists_cache ac on ac.id = c.artist_id
  order by c.rank
  limit p_limit;
$$;

grant execute on function public.leaderboard_top_artists to service_role;
