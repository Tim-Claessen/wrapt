-- /ask, take 2 — a guarded read-only SQL sandbox. Product-owner call (Tim, 2026-07): the Ask feature
-- should run model-generated SQL directly (text-to-SQL) rather than a fixed tool whitelist, so it's a
-- genuine "ask anything" over the listening data instead of a handful of canned shapes.
--
-- Safety posture (single active user for now — REVISIT before onboarding Zoe / more users):
--   * run_ask_sql runs the model's query inside a READ-ONLY transaction with a short statement
--     timeout, so a stray write / data-modifying CTE / runaway scan can't damage or hang the DB —
--     even Tim's own data is protected from a bad generated query.
--   * The app layer (src/lib/ask.ts) also validates the SQL is a single SELECT/WITH with no
--     semicolons, comments, or data-modifying CTEs before it ever gets here (defense in depth).
--   * Results are hard-capped at 1000 rows regardless of the query.
--
-- NOT profile-isolated at the DB level: this executes via service_role and can read any profile's
-- rows. The model is instructed to filter by the caller's profile_id, which is fine while Tim is the
-- only user. Before multiple users share the table, add real isolation (a per-profile view, or a
-- SET ROLE to a row-security-bound role) here rather than trusting the prompt.
--
-- The earlier whitelist RPCs from 20260710000000 (first_plays, skip_stats) are now unused but left in
-- place; ai_usage / bump_ai_usage (the daily cap) are still used.
create or replace function public.run_ask_sql(p_sql text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
begin
  -- Hard guards, independent of the app-layer checks: no writes, no long scans.
  set local statement_timeout = '5000ms';
  set local transaction_read_only = on;
  -- Wrap the model's SELECT as a subquery so we can JSON-aggregate it and cap the row count without
  -- trusting the query to self-limit. p_sql must be a single statement with no trailing ';' or
  -- comment (enforced app-side) or this concatenation breaks — which is fine, it just errors.
  execute
    'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (' || p_sql || ') _q limit 1000) t'
    into result;
  return result;
end;
$$;

grant execute on function public.run_ask_sql to service_role;
