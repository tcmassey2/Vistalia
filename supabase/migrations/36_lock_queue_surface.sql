-- 36: lock the queue surface (pre-relaunch audit of dfa6531).
--
-- claim_render_job / requeue_stuck_render_jobs / prune_old_render_jobs are
-- SECURITY DEFINER and were created without the REVOKE that migrations 12
-- and 15 apply to their functions. Postgres grants EXECUTE to PUBLIC by
-- default and Supabase exposes public-schema RPCs to the anon key — the key
-- that ships in the browser. Anyone holding it could claim customer jobs
-- (receiving the full manifest: photo URLs, address, userId), stall the
-- customer 4-9 minutes per theft, and burn the job's 3 attempts.
--
-- Same pattern as 12_render_credit_refunds.sql:68 — service role only.

revoke all on function public.claim_render_job(text) from public, anon, authenticated;
revoke all on function public.requeue_stuck_render_jobs(integer) from public, anon, authenticated;
revoke all on function public.prune_old_render_jobs() from public, anon, authenticated;

-- canary_state (33_canary_internal.sql) was created without RLS: anon could
-- read/write it via REST — pre-setting last_commit suppresses the deploy
-- canary; clearing it forces duplicate canary spend. RLS with no policies
-- blocks anon/authenticated entirely; the worker's service-role key
-- bypasses RLS and keeps working unchanged.
alter table public.canary_state enable row level security;

-- Verification (run as anon, both must be DENIED):
--   POST /rest/v1/rpc/claim_render_job        {"p_worker_id":"probe"}
--   PATCH /rest/v1/canary_state?...           {"last_commit":"x"}
-- And in SQL:
--   select proname, proacl from pg_proc
--    where proname in ('claim_render_job','requeue_stuck_render_jobs','prune_old_render_jobs');
--   select relname, relrowsecurity from pg_class where relname = 'canary_state';
