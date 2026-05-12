-- EstateMotion — Per-scene regenerate support
--
-- Adds a `scenes` JSONB column to render_audit_log so each render
-- persists its per-scene metadata: photo URLs, clip URLs, room types,
-- camera motion, runway prompts. This lets the regenerate-scene
-- endpoint re-roll a single bad scene without re-running all 24.
--
-- Apply via Supabase Dashboard → SQL Editor.
-- Safe to run multiple times (IF NOT EXISTS).

alter table public.render_audit_log
  add column if not exists scenes jsonb default '[]'::jsonb;

-- Each scenes entry looks like:
--   {
--     "sceneIndex": 0,
--     "photoId": "photo-abc",
--     "photoUrl": "https://...supabase.../listing.jpg",
--     "clipUrl": "https://...supabase.../scene-000.mp4",
--     "roomType": "kitchen",
--     "cameraMotion": "push_in",
--     "duration": 5,
--     "runwayPrompt": "Slow cinematic camera push...",
--     "wasFallback": false  // true = Ken Burns, false = real Runway clip
--   }
--
-- The worker uploads each per-scene clip to Supabase Storage with a
-- predictable filename (scene-000.mp4 through scene-023.mp4) inside the
-- same job folder as the master + variants + shorts.
--
-- On regenerate, the API + worker:
--   1. Look up the original audit row by job_id
--   2. Read the scenes array
--   3. Generate ONE new clip for the target sceneIndex
--   4. Download the other 23 clip URLs from Supabase
--   5. Re-stitch with the new clip in position
--   6. Re-derive variants + shorts
--   7. Upload the new master and update the audit row's master_mp4_url

comment on column public.render_audit_log.scenes is
  'Per-scene metadata array. Each element is { sceneIndex, photoId, photoUrl, clipUrl, roomType, cameraMotion, duration, runwayPrompt, wasFallback }. Used by /api/regenerate-scene to swap a single bad scene without full re-render.';
