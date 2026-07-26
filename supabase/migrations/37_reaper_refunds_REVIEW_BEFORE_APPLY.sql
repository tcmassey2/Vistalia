-- 37: the reaper's 3-strike failure refunds the customer.
--
-- *** REVIEW BEFORE APPLY — THIS TOUCHES CREDITS. ***
-- Filename carries the marker so it cannot be applied absent-mindedly in a
-- migration sweep; rename to 37_reaper_refunds.sql when approved.
--
-- Audit finding (dfa6531): migration 35's reaper marks a thrice-redelivered
-- job `failed` in SQL, but the ONLY caller of refund_render_credit in the
-- codebase is the worker's in-process catch (server.mjs:843) — which by
-- definition did not run for a job whose worker died. The customer is
-- charged at submit (bumpUsage) and never refunded, and no sweep exists.
--
-- This replaces requeue_stuck_render_jobs with the SAME body as migration
-- 35 plus one addition: rows that just transitioned to `failed` refund
-- through the existing idempotent refund_render_credit (unique job_id —
-- a job can never be refunded twice, so overlap with the worker's own
-- refund path is safe by construction).
--
-- Historical victims are NOT covered by this migration — find them first:
--   select j.job_id, j.user_id, j.error
--     from render_jobs j
--     left join render_credit_refunds r using (job_id)
--    where j.status = 'failed'
--      and j.error like '%max attempts%'
--      and r.job_id is null;
-- and refund each with:
--   select public.refund_render_credit(user_id, job_id, 'reaper_backfill');

create or replace function public.requeue_stuck_render_jobs(p_timeout_minutes integer default 20)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer := 0;
  r record;
begin
  for r in
    with bumped as (
      update public.render_jobs
        set status     = case when attempts >= 3 then 'failed' else 'queued' end,
            error      = case when attempts >= 3
                              then 'Render worker died mid-job (max attempts reached)'
                              else error end,
            claimed_at = null,
            -- v62.37: migration 35 dropped migration 25's heartbeat reset,
            -- so a redelivered job carried its dead worker's STALE
            -- heartbeat and could be re-reaped inside the fresh claim
            -- window. Requeued rows start clean.
            heartbeat_at = null
        where status = 'rendering'
          and claimed_at is not null
          and (
            coalesce(heartbeat_at, claimed_at) < now() - interval '4 minutes'
            or claimed_at < now() - make_interval(mins => greatest(p_timeout_minutes, 45))
          )
        returning job_id, user_id, status
    )
    select job_id, user_id, status from bumped
  loop
    n := n + 1;
    if r.status = 'failed' and r.user_id is not null then
      -- Idempotent: refund_render_credit no-ops on a duplicate job_id.
      perform public.refund_render_credit(r.user_id, r.job_id, 'worker_died_max_attempts');
    end if;
  end loop;
  return n;
end;
$$;

-- Keep the surface locked (matches migration 36).
revoke all on function public.requeue_stuck_render_jobs(integer) from public, anon, authenticated;
