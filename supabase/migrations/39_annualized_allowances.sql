-- Migration 39 — v62.81: annualized allowances, entry tier repriced.
--
-- THE BUG WAS THE PRICING, NOT THE MARKET. For an agent with one listing a
-- month — which is what this market gives most of them — the old page argued
-- against itself:
--
--     pay as you go   $39/video      → 12 videos/yr = $468/yr
--     Pro monthly     $69/mo         → 12 videos/yr = $828/yr  ($69 per video used)
--     Pro annual      $490/yr        → 12 videos/yr = $490/yr  ($41 per video used)
--
-- Subscribing was strictly WORSE than paying per video. Nobody was ever going
-- to convert, and no amount of marketing was going to fix a page that tells a
-- low-volume buyer to choose the one-off. AutoReel's entry tier ($30/mo for 25
-- videos a YEAR) is priced for exactly this buyer, which is how they reach
-- 10k users in a market where the median agent lists once a month.
--
-- New shape — the allowance is annual so a busy spring borrows from a quiet
-- winter, and the entry price sits BELOW the cost of a single one-off video:
--
--     Pro     $29/mo ($290/yr)   36 videos/yr   → $9.67/video ($8.06 annual)
--     Studio  $99/mo ($990/yr)  144 videos/yr   → $8.25/video ($6.88 annual)
--
-- ENFORCEMENT NOTE. get_user_tier_state still gates on the MONTHLY counter
-- (videos_used_this_month < monthly_video_quota) — that predicate is load
-- bearing across three migrations and this is not the night to rewrite it.
-- So monthly_video_quota becomes a FAIR-USE CEILING, set above any honest
-- month's usage but below the annual total, and the annual number is the
-- promise on the page:
--
--     Pro    ceiling 6/mo   (annual promise 36 — a 3-listing month never hits it)
--     Studio ceiling 20/mo  (annual promise 144)
--
-- Worst-case margin holds: a Pro subscriber burning all 36 costs ~$144 in
-- render spend against $348 collected (59%); typical usage of ~12 videos is
-- ~86%. Studio at full 144 is ~$576 against $1,188 (51%).
--
-- SAFE TO RUN: there are currently zero paying subscribers, so no existing
-- allowance shrinks under anyone. Re-runnable.
--
-- ⚠️ THIS MIGRATION DOES NOT TOUCH STRIPE. Stripe remains the source of truth
-- at checkout — price_cents here is documentation. The new prices are not live
-- until the Stripe products are updated by hand and their price IDs wired into
-- create-checkout-session. Do that BEFORE announcing anything.

begin;

update public.tier_plans
   set price_cents         = 2900,
       monthly_video_quota = 6
 where tier = 'pro';

update public.tier_plans
   set price_cents         = 9900,
       monthly_video_quota = 20
 where tier = 'studio';

-- Reconcile any profile rows carrying the old per-user quota (no-op at zero
-- subscribers, correct if one slipped in).
update public.profiles set monthly_video_quota = 6  where tier = 'pro';
update public.profiles set monthly_video_quota = 20 where tier = 'studio';

commit;

-- Verify:
--   select tier, display_name, price_cents, monthly_video_quota
--     from public.tier_plans where tier in ('pro','studio');
