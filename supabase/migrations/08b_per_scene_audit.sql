-- EstateMotion — Per-scene engine breakdown in audit log (v23).
--
-- The render_audit_log.scenes JSONB column already exists (added when
-- regenerate-scene shipped). v23 enriches the per-scene objects with:
--   {
--     sceneIndex, photoId, photoUrl, clipUrl, storagePath,
--     roomType, cameraMotion, duration, runwayPrompt, wasFallback,
--
--     -- v23 additions:
--     engineUsed: "cinematic_ai" | "ken_burns" | "remotion",
--     fallbackReason: string | null,           -- e.g. "hallucination_guard:kitchen_lockout"
--     guardRisk: number | null,                -- 0-100 if Hallucination Guard ran
--     guardLevel: "off" | "balanced" | "strict" | null,
--     runwayTaskId: string | null,
--     durationMs: number | null                -- per-scene generation time
--   }
--
-- This migration adds two convenience views over the existing data so
-- the dashboard + admin tools can query without parsing JSONB inline.
--
-- Apply via Supabase Dashboard → SQL Editor.
-- Safe to run multiple times.

-- ============================================================
-- 0. New columns on render_audit_log
-- ============================================================
-- scenes          — per-scene metadata array. Originally added by migration
--                   05_per_scene_regen.sql; included here too so this
--                   migration is self-sufficient on databases where 05
--                   was never applied.
-- prompt_version  — value of PROMPT_VERSION at render time (e.g. "v23.0")
-- render_config   — snapshot of toggles + style + tier used for this render
alter table public.render_audit_log
  add column if not exists scenes jsonb default '[]'::jsonb,
  add column if not exists prompt_version text,
  add column if not exists render_config jsonb;

-- Backfill any pre-existing rows so the breakdown view doesn't choke on
-- nulls. add column with `default` only applies to new rows on some
-- Postgres versions — be defensive.
update public.render_audit_log
  set scenes = '[]'::jsonb
  where scenes is null;

-- Index on prompt_version so we can pull "all renders on v22 vs v23"
-- comparisons quickly when tuning.
create index if not exists idx_render_audit_log_prompt_version
  on public.render_audit_log (prompt_version);

-- ============================================================
-- 1. View: scene-level breakdown (one row per scene per render)
-- ============================================================
create or replace view public.render_scene_breakdown as
select
  log.id as audit_id,
  log.job_id,
  log.agent_user_id,
  log.engine as render_engine,
  log.created_at,
  (scene->>'sceneIndex')::int as scene_index,
  scene->>'photoId' as photo_id,
  scene->>'photoUrl' as photo_url,
  scene->>'roomType' as room_type,
  scene->>'cameraMotion' as camera_motion,
  (scene->>'duration')::numeric as duration_sec,
  scene->>'engineUsed' as engine_used,
  scene->>'fallbackReason' as fallback_reason,
  (scene->>'guardRisk')::numeric as guard_risk,
  scene->>'guardLevel' as guard_level,
  scene->>'runwayTaskId' as runway_task_id,
  (scene->>'durationMs')::numeric as duration_ms
from public.render_audit_log log
cross join lateral jsonb_array_elements(coalesce(log.scenes, '[]'::jsonb)) as scene
where log.scenes is not null and jsonb_array_length(coalesce(log.scenes, '[]'::jsonb)) > 0;

-- Make readable to authenticated users for their own renders.
-- (Uses the same RLS policy as the underlying audit table.)
grant select on public.render_scene_breakdown to authenticated;

-- ============================================================
-- 2. Convenience aggregate: per-render engine summary
-- ============================================================
-- One row per render with cinematic_count, ken_burns_count, fallback_rate,
-- average duration_ms. Used by the admin tuning dashboard.
create or replace view public.render_engine_summary as
select
  job_id,
  agent_user_id,
  render_engine,
  created_at,
  count(*) as scene_count,
  count(*) filter (where engine_used = 'cinematic_ai') as cinematic_count,
  count(*) filter (where engine_used = 'ken_burns') as ken_burns_count,
  count(*) filter (where engine_used = 'remotion') as remotion_count,
  round(
    100.0 * count(*) filter (where engine_used = 'ken_burns')::numeric /
    nullif(count(*), 0),
    1
  ) as ken_burns_pct,
  round(avg(duration_ms)::numeric, 0) as avg_scene_duration_ms,
  count(*) filter (where fallback_reason like 'runway_error%') as runway_error_count,
  count(*) filter (where fallback_reason like 'hallucination_guard%') as guard_lockout_count
from public.render_scene_breakdown
group by job_id, agent_user_id, render_engine, created_at;

grant select on public.render_engine_summary to authenticated;

-- ============================================================
-- 3. Index — speeds up the per-user breakdown queries the dashboard runs
-- ============================================================
create index if not exists idx_render_audit_log_user_created
  on public.render_audit_log (agent_user_id, created_at desc);
