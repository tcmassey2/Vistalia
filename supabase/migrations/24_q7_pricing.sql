-- 24: q7 pricing (docs/PRICING_Q7.md), 2026-07-01.
--
-- Monthly raised (Pro $49→$69, Studio $99→$149); annual HELD at $490/$990;
-- quotas unchanged (5/10 credits, 60s video = 2 credits — enforced in
-- api/render.js since v26.5). Overage = $12/credit via checkout `overage`
-- SKU → existing grant_render_credits path. This migration only:
--   1. documents the new monthly prices in tier_plans.price_cents
--      (Stripe remains the source of truth at checkout), and
--   2. refreshes get_user_tier_state()'s user-facing reason strings, which
--      still quoted the retired $100 single video.

-- 1. New monthly prices.
update public.tier_plans set price_cents = 6900  where tier = 'pro';
update public.tier_plans set price_cents = 14900 where tier = 'studio';

-- 2. Same function as migration 14, reason copy updated for q7
--    ($39 payg replaces the $100 single; quota-reached mentions $12 overage).
--    DROP first: the live function's return row differs from migration 14 as
--    written (Postgres 42P13 — cannot change return type via CREATE OR
--    REPLACE). Same precedent as migration 07. All API callers read the row
--    generically or use fields this shape provides, so the drop is safe.
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
