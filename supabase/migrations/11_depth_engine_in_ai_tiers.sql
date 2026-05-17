-- EstateMotion — add the depth engine to AI tier entitlements.
--
-- The Cinematic Depth engine (depth-based 2.5D parallax) shipped after
-- migration 02, so it wasn't in any tier's available_engines array.
-- Result: even on the highest-paid tier (cinematic_4k) the render gate
-- rejected any engine='depth' request with the misleading error
-- "Cinematic AI requires the Cinematic AI plan or higher".
--
-- Add 'depth' to both AI tiers. Quick Reel and trial stay locked to
-- remotion-only — depth is a paid feature.

update public.tier_plans
  set available_engines = array['remotion', 'runway', 'depth']
  where tier in ('cinematic_ai', 'cinematic_4k');

-- get_user_tier_state() reads tier_plans live (not cached), so the new
-- entitlement applies on the very next render request — no need to
-- refresh any materialized views or restart any services.
