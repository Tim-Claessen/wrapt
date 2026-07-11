-- Backs the "browse" chips on /artist: a random sample of artists this profile has actually
-- played, shown when no search has been entered yet, so the screen isn't just a blank search bar
-- and every chip is guaranteed to resolve (tapping one always finds plays, unlike a free-text guess).
-- Same grouping convention as artist_search/leaderboard_top_artists (by lowercased name, since
-- imported plays only ever carry a name, not a resolved artist_id).

create or replace function public.artist_random_sample(
  p_profile_id uuid,
  p_limit int default 10
)
returns table (
  artist_name text,
  image text
)
language sql
stable
as $$
  with grouped as (
    select
      lower(u.artist_name) as artist_key,
      max(u.artist_name) as artist_name,
      max(u.artist_id) as artist_id
    from public.plays pl
    cross join lateral unnest(pl.artist_names, pl.artist_ids) as u(artist_name, artist_id)
    where pl.profile_id = p_profile_id
      and u.artist_name is not null
    group by lower(u.artist_name)
  )
  select g.artist_name, ac.image
  from grouped g
  left join public.artists_cache ac on ac.id = g.artist_id
  order by random()
  limit p_limit;
$$;

grant execute on function public.artist_random_sample to service_role;
