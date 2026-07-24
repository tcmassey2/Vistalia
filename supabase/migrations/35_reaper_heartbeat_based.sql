-- 35_reaper_heartbeat_based.sql
-- ============================================================
-- FIX: platform instance churn killed a mid-flight render (Jul 24,
-- worker-1-jtfzp, activeRenders=1, no deploy involved) and the customer
-- would have waited the full 20-minute claim-age reaper window.
--
-- Workers heartbeat every ~30s; 3 minutes of silence is already the
-- liveness threshold server.mjs uses. Re-deal on STALE HEARTBEAT
-- (4 min) instead of claim age: dead workers are recovered in ~4-9
-- minutes (stale + reaper's 5-min tick) instead of 20-25, and — the
-- latent hazard this also removes — a LIVE render that legitimately
-- runs past 20 minutes (tonight's canary: 18.3) is no longer at risk
-- of being double-dealt, because its heartbeat stays fresh. Claim age
-- remains only as a 45-minute true-zombie backstop (rows whose
-- heartbeat never wrote at all).
-- ============================================================

begin;

create or replace function public.requeue_stuck_render_jobs(p_timeout_minutes integer default 20)
returns integer
language plpgsql security definer as $$
declare n integer;
begin
  with bumped as (
    update public.render_jobs
      set status     = case when attempts >= 3 then 'failed' else 'queued' end,
          error      = case when attempts >= 3
                            then 'Render worker died mid-job (max attempts reached)'
                            else error end,
          claimed_at = null
      where status = 'rendering'
        and claimed_at is not null
        and (
          coalesce(heartbeat_at, claimed_at) < now() - interval '4 minutes'
          or claimed_at < now() - make_interval(mins => greatest(p_timeout_minutes, 45))
        )
      returning 1
  )
  select count(*) into n from bumped;
  return n;
end $$;

comment on function public.requeue_stuck_render_jobs is
  'Return render jobs orphaned by a dead worker back to queued (or fail after 3 tries). Heartbeat-stale (4 min) is the fast path; claim age >= 45 min is the zombie backstop.';

commit;
