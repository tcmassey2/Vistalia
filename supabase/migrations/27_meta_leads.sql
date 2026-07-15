-- 27: Meta Instant Form leads ledger.
--
-- Every lead pulled from the Graph API lands here exactly once (PK = Meta's
-- lead id). The insert-first-with-ignore-duplicates pattern doubles as a
-- distributed lock: multiple worker instances can ping /api/meta-leads-sync
-- concurrently, and only the instance whose INSERT actually created the row
-- proceeds to provision + email. RLS on, no anon policies — service role only.

create table if not exists public.meta_leads (
  lead_id      text primary key,          -- Meta leadgen_id
  form_id      text not null,
  email        text not null,
  full_name    text,
  licensed     boolean,                   -- "Are you a licensed agent?" = Yes
  raw          jsonb,                     -- full field_data payload, audit
  user_id      uuid,                      -- auth.users id after provisioning
  user_created boolean not null default false,  -- false = account pre-existed
  emailed_at   timestamptz,               -- welcome email sent
  created_time timestamptz,               -- Meta's lead submit time
  inserted_at  timestamptz not null default now()
);

create index if not exists meta_leads_email_idx on public.meta_leads (email);

alter table public.meta_leads enable row level security;
-- Intentionally no policies: only the service role (bypasses RLS) touches this.
