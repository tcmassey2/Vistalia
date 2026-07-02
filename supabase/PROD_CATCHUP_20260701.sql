-- PROD CATCH-UP — 2026-07-01. Run once in Supabase SQL editor.
-- Discovered during launch prep: migrations 12/14/15 (credit system) were
-- never applied to production — profiles.render_credits didn't exist, so
-- payg grants, overage, ledgered usage, and refunds were all broken live.
-- This script applies 12+14+15 (superseded pieces skipped), then 24 (q7
-- pricing) and 25 (heartbeat requeue). Everything is idempotent.

-- ══════════ from 12: refund journal table ══════════
create table if not exists public.render_credit_refunds (
  id uuid primary key default gen_random_uuid(),
  job_id text not null unique,
  user_id uuid not null references auth.users (id) on delete cascade,
  reason text not null default 'render_failed',
  error_code text,
  refunded_at timestamptz not null default now()
);
alter table public.render_credit_refunds enable row level security;
drop policy if exists "refunds_select_own" on public.render_credit_refunds;
create policy "refunds_select_own"
  on public.render_credit_refunds for select using (auth.uid() = user_id);

-- ══════════ from 14: credits column, grants table, grant fn ══════════
alter table public.profiles
  add column if not exists render_credits integer not null default 0;

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
  p_user_id uuid, p_credits integer, p_session_id text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_rows integer := 0;
begin
  insert into public.credit_grants (stripe_session_id, user_id, credits)
  values (p_session_id, p_user_id, p_credits)
  on conflict (stripe_session_id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return false; end if;
  update public.profiles
  set render_credits = coalesce(render_credits, 0) + greatest(p_credits, 0)
  where user_id = p_user_id;
  return true;
end; $$;
revoke all on function public.grant_render_credits(uuid, integer, text) from public, anon, authenticated;

-- ══════════ from 15: usage ledger + consume/refund (final versions) ══════════
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

drop function if exists public.increment_render_usage(uuid, integer);
drop function if exists public.increment_render_usage(uuid, integer, text);
create function public.increment_render_usage(
  p_user_id uuid, p_credits integer default 1, p_job_id text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_used integer; v_quota integer; v_status text; v_tier text;
  v_n integer := greatest(p_credits, 1);
  v_consumed text;
begin
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
end; $$;
revoke all on function public.increment_render_usage(uuid, integer, text) from public, anon, authenticated;

drop function if exists public.refund_render_credit(uuid, text, text);
create function public.refund_render_credit(
  p_user_id uuid, p_job_id text, p_error_code text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_consumed text; v_credits integer; v_refunded boolean; v_rows integer;
begin
  select consumed, credits, refunded
    into v_consumed, v_credits, v_refunded
  from public.render_usage_ledger where job_id = p_job_id for update;

  if found then
    if v_refunded then return false; end if;
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

  insert into public.render_credit_refunds (job_id, user_id, error_code)
  values (p_job_id, p_user_id, p_error_code)
  on conflict (job_id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return false; end if;
  update public.profiles set videos_used_this_month = greatest(coalesce(videos_used_this_month,0) - 1, 0)
    where user_id = p_user_id;
  return true;
end; $$;
revoke all on function public.refund_render_credit(uuid, text, text) from public, anon, authenticated;

-- ══════════ 24: q7 pricing ══════════
update public.tier_plans set price_cents = 6900  where tier = 'pro';
update public.tier_plans set price_cents = 14900 where tier = 'studio';

drop function if exists public.get_user_tier_state(uuid);
create function public.get_user_tier_state(p_user_id uuid)
returns table (
  tier text, monthly_video_quota integer, videos_used_this_month integer,
  available_engines text[], can_render boolean, reason text,
  trial_ends_at timestamptz, trial_renders_used integer, trial_render_cap integer,
  current_period_end timestamptz, subscription_status text, render_credits integer
)
language sql security definer as $$
  with constants as (select 1::integer as trial_render_cap)
  select
    p.tier, p.monthly_video_quota, p.videos_used_this_month,
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
        'Your free trial has ended. Buy a video for $39 or pick a plan to keep rendering.'
      when p.tier = 'trial' and p.trial_renders_used >= c.trial_render_cap then
        'You''ve used your free trial video. Buy one for $39 or pick a plan to keep rendering.'
      when p.videos_used_this_month >= p.monthly_video_quota then
        'Monthly video quota reached. Add extra videos for $12 each, upgrade, or wait until next cycle.'
      else null
    end as reason,
    p.trial_ends_at, p.trial_renders_used, c.trial_render_cap,
    p.current_period_end, p.subscription_status,
    coalesce(p.render_credits, 0) as render_credits
  from public.profiles p
  left join public.tier_plans tp on tp.tier = p.tier
  cross join constants c
  where p.user_id = p_user_id;
$$;
revoke all on function public.get_user_tier_state(uuid) from public, anon, authenticated;

-- ══════════ 25: heartbeat-based stuck-job requeue ══════════
alter table public.render_jobs add column if not exists heartbeat_at timestamptz;

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
          claimed_at = null,
          heartbeat_at = null
      where status = 'rendering'
        and claimed_at is not null
        and coalesce(heartbeat_at, claimed_at) < now() - make_interval(mins => p_timeout_minutes)
      returning 1
  )
  select count(*) into n from bumped;
  return n;
end $$;

-- ══════════ existence report — eyeball for anything still missing ══════════
select 'tier_plans q7' as check_item,
       (select count(*) from public.tier_plans where tier in ('pro','studio') and price_cents in (6900,14900)) = 2 as ok
union all select 'profiles.render_credits', exists (
  select 1 from information_schema.columns where table_name='profiles' and column_name='render_credits')
union all select 'render_usage_ledger', to_regclass('public.render_usage_ledger') is not null
union all select 'credit_grants', to_regclass('public.credit_grants') is not null
union all select 'render_credit_refunds', to_regclass('public.render_credit_refunds') is not null
union all select 'render_jobs.claimed_at (mig 23)', exists (
  select 1 from information_schema.columns where table_name='render_jobs' and column_name='claimed_at')
union all select 'render_jobs.heartbeat_at (mig 25)', exists (
  select 1 from information_schema.columns where table_name='render_jobs' and column_name='heartbeat_at')
union all select 'claim_render_job fn (mig 23)', exists (
  select 1 from pg_proc where proname='claim_render_job')
union all select 'grant_render_credits fn', exists (
  select 1 from pg_proc where proname='grant_render_credits')
union all select 'increment_render_usage fn', exists (
  select 1 from pg_proc where proname='increment_render_usage')
union all select 'refund_render_credit fn', exists (
  select 1 from pg_proc where proname='refund_render_credit')
union all select 'get_user_tier_state fn', exists (
  select 1 from pg_proc where proname='get_user_tier_state')
union all select 'brand_kits RLS enabled', coalesce((
  select relrowsecurity from pg_class where oid = to_regclass('public.brand_kits')), false);
