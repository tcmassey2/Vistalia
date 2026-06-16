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
