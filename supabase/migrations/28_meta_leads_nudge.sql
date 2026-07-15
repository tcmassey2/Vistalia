-- 28: one-shot nudge tracking for Instant Form leads.
-- nudged_at set when the "still waiting" follow-up goes out (or when the
-- lead is claimed-and-skipped because they already rendered — either way,
-- never touched twice). The claim-first PATCH on nudged_at IS NULL is the
-- same distributed-lock trick as the insert in migration 27.

alter table public.meta_leads
  add column if not exists nudged_at timestamptz;
