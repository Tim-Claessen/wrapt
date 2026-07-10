-- /ask feature: two new read RPCs the AI agent can call (first_plays, skip_stats) plus a per-day
-- usage meter (ai_usage + bump_ai_usage) that caps questions. Same trust boundary as every other
-- RPC here — service_role only, called from server code after the caller's session is verified
-- (see src/lib/ask.ts). The agent never writes SQL; these are the *only* shapes it can query, each
-- with the profile_id injected server-side, so a model can't reach another user's data.

-- ---------------------------------------------------------------------------------------------------
-- first_plays: artists whose first-ever play (min(played_at) over ALL history) lands inside the
-- window. Powers "what did I discover in <range>?" / "am I finding more new artists this year?".
-- Grouped by lowercased artist name — matching leaderboard_top_artists / the name-based ranking —
-- so imported history counts immediately (imports carry names, not ids). play_count is that artist's
-- lifetime play count (times you've played them since discovery), so a discovery reads as
-- "found them on <date>, played N times since". Ordered newest-discovery first, capped by p_limit.
create or replace function public.first_plays(
  p_profile_id uuid,
  p_since timestamptz,
  p_until timestamptz,
  p_limit int default 20
)
returns table (
  artist_name text,
  first_played_at timestamptz,
  play_count bigint
)
language sql
stable
as $$
  with per_artist as (
    select
      lower(u.artist_name) as artist_key,
      max(u.artist_name) as artist_name,
      min(pl.played_at) as first_played_at,
      count(*) as play_count
    from public.plays pl
    cross join lateral unnest(pl.artist_names) as u(artist_name)
    where pl.profile_id = p_profile_id
      and u.artist_name is not null
      and u.artist_name <> ''
    group by lower(u.artist_name)
  )
  select artist_name, first_played_at, play_count
  from per_artist
  where first_played_at >= p_since
    and first_played_at < p_until
  order by first_played_at desc
  limit p_limit;
$$;

-- ---------------------------------------------------------------------------------------------------
-- skip_stats: the tracks you bail on most in the window. There's no real "skip" event in the data,
-- so this is a PROXY: a play counts as a skip when ms_played is known and is under 30s listened, OR
-- under half the track when its true duration is known — least(30000, duration_ms * 0.5).
--   Proxy limits (be honest about these when surfacing the numbers):
--     * Live plays have no ms_played (the /recently-played API omits it), so they never count as a
--       skip either way — this only sees *imported* history's listened-time. Live-only tracks won't
--       appear as skipped.
--     * Unenriched imported tracks lack duration_ms, so the 30s rule alone carries them (the half-
--       track test can't apply until enrichment backfills a real duration).
--     * A short interruption (paused, closed the app) is indistinguishable from an active skip.
-- Requires >= 5 plays in the window to rank, so a single skip of a one-off play can't top the chart.
create or replace function public.skip_stats(
  p_profile_id uuid,
  p_since timestamptz,
  p_until timestamptz,
  p_limit int default 10
)
returns table (
  track_id text,
  track_name text,
  artist_names text[],
  plays bigint,
  skips bigint,
  skip_rate numeric
)
language sql
stable
as $$
  with scoped as (
    select
      pl.track_id,
      pl.track_name,
      pl.artist_names,
      (
        pl.ms_played is not null
        and pl.ms_played < least(30000, coalesce(pl.duration_ms, 2147483647) * 0.5)
      ) as is_skip
    from public.plays pl
    where pl.profile_id = p_profile_id
      and pl.played_at >= p_since
      and pl.played_at < p_until
  ),
  agg as (
    select
      track_id,
      max(track_name) as track_name,
      max(artist_names) as artist_names,
      count(*) as plays,
      count(*) filter (where is_skip) as skips
    from scoped
    group by track_id
  )
  select
    track_id,
    track_name,
    artist_names,
    plays,
    skips,
    round(skips::numeric / plays, 3) as skip_rate
  from agg
  where plays >= 5
  order by skip_rate desc, plays desc, track_name asc
  limit p_limit;
$$;

grant execute on function public.first_plays to service_role;
grant execute on function public.skip_stats to service_role;

-- ---------------------------------------------------------------------------------------------------
-- ai_usage: per-profile, per-day, per-kind counter behind the AI question cap. One row per
-- (profile, day, kind). `day` is a calendar date in the household zone (AWST) so "today's 50
-- questions" resets at local midnight, matching the rest of the app's day boundaries (see
-- DISPLAY_TIME_ZONE / the awst_stats migration).
create table if not exists public.ai_usage (
  profile_id uuid not null references public.spotify_profiles (id) on delete cascade,
  day date not null,
  kind text not null,
  count int not null default 0,
  primary key (profile_id, day, kind)
);

alter table public.ai_usage enable row level security;

-- No policies for authenticated/anon: like `plays`, only the service-role client ever touches this
-- (bump_ai_usage runs server-side after the session is verified).
revoke all on public.ai_usage from anon, authenticated;

-- bump_ai_usage: atomically increment today's counter for (profile, kind) and report whether the
-- request is allowed under p_limit. The whole thing is a single INSERT ... ON CONFLICT DO UPDATE:
--   * first request of the day inserts count = 1 → allowed
--   * subsequent requests bump count, but the DO UPDATE's WHERE stops it once count >= p_limit, so
--     a blocked request never increments (no over-count to unwind, no race window)
-- Returns (allowed, used, remaining). `used` is the count after this call for an allowed request, or
-- the current at-cap count for a blocked one. Volatile (it writes) — not `stable` like the read RPCs.
create or replace function public.bump_ai_usage(
  p_profile_id uuid,
  p_kind text,
  p_limit int
)
returns table (allowed boolean, used int, remaining int)
language plpgsql
as $$
declare
  v_day date := (now() at time zone 'Australia/Perth')::date;
  v_count int;
begin
  insert into public.ai_usage as u (profile_id, day, kind, count)
  values (p_profile_id, v_day, p_kind, 1)
  on conflict (profile_id, day, kind)
  do update set count = u.count + 1
  where u.count < p_limit
  returning u.count into v_count;

  if v_count is null then
    -- Conflict row already at/over the limit; the WHERE blocked the update, nothing incremented.
    select c.count into v_count
    from public.ai_usage c
    where c.profile_id = p_profile_id and c.day = v_day and c.kind = p_kind;
    return query select false, coalesce(v_count, p_limit), 0;
  end if;

  return query select true, v_count, greatest(p_limit - v_count, 0);
end;
$$;

grant execute on function public.bump_ai_usage to service_role;
