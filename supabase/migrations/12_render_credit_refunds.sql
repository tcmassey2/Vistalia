-- 12_render_credit_refunds.sql
-- v26.4 (Phase 2 remainder): credit refunds for aborted Veo renders.
--
-- The worker aborts a render (no partial videos) when a scene fails twice
-- on Veo. The user-facing error promises a refund — this is the mechanism.
-- The worker calls refund_render_credit() with its service-role key from
-- runRenderJob's failure handler when error.code = VEO_SCENE_FAILED.
--
-- Design notes:
--   * Decrements profiles.videos_used_this_month (floor 0) — the same
--     counter get_user_tier_state quota-checks against, so the refund is
--     immediately visible in the dashboard usage banner.
--   * Every refund is journaled in render_credit_refunds for support and
--     abuse auditing (a user whose renders fail 10x/day is a signal, and
--     so would be a refund-farming pattern).
--   * Idempotent per job_id: refunding the same failed job twice is a
--     no-op, so worker retries / double-fired failure handlers are safe.

create table if not exists public.render_credit_refunds (
  id uuid primary key default gen_random_uuid(),
  job_id text not null unique,
  user_id uuid not null references auth.users (id) on delete cascade,
  reason text not null default 'render_failed',
  error_code text,
  refunded_at timestamptz not null default now()
);

alter table public.render_credit_refunds enable row level security;

-- Users may see their own refund history; only service role writes.
drop policy if exists "refunds_select_own" on public.render_credit_refunds;
create policy "refunds_select_own"
  on public.render_credit_refunds for select
  using (auth.uid() = user_id);

create or replace function public.refund_render_credit(
  p_user_id uuid,
  p_job_id text,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer := 0;
begin
  -- Idempotency: one refund per job, ever.
  insert into public.render_credit_refunds (job_id, user_id, error_code)
  values (p_job_id, p_user_id, p_error_code)
  on conflict (job_id) do nothing;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return false; -- already refunded
  end if;

  update public.profiles
  set videos_used_this_month = greatest(coalesce(videos_used_this_month, 0) - 1, 0)
  where user_id = p_user_id;

  return true;
end;
$$;

-- Only the service role may execute (worker-side calls only).
revoke all on function public.refund_render_credit(uuid, text, text) from public, anon, authenticated;
