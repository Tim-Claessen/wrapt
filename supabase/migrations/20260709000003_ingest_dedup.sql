-- Fix: ingest_import_plays must dedup incoming rows by (profile_id, played_at) BEFORE the insert.
--
-- The Extended Streaming History export can contain two plays with the same second-precision `ts`
-- (a skip then an immediate replay, etc.). If two such rows land in the same batch, the
-- INSERT ... ON CONFLICT (profile_id, played_at) DO UPDATE throws "ON CONFLICT DO UPDATE command
-- cannot affect row a second time" and the whole batch 500s — which silently halted every re-upload
-- partway through (only the batches before the first collision got written). The original importer
-- used DO NOTHING, which tolerates in-batch duplicate keys; DO UPDATE does not.
--
-- `distinct on (profile_id, played_at)` collapses each timestamp to one row (keeping the largest
-- ms_played), so the insert never presents a duplicate conflict key. Everything else is unchanged.
create or replace function public.ingest_import_plays(p_rows jsonb)
returns integer
language plpgsql
as $$
declare
  v_inserted integer;
begin
  with parsed as (
    select
      (r->>'profile_id')::uuid                as profile_id,
      (r->>'played_at')::timestamptz          as played_at,
      r->>'track_id'                          as track_id,
      r->>'track_name'                        as track_name,
      array(select jsonb_array_elements_text(r->'artist_names')) as artist_names,
      nullif(r->>'ms_played', '')::integer    as ms_played
    from jsonb_array_elements(p_rows) as r
  ),
  incoming as (
    select distinct on (profile_id, played_at) *
    from parsed
    order by profile_id, played_at, ms_played desc nulls last
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
