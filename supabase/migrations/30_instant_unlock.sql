-- Migration 30 — v55 instant unlock ($39 → clean master, zero wait)
--
-- Context: both real customers who reached the $39 Stripe checkout this
-- week abandoned it, because nothing promised the purchase applied to the
-- watermarked video already in their library. v55 renders every trial
-- master CLEAN, stores it alongside the marked deliverable, and flips the
-- library to the clean URL the moment the webhook sees the payment.
--
--   master_clean_url  set by the render worker at upload time (trial
--                     renders only; paid renders have no mark and no
--                     clean twin).
--   unlocked_at       stamped by api/stripe-webhook.js on a paid PAYG
--                     checkout; api/library.js serves master_clean_url
--                     instead of master_mp4_url when present.
--
-- Deploy order is safe in any sequence: the worker's audit insert retries
-- without these columns if the migration hasn't run yet, and the webhook
-- falls back to the legacy re-render email.

alter table public.render_audit_log
  add column if not exists master_clean_url text,
  add column if not exists unlocked_at timestamptz;

comment on column public.render_audit_log.master_clean_url is
  'v55: unwatermarked master uploaded alongside the marked trial deliverable; served by the library only after unlocked_at is set.';
comment on column public.render_audit_log.unlocked_at is
  'v55: set by the Stripe webhook when a PAYG purchase unlocks the clean master.';
