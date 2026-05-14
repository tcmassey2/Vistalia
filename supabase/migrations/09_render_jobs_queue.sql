-- EstateMotion — Render jobs queue foundation
--
-- Today the render-worker stores every in-flight job in process memory
-- (server.mjs jobs Map). That works fine for one worker instance but
-- breaks the moment we horizontally scale: the frontend's status poll
-- can land on a worker that doesn't know the jobId and 404s.
--
-- This table is the future-proof replacement: every worker writes its
-- job's progress + status here on each onProgress event. The Vercel
-- /api/render?jobId=... endpoint can read from this table as a fallback
-- when the worker's in-memory jobs Map doesn't have it (e.g., after a
-- worker restart — a problem the v23 library-recovery code already
-- addresses, but this gives us a cleaner mid-render answer).
--
-- For now the worker can OPTIONALLY write to this table — we don't
-- require it. The Vercel side will check Supabase before giving up
-- with 404, so any worker that opts in immediately benefits.
--
-- Apply via Supabase Dashboard → SQL Editor.
-- Safe to run multiple times.

create table if not exists public.render_jobs (
  job_id text primary key,
  user_id uuid references auth.users(id) on delete set null,
  status text not null default 'queued'
    check (status in ('queued', 'rendering', 'completed', 'failed')),
  phase text,
  progress integer not null default 0 check (progress between 0 and 100),
  engine text check (engine in ('remotion', 'runway')),
  mp4_url text,
  thumbnail_url text,
  worker_instance_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index for fast user-scoped status queries
create index if not exists idx_render_jobs_user_updated
  on public.render_jobs (user_id, updated_at desc);

-- Auto-update updated_at on every change
create or replace function public.touch_render_jobs_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_touch_render_jobs on public.render_jobs;
create trigger trg_touch_render_jobs
  before update on public.render_jobs
  for each row execute procedure public.touch_render_jobs_updated_at();

-- RLS: users can read their own job rows; service role bypasses.
-- Workers write via service role.
alter table public.render_jobs enable row level security;

drop policy if exists "render_jobs_self_select" on public.render_jobs;
create policy "render_jobs_self_select" on public.render_jobs
  for select using (auth.uid() = user_id);

-- Auto-prune jobs older than 24 hours via a tiny function the cron can
-- call. Stops the table from growing unboundedly. Library entries
-- (render_audit_log) are the long-term record; render_jobs is just for
-- in-flight status polling.
create or replace function public.prune_old_render_jobs()
returns integer language plpgsql security definer as $$
declare
  removed integer;
begin
  with deleted as (
    delete from public.render_jobs
    where updated_at < now() - interval '24 hours'
    returning *
  )
  select count(*) into removed from deleted;
  return removed;
end $$;

comment on table public.render_jobs is
  'In-flight render job state for horizontal worker scaling. Workers PUT progress here; Vercel /api/render reads as fallback when worker memory is empty. Auto-pruned after 24h.';
