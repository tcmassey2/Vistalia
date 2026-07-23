-- Migration 34 — v57 listing-link auto-render
--
-- The activation wall: ~90% of Instant Form leads never render, because
-- the product asks phone-first leads to do desktop work (gather + upload
-- 12 photos). The play: the form asks for their current listing's link;
-- for leads who answer, the worker imports the listing (v52 machinery),
-- plans it, and submits their free video on their behalf through the
-- normal tier machinery — the welcome experience becomes "your video is
-- ready" instead of "come do work."
--
--   listing_url         captured by meta-leads-sync from the form answer
--                       (URL-validated; plain street addresses stay in
--                       `raw` and don't trigger auto-render).
--   auto_render_at      claim stamp — the worker pass processes one
--                       pending lead per tick, claim-first.
--   auto_render_status  imported | planned | submitted | failed:<reason>
--   auto_render_job_id  the render job that carried their free video.
--
-- Apply via Supabase Dashboard → SQL Editor. Safe to run multiple times.

alter table public.meta_leads
  add column if not exists listing_url text,
  add column if not exists auto_render_at timestamptz,
  add column if not exists auto_render_status text,
  add column if not exists auto_render_job_id text;

comment on column public.meta_leads.listing_url is
  'v57: listing link from the Instant Form question; presence + user_id triggers the worker auto-render pass.';
