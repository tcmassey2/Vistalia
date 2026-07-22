-- Migration 32 — v54.1 the free video never expires
--
-- Context: the landing page and every ad promise "first video free" with
-- no time limit, but get_user_tier_state (last recreated in migration 24)
-- still carried the 7-day clock from the retired pre-launch trial model:
-- can_render flipped false at now() > trial_ends_at even for accounts
-- that never used their free video. Real-estate cadence is listing-driven
-- — an agent who signed up in July activates when they GET a listing, not
-- within a calendar week — so the expiry burned the long tail of the lead
-- pool for zero revenue and contradicted the public promise.
--
-- This recreates the function identically minus the two date conditions.
-- The free-render cap (1 video), monthly quotas, credit checks, and
-- subscription states are unchanged. trial_ends_at stays in the return
-- shape (callers read rows generically; nothing gates on it anymore) and
-- the v54.1 free-video email ladder still uses it as a signup-day anchor.
--
-- Apply via Supabase Dashboard → SQL Editor. Safe to run multiple times.

drop function if exists public.get_user_tier_state(uuid);
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
        and not (p.tier = 'trial' and p.trial_renders_used >= c.trial_render_cap)
      )
    ) as can_render,
    case
      when coalesce(p.render_credits,0) >= 1 then null
      when p.subscription_status = 'past_due' then 'Subscription past due — update payment to continue rendering.'
      when p.subscription_status = 'canceled' then 'Subscription canceled.'
      when p.tier = 'trial' and p.trial_renders_used >= c.trial_render_cap then
        'You''ve used your free video. Buy one for $39 or pick a plan to keep rendering.'
      when p.videos_used_this_month >= p.monthly_video_quota then
        'Monthly video quota reached. Add extra videos for $12 each, upgrade, or wait until next cycle.'
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

revoke all on function public.get_user_tier_state(uuid) from public, anon, authenticated;
