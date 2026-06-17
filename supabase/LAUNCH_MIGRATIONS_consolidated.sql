-- EstateMotion — consolidated launch migrations (run once, in this order)
-- Paste into Supabase SQL Editor and Run. Files 12 → 13 → 14 → 15.

-- ============================================================
-- 12_render_credit_refunds.sql
-- ============================================================
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


-- ============================================================
-- 13_v26_pricing_tiers.sql
-- ============================================================
-- 13_v26_pricing_tiers.sql
-- v26.5 (Phase 3): launch pricing lineup.
--   launch  $99/mo  —  8 renders
--   pro     $249/mo — 25 renders
--   studio  $499/mo — 50 renders
-- Trial: 7 days, 1 free video, no card.
-- 60-second videos consume 2 render credits (enforced via p_credits).
-- quick_reel and cinematic_4k retire (rows kept for legacy subscribers
-- until their subscriptions lapse; webhook maps old prices unchanged).

-- 1. New tier rows. All paid tiers get the AI engines; 'runway' stays in
--    the list because the frontend still requests it — the worker
--    transparently upgrades it to veo (v26.3 dispatcher).
insert into public.tier_plans (tier, available_engines)
values
  ('launch', array['remotion','runway','veo']),
  ('pro',    array['remotion','runway','veo']),
  ('studio', array['remotion','runway','veo'])
on conflict (tier) do update set available_engines = excluded.available_engines;

update public.tier_plans
  set available_engines = array['remotion','runway','veo']
  where tier in ('trial','cinematic_ai','cinematic_4k');

-- 2. Trial cap: 3 → 1 (locked June 9: trial = one free video).
--    get_user_tier_state is redefined only for the constant; body otherwise
--    identical to migration 07/11 behavior.
create or replace function public.get_user_tier_state(p_user_id uuid)
returns table (
  tier text,
  monthly_video_quota integer,
  videos_used_this_month integer,
  available_engines text[],
  can_render boolean,
  reason text,
  trial_ends_at timestamptz,
  trial_renders_used integer,
  trial_render_cap integer,
  current_period_end timestamptz,
  subscription_status text
)
language sql security definer as $$
  with constants as (
    select 1::integer as trial_render_cap
  )
  select
    p.tier,
    p.monthly_video_quota,
    p.videos_used_this_month,
    tp.available_engines,
    (
      p.videos_used_this_month < p.monthly_video_quota
      and (p.subscription_status in ('trialing','active') or p.tier = 'trial')
      and not (p.tier = 'trial' and p.trial_ends_at is not null and now() > p.trial_ends_at)
      and not (p.tier = 'trial' and p.trial_renders_used >= c.trial_render_cap)
    ) as can_render,
    case
      when p.subscription_status = 'past_due' then 'Subscription past due — update payment to continue rendering.'
      when p.subscription_status = 'canceled' then 'Subscription canceled.'
      when p.tier = 'trial' and p.trial_ends_at is not null and now() > p.trial_ends_at then
        'Your 7-day free trial has ended. Pick a plan to keep rendering.'
      when p.tier = 'trial' and p.trial_renders_used >= c.trial_render_cap then
        'You''ve used your free trial video. Pick a plan to keep rendering.'
      when p.videos_used_this_month >= p.monthly_video_quota then
        'Monthly video quota reached. Upgrade or wait until next billing cycle.'
      else null
    end as reason,
    p.trial_ends_at,
    p.trial_renders_used,
    c.trial_render_cap,
    p.current_period_end,
    p.subscription_status
  from public.profiles p
  left join public.tier_plans tp on tp.tier = p.tier
  cross join constants c
  where p.user_id = p_user_id;
$$;

-- 3. Universal usage counter. Replaces the trial-only increment for ALL
--    tiers (paid usage was previously under-counted — only trials bumped).
--    p_credits: 1 for a 30s video, 2 for 60s.
create or replace function public.increment_render_usage(
  p_user_id uuid,
  p_credits integer default 1
)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  update public.profiles
  set
    videos_used_this_month = coalesce(videos_used_this_month, 0) + greatest(p_credits, 1),
    trial_renders_used = case
      when tier = 'trial' then coalesce(trial_renders_used, 0) + greatest(p_credits, 1)
      else trial_renders_used
    end
  where user_id = p_user_id;
end;
$$;

revoke all on function public.increment_render_usage(uuid, integer) from public, anon, authenticated;


-- ============================================================
-- 14_render_credit_packs.sql
-- ============================================================
-- 14_render_credit_packs.sql
-- v26.6: one-off video purchases + credit packs (no subscription).
--   Single video  $100 → 1 credit
--   5-video pack   $375 → 5 credits
-- Credits never expire and are consumed AFTER subscription quota.
-- A 60-second video consumes 2 credits (matches render.js renderCreditsFor).
--
-- This is the cash-flywheel path: cold ad traffic gets 1 free trial video,
-- then buys credit packs. Collected cash (not MRR) funds more ad spend.

