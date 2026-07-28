-- v62.63 — lead auto-render retry-with-backoff (Troy: "a system that
-- recovers like that is important").
--
-- The Jul 27 ScraperAPI outage exposed the one-shot design: every lead
-- whose auto-render ran during the ~3-hour supplier incident was marked
-- failed:* permanently — the exact hours an ad campaign delivers leads
-- are the hours a one-shot pipeline quietly buries them. The worker now
-- retries TRANSIENT failures (import short, plan fallback/5xx, submit
-- 5xx, network exceptions) up to 3 times at +15m, +1h, +4h. Semantic
-- rejections (submit 4xx: tier exhausted, validation) stay terminal.
--
-- Additive only; no money paths. Without this migration the worker
-- detects the missing columns and degrades to the old one-shot behavior.

alter table public.meta_leads
  add column if not exists auto_render_attempts integer not null default 0;

alter table public.meta_leads
  add column if not exists auto_render_next_at timestamptz;

-- The due-retry poll is `status like 'retry:%' and next_at <= now()`,
-- ordered by next_at — a partial index keeps it free no matter how many
-- terminal leads accumulate.
create index if not exists meta_leads_auto_render_next_at_idx
  on public.meta_leads (auto_render_next_at)
  where auto_render_next_at is not null;
