-- v62.97 — founder-portal baby CRM (Troy: "click on the lead, see where
-- they came from, what they sent in, if they have been contacted").
--
-- Two founder-only columns on meta_leads so the portal's lead dossier can
-- track Troy's manual outreach alongside the machine touches (welcome,
-- nudge, auto-render) that already live on the row:
--   contacted_at  — when Troy marked the lead contacted (null = not yet)
--   contact_note  — freeform founder note (what he sent, what they said)
--
-- Written only by /api/founder-lead behind METRICS_TOKEN; never read by
-- the product. Additive only. Without this migration the endpoint answers
-- {status:"migration_needed"} and the portal shows which SQL to run.

alter table public.meta_leads
  add column if not exists contacted_at timestamptz;

alter table public.meta_leads
  add column if not exists contact_note text;