-- 1. Purchased-credit balance. Separate from monthly_video_quota so it
--    survives billing-cycle resets and works for users with no subscription.
alter table public.profiles
  add column if not exists render_credits integer not null default 0;

-- 2. Grant credits (called from the Stripe webhook on a paid one-time
--    checkout). Idempotent per Stripe session id via the ledger table so a
--    webhook retry can't double-grant.
create table if not exists public.credit_grants (
  id uuid primary key default gen_random_uuid(),
  stripe_session_id text not null unique,
  user_id uuid not null references auth.users (id) on delete cascade,
  credits integer not null,
  granted_at timestamptz not null default now()
);
alter table public.credit_grants enable row level security;
drop policy if exists "credit_grants_select_own" on public.credit_grants;
create policy "credit_grants_select_own"
  on public.credit_grants for select using (auth.uid() = user_id);

create or replace function public.grant_render_credits(
  p_user_id uuid,
  p_credits integer,
  p_session_id text
)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_rows integer := 0;
begin
  insert into public.credit_grants (stripe_session_id, user_id, credits)
  values (p_session_id, p_user_id, p_credits)
  on conflict (stripe_session_id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return false; end if; -- already granted

  update public.profiles
  set render_credits = coalesce(render_credits, 0) + greatest(p_credits, 0)
  where user_id = p_user_id;
  return true;
end;
$$;
revoke all on function public.grant_render_credits(uuid, integer, text) from public, anon, authenticated;

-- 3. Redefine the tier-state gate to allow rendering when the user has
--    purchased credits, even with no active subscription / exhausted trial.
create or replace function public.get_user_tier_state(p_user_id uuid)
returns table (
  tier text,
  monthly_video_quota integer,
  videos_used_this_month integer,
  available_engines text[],
  can_render boolean,
  reason text,
  trial_ends_at timestamptz,
  trial_renders_used integer,
  trial_render_cap integer,
  current_period_end timestamptz,
  subscription_status text,
  render_credits integer
)
language sql security definer as $$
  with constants as (select 1::integer as trial_render_cap)
  select
    p.tier,
    p.monthly_video_quota,
    p.videos_used_this_month,
    tp.available_engines,
    (
      coalesce(p.render_credits, 0) >= 1
      or (
        p.videos_used_this_month < p.monthly_video_quota
        and (p.subscription_status in ('trialing','active') or p.tier = 'trial')
        and not (p.tier = 'trial' and p.trial_ends_at is not null and now() > p.trial_ends_at)
        and not (p.tier = 'trial' and p.trial_renders_used >= c.trial_render_cap)
      )
    ) as can_render,
    case
      when coalesce(p.render_credits,0) >= 1 then null
      when p.subscription_status = 'past_due' then 'Subscription past due — update payment to continue rendering.'
      when p.subscription_status = 'canceled' then 'Subscription canceled.'
      when p.tier = 'trial' and p.trial_ends_at is not null and now() > p.trial_ends_at then
        'Your free trial has ended. Buy a video or pick a plan to keep rendering.'
      when p.tier = 'trial' and p.trial_renders_used >= c.trial_render_cap then
        'You''ve used your free trial video. Buy a video ($100) or pick a plan to keep rendering.'
      when p.videos_used_this_month >= p.monthly_video_quota then
        'Monthly video quota reached. Buy a video, upgrade, or wait until next cycle.'
      else null
    end as reason,
    p.trial_ends_at,
    p.trial_renders_used,
    c.trial_render_cap,
    p.current_period_end,
    p.subscription_status,
    coalesce(p.render_credits, 0) as render_credits
  from public.profiles p
  left join public.tier_plans tp on tp.tier = p.tier
  cross join constants c
  where p.user_id = p_user_id;
$$;

-- 4. Consumption: prefer subscription quota; fall back to purchased credits.
--    p_credits = 1 (30s) or 2 (60s). Replaces the v26.5 increment_render_usage.
create or replace function public.increment_render_usage(
  p_user_id uuid,
  p_credits integer default 1
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_used integer; v_quota integer; v_status text; v_tier text; v_credits integer;
  v_n integer := greatest(p_credits, 1);
begin
  select videos_used_this_month, monthly_video_quota, subscription_status, tier, coalesce(render_credits,0)
    into v_used, v_quota, v_status, v_tier, v_credits
  from public.profiles where user_id = p_user_id for update;
  if not found then return; end if;

  if v_used < v_quota and (v_status in ('trialing','active') or v_tier = 'trial') then
    -- Covered by subscription / trial quota.
    update public.profiles
    set videos_used_this_month = coalesce(videos_used_this_month,0) + v_n,
        trial_renders_used = case when tier='trial'
          then coalesce(trial_renders_used,0) + v_n else trial_renders_used end
    where user_id = p_user_id;
  else
    -- Consume purchased credits (floor 0).
    update public.profiles
    set render_credits = greatest(coalesce(render_credits,0) - v_n, 0)
    where user_id = p_user_id;
  end if;
end;
$$;
revoke all on function public.increment_render_usage(uuid, integer) from public, anon, authenticated;


-- ============================================================
-- 15_usage_ledger_fix.sql
-- ============================================================
-- 15_usage_ledger_fix.sql
-- v26.7 BUGFIX: consume/refund asymmetry.
--
-- Before this: increment_render_usage (mig 14) consumed subscription quota
-- when available, else purchased credits. refund_render_credit (mig 12)
-- ALWAYS restored quota (videos_used -= 1). Result:
--   * A one-off buyer whose render failed lost the $100 credit forever
--     (refund touched quota they don't use, not the credit consumed).
--   * 60s renders consumed 2 credits but refunded only 1.
--
-- Fix: a per-job ledger records exactly what each render consumed (quota
-- vs credits, and how many). Refund reverses precisely. Both ops are now
-- idempotent per job_id, so a proxy retry or double-fired webhook is safe.

create table if not exists public.render_usage_ledger (
  job_id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  consumed text not null check (consumed in ('quota','credit')),
  credits integer not null,
  refunded boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.render_usage_ledger enable row level security;
drop policy if exists "usage_ledger_select_own" on public.render_usage_ledger;
create policy "usage_ledger_select_own"
  on public.render_usage_ledger for select using (auth.uid() = user_id);

-- Consume: decide quota vs credit, apply, and JOURNAL it. Idempotent per
-- job_id — a duplicate submit can't double-charge.
create or replace function public.increment_render_usage(
  p_user_id uuid,
  p_credits integer default 1,
  p_job_id text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_used integer; v_quota integer; v_status text; v_tier text;
  v_n integer := greatest(p_credits, 1);
  v_consumed text;
begin
  -- Idempotency: if this job already has a ledger row, do nothing.
  if p_job_id is not null and exists (select 1 from public.render_usage_ledger where job_id = p_job_id) then
    return;
  end if;

  select videos_used_this_month, monthly_video_quota, subscription_status, tier
    into v_used, v_quota, v_status, v_tier
  from public.profiles where user_id = p_user_id for update;
  if not found then return; end if;

  if v_used < v_quota and (v_status in ('trialing','active') or v_tier = 'trial') then
    v_consumed := 'quota';
    update public.profiles
    set videos_used_this_month = coalesce(videos_used_this_month,0) + v_n,
        trial_renders_used = case when tier='trial'
          then coalesce(trial_renders_used,0) + v_n else trial_renders_used end
    where user_id = p_user_id;
  else
    v_consumed := 'credit';
    update public.profiles
    set render_credits = greatest(coalesce(render_credits,0) - v_n, 0)
    where user_id = p_user_id;
  end if;

  if p_job_id is not null then
    insert into public.render_usage_ledger (job_id, user_id, consumed, credits)
    values (p_job_id, p_user_id, v_consumed, v_n)
    on conflict (job_id) do nothing;
  end if;
end;
$$;
revoke all on function public.increment_render_usage(uuid, integer, text) from public, anon, authenticated;

-- Refund: reverse exactly what the ledger says this job consumed. Idempotent
-- (marks refunded=true). If there's no ledger row (older render, or usage
-- never counted), fall back to the legacy quota restore so we never silently
-- skip a promised refund.
create or replace function public.refund_render_credit(
  p_user_id uuid,
  p_job_id text,
  p_error_code text default null
)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v_consumed text; v_credits integer; v_refunded boolean;
begin
  select consumed, credits, refunded
    into v_consumed, v_credits, v_refunded
  from public.render_usage_ledger where job_id = p_job_id for update;

  if found then
    if v_refunded then return false; end if; -- already refunded
    if v_consumed = 'credit' then
      update public.profiles set render_credits = coalesce(render_credits,0) + v_credits
        where user_id = p_user_id;
    else
      update public.profiles set videos_used_this_month = greatest(coalesce(videos_used_this_month,0) - v_credits, 0)
        where user_id = p_user_id;
    end if;
    update public.render_usage_ledger set refunded = true where job_id = p_job_id;
    return true;
  end if;

  -- No ledger row — legacy fallback (restore one quota unit). Guard against
  -- double-refund via the existing render_credit_refunds journal (mig 12).
  declare v_rows integer;
  begin
    insert into public.render_credit_refunds (job_id, user_id, error_code)
    values (p_job_id, p_user_id, p_error_code)
    on conflict (job_id) do nothing;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then return false; end if; -- already refunded
    update public.profiles set videos_used_this_month = greatest(coalesce(videos_used_this_month,0) - 1, 0)
      where user_id = p_user_id;
    return true;
  end;
end;
$$;
revoke all on function public.refund_render_credit(uuid, text, text) from public, anon, authenticated;


