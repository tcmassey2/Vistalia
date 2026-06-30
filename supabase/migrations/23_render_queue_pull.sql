-- Vistalia — turn render_jobs into a real PULL queue (horizontal scaling)
--
-- Migration 09 created render_jobs as a *status* table (workers PUT progress;
-- Vercel reads it as a fallback). This migration extends it into a job QUEUE
-- so multiple worker instances can each pull work safely:
--   - manifest/result columns hold the job payload + final output
--   - claim_render_job() atomically claims one queued job with
--     FOR UPDATE SKIP LOCKED, so two workers NEVER grab the same job
--   - requeue_stuck_render_jobs() returns jobs orphaned by a dead worker
--
-- Safe to run multiple times. Apply via Supabase Dashboard → SQL Editor
-- BEFORE deploying the queue-aware worker (the worker falls back to inline
-- rendering if these objects are missing, so order isn't fatal — but apply
-- this first to actually get the queue).

-- 1. Payload + claim-tracking columns -------------------------------------
alter table public.render_jobs add column if not exists manifest    jsonb;
alter table public.render_jobs add column if not exists result      jsonb;
alter table public.render_jobs add column if not exists claimed_at  timestamptz;
alter table public.render_jobs add column if not exists attempts    integer not null default 0;

-- engine check from migration 09 only allowed remotion/runway; the pipeline
-- now uses veo/depth too. Drop the constraint so enqueue can store any engine.
alter table public.render_jobs drop constraint if exists render_jobs_engine_check;

-- Fast lookup of the next queued job.
create index if not exists idx_render_jobs_queued
  on public.render_jobs (created_at) where status = 'queued';

-- 2. Atomic claim ----------------------------------------------------------
-- Claims the oldest queued job for one worker. FOR UPDATE SKIP LOCKED means
-- concurrent workers each get a DIFFERENT row (or none) — no double-rendering.
-- Returns the full row (incl. manifest) or NULL when the queue is empty.
create or replace function public.claim_render_job(p_worker_id text)
returns public.render_jobs
language plpgsql security definer as $$
declare
  claimed public.render_jobs;
begin
  select * into claimed
    from public.render_jobs
    where status = 'queued'
    order by created_at
    for update skip locked
    limit 1;

  if not found then
    return null;
  end if;

  update public.render_jobs
    set status             = 'rendering',
        worker_instance_id = p_worker_id,
        claimed_at         = now(),
        attempts           = attempts + 1,
        phase              = 'Claimed',
        progress           = greatest(progress, 5)
    where job_id = claimed.job_id
    returning * into claimed;

  return claimed;
end $$;

-- 3. Reclaim orphaned jobs -------------------------------------------------
-- A worker that dies mid-render leaves a row stuck in 'rendering'. After the
-- timeout, return it to 'queued' so another worker retries; after 3 attempts,
-- mark it failed so it can't loop forever. Returns how many rows it touched.
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
        and claimed_at < now() - make_interval(mins => p_timeout_minutes)
      returning 1
  )
  select count(*) into n from bumped;
  return n;
end $$;

comment on function public.claim_render_job is
  'Atomically claim one queued render job (FOR UPDATE SKIP LOCKED). Safe for N concurrent workers.';
comment on function public.requeue_stuck_render_jobs is
  'Return render jobs orphaned by a dead worker back to queued (or fail after 3 tries).';
