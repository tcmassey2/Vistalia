-- Vistalia — live schema verification.
-- Paste into Supabase → SQL Editor → Run. Read-only; changes nothing.
-- Tells you whether your production DB matches supabase/MIGRATIONS.md.

-- 1) Core tables present? (expect all = true)
select
  to_regclass('public.profiles')          is not null as profiles,
  to_regclass('public.tier_plans')        is not null as tier_plans,
  to_regclass('public.render_usage')      is not null as render_usage,
  to_regclass('public.organizations')     is not null as organizations,
  to_regclass('public.render_audit_log')  is not null as render_audit_log,
  to_regclass('public.render_jobs')       is not null as render_jobs,
  to_regclass('public.brand_kits')        is not null as brand_kits;

-- 2) Engine CHECK constraints — after migration 21 each should list veo + depth.
--    If any still reads just (remotion, runway) → migration 21 not applied there.
select conrelid::regclass as table_name, pg_get_constraintdef(oid) as engine_check
from pg_constraint
where contype = 'c' and conname like '%engine_check%'
order by 1;

-- 3) render_audit_log has the scenes JSONB column? (regen + Edit Studio rely on it)
select exists(
  select 1 from information_schema.columns
  where table_schema='public' and table_name='render_audit_log' and column_name='scenes'
) as audit_has_scenes_column;

-- 4) Are audit rows actually landing now? Counts by engine + newest timestamp.
--    After migration 21 + one fresh render you should see an 'veo' row here.
select engine, count(*) as rows, max(created_at) as newest
from public.render_audit_log
group by engine
order by rows desc;

-- 5) AI-tier engine entitlements (does 'veo' appear? see MIGRATIONS.md note).
select tier, available_engines
from public.tier_plans
order by tier;
