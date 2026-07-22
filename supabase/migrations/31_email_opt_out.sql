-- Migration 31 — v54.1 one-click email opt-out
--
-- Context: the retired trial-expiry ladder (v53.6) had no way for a
-- recipient to say "stop" short of writing to the founder — a Fox & Roach
-- agent did exactly that. Every lead-flow email now carries a signed
-- opt-out link (api/email-opt-out.js) that flips this flag; the free-video
-- ladder, lead nudge, and post-render upsell all check it before sending.
--
-- Apply via Supabase Dashboard → SQL Editor. Safe to run multiple times.

alter table public.profiles
  add column if not exists email_opt_out boolean not null default false;

comment on column public.profiles.email_opt_out is
  'v54.1: set by api/email-opt-out.js (signed one-click link in every lead-flow email). When true, no marketing-flavored email is ever sent; transactional render-complete emails still go out.';
