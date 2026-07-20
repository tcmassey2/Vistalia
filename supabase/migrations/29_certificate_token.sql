-- Vistalia — v51 MLS-Safe Certificate (migration 29)
--
-- Every render gets an unguessable public token; vistalia.ai/v/<token>
-- renders the verification certificate: each delivered scene beside its
-- source photo with its verification status. The audit row already holds
-- everything else (scenes jsonb incl. v49 engineUsed/attempts, listing
-- address, master urls) — this adds only the public handle.
--
-- Apply via Supabase Dashboard → SQL Editor. Safe to run multiple times.

alter table public.render_audit_log
  add column if not exists certificate_token text;

-- Backfill existing rows. gen_random_uuid() is core Postgres 13+; 20 hex
-- chars of a v4 UUID ≈ 80 bits of entropy — unguessable at any realistic
-- request rate.
update public.render_audit_log
  set certificate_token = substr(replace(gen_random_uuid()::text, '-', ''), 1, 20)
  where certificate_token is null;

create unique index if not exists idx_render_audit_certificate_token
  on public.render_audit_log (certificate_token);
