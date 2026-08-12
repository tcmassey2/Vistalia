-- 40: pre-scale security hardening (founder asked to lock everything down
-- before turning up ad spend). Additive / idempotent; no data migration.
--
-- Five holes, all closable in pure SQL. Every fix leaves the SERVICE-ROLE
-- paths untouched — the Stripe webhook, the render endpoint, and
-- /api/organization all call in with the service key, which bypasses both
-- REVOKE and RLS. So nothing the app does legitimately changes; only the
-- browser's public anon key loses reach it never should have had.
--
-- Verified on a scratch Postgres 16 before shipping: anon RPCs denied,
-- cross-user selects empty, credit self-escalation rejected, brand_kits and
-- the audit views locked to their owner.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Anon-callable SECURITY DEFINER RPCs that migration 36 missed.
--
-- 36 swept the render-queue functions but left three from migrations 04 and
-- 07. Postgres grants EXECUTE to PUBLIC by default and Supabase exposes
-- public-schema RPCs to the anon key that ships in every browser, so today:
--   • clear_trial_state(uuid)      resets trial_renders_used to 0 for ANY
--     user id → unlimited free renders, and trial griefing of others.
--   • increment_trial_render(uuid) burns any victim's free-render counter.
--   • get_user_organization(uuid)  returns any user's brokerage name, tier,
--     seat counts, and STATE REAL-ESTATE LICENSE NUMBER.
-- All three are only ever invoked server-side with the service key
-- (stripe-webhook, /api/render, /api/organization), so the revoke is
-- invisible to the product. is_org_admin(uuid,uuid) is deliberately NOT
-- revoked — it is evaluated inside the organizations / organization_members
-- RLS policies, and pulling EXECUTE would break them for legitimate users.
revoke all on function public.clear_trial_state(uuid)      from public, anon, authenticated;
revoke all on function public.increment_trial_render(uuid) from public, anon, authenticated;
revoke all on function public.get_user_organization(uuid)  from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. brand_kits never had RLS asserted in any migration.
--
-- It holds agent PII: full_name, STATE LICENSE NUMBER (06), and the
-- ElevenLabs cloned-voice ids (26). The 20260501 hardening pass re-asserted
-- RLS on users / projects / project_photos / beta_feedback but skipped this
-- table. If RLS was never enabled in the base schema, the public anon key can
-- read every agent's name + license number. Enable + self-scope by user_id
-- (confirmed owner column: api reads brand_kits?user_id=eq.<uid>). Idempotent:
-- enabling RLS when already on is a no-op; drop-then-create resets the policy.
alter table public.brand_kits enable row level security;

drop policy if exists "brand_kits_self_select" on public.brand_kits;
create policy "brand_kits_self_select" on public.brand_kits
  for select using (auth.uid() = user_id);

drop policy if exists "brand_kits_self_write" on public.brand_kits;
create policy "brand_kits_self_write" on public.brand_kits
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The per-scene audit views bypass RLS.
--
-- render_scene_breakdown / render_engine_summary (08b) are plain views, so
-- they execute as their OWNER and bypass render_audit_log's row-level
-- security. Any authenticated user selecting them saw EVERY customer's render
-- history — agent_user_id, per-scene photo_url, city, engine, timings. The
-- migration comment claimed "same RLS as the underlying table," which is false
-- for a non-invoker view. security_invoker makes them honor the CALLER's RLS
-- (so an agent still sees their own scenes); the anon revoke is belt-and-
-- suspenders in case default privileges handed anon SELECT. Guarded so a
-- missing view can't hard-fail the whole migration.
do $$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relname = 'render_scene_breakdown' and c.relkind = 'v') then
    execute 'alter view public.render_scene_breakdown set (security_invoker = on)';
    execute 'revoke select on public.render_scene_breakdown from anon';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relname = 'render_engine_summary' and c.relkind = 'v') then
    execute 'alter view public.render_engine_summary set (security_invoker = on)';
    execute 'revoke select on public.render_engine_summary from anon';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. profiles self-update let users grant themselves render credits.
--
-- The 02 policy pinned tier / quota / stripe columns in its WITH CHECK, but
-- the entitlement columns added later were never pinned: render_credits (14),
-- trial_renders_used (07), videos_used_this_month, subscription_status,
-- current_period_end. get_user_tier_state grants a render when
-- render_credits >= 1, so any logged-in ad signup could run, from the browser
-- with the anon key and their own session:
--     update profiles set render_credits = 999999 where user_id = <self>
-- and mint unlimited paid renders. Extend the existing pin pattern to every
-- entitlement column. is-not-distinct-from is NULL-safe for the nullable ones.
-- These columns are only ever written server-side (Stripe webhook, the
-- increment_trial_render RPC), so pinning them breaks no legitimate edit —
-- name / brokerage / photo / brand-color / opt-out updates still pass.
drop policy if exists "profiles_self_update" on public.profiles;
create policy "profiles_self_update" on public.profiles
  for update using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and tier                   = (select tier                   from public.profiles where user_id = auth.uid())
    and monthly_video_quota    = (select monthly_video_quota    from public.profiles where user_id = auth.uid())
    and stripe_customer_id     is not distinct from (select stripe_customer_id     from public.profiles where user_id = auth.uid())
    and stripe_subscription_id is not distinct from (select stripe_subscription_id from public.profiles where user_id = auth.uid())
    and render_credits         is not distinct from (select render_credits         from public.profiles where user_id = auth.uid())
    and trial_renders_used     is not distinct from (select trial_renders_used     from public.profiles where user_id = auth.uid())
    and videos_used_this_month is not distinct from (select videos_used_this_month from public.profiles where user_id = auth.uid())
    and subscription_status    is not distinct from (select subscription_status    from public.profiles where user_id = auth.uid())
    and current_period_end     is not distinct from (select current_period_end     from public.profiles where user_id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────────────────
-- 5. users self-update had NO column pin at all.
--
-- The 20260501 policy was `with check (auth.uid() = id)` over a table that
-- carries credit_balance and subscription_status — same self-escalation shape
-- as (4). Pin both; email / full_name stay editable.
drop policy if exists "Users can update own profile" on public.users;
create policy "Users can update own profile" on public.users
  for update using (auth.uid() = id)
  with check (
    auth.uid() = id
    and credit_balance      is not distinct from (select credit_balance      from public.users where id = auth.uid())
    and subscription_status is not distinct from (select subscription_status from public.users where id = auth.uid())
  );

-- Verification (run as anon with the published publishable key — all denied):
--   POST /rest/v1/rpc/clear_trial_state       {"p_user_id":"<any>"}   → 403/404
--   POST /rest/v1/rpc/get_user_organization   {"p_user_id":"<any>"}   → 403/404
--   GET  /rest/v1/brand_kits?limit=1                                  → []
--   GET  /rest/v1/render_scene_breakdown?limit=1                      → []
-- As a logged-in user against your OWN row:
--   update profiles set render_credits = 999999                       → 0 rows / denied
--   update profiles set full_name = 'ok'                              → succeeds
