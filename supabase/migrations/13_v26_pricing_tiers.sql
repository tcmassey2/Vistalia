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
