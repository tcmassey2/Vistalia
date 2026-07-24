-- 34_engine_check_allow_kling.sql
-- ============================================================
-- FIX: audit rows silently dropped for every Kling render (Jul 24 2026).
--
-- Same failure class as migration 21, new engine: v60.4 started writing
-- engine='kling' (truthful certificate provenance for the Kling V3 cutover)
-- but the CHECK constraints migration 21 set allow only
-- ('remotion','runway','veo','depth'). Every audit INSERT with 'kling'
-- fails 23514, fire-and-forget, so the founder portal and customer library
-- never see the render — the exact symptom that burned the whole night of
-- Jul 23. Widen the set on all three tables.
-- ============================================================

begin;

alter table if exists public.render_audit_log
  drop constraint if exists render_audit_log_engine_check;
alter table if exists public.render_audit_log
  add constraint render_audit_log_engine_check
  check (engine in ('remotion', 'runway', 'veo', 'depth', 'kling'));

alter table if exists public.render_usage
  drop constraint if exists render_usage_engine_check;
alter table if exists public.render_usage
  add constraint render_usage_engine_check
  check (engine in ('remotion', 'runway', 'veo', 'depth', 'kling'));

alter table if exists public.render_jobs
  drop constraint if exists render_jobs_engine_check;
alter table if exists public.render_jobs
  add constraint render_jobs_engine_check
  check (engine is null or engine in ('remotion', 'runway', 'veo', 'depth', 'kling'));

commit;
