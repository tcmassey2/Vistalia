-- Migration 33 — v56 canary renders + internal segmentation
--
-- RUN THIS BEFORE DEPLOYING v56 (api/metrics.js starts filtering on the
-- new column the moment it deploys).
--
-- 1. canary_state: single-row claim table. On the first boot of a new
--    deploy (RENDER_GIT_COMMIT changes) the worker atomically flips
--    last_commit and fires ONE internal render of the fixed p1-signature
--    photoset through the whole live chain, emailing the founder a
--    [CANARY] gate link. Restarts of the same commit never re-fire.
--
-- 2. render_audit_log.internal: canary + founder smoke-test renders are
--    marked internal and excluded from founder metrics — the "119
--    renders" number was ~100 pre-launch smoke tests, which misdirected
--    a whole funnel diagnosis (Jul 23).

create table if not exists public.canary_state (
  id smallint primary key check (id = 1),
  last_commit text,
  updated_at timestamptz default now()
);

insert into public.canary_state (id, last_commit)
  values (1, null)
  on conflict (id) do nothing;

alter table public.render_audit_log
  add column if not exists internal boolean not null default false;

comment on column public.render_audit_log.internal is
  'v56: true for canary renders and founder smoke tests — excluded from founder metrics and funnel counts.';

-- OPTIONAL BACKFILL (founder): mark your own smoke-test renders internal
-- so the dashboard funnel reflects real customers. Fill in your account
-- user_ids (Auth → Users), then run:
--
--   update public.render_audit_log
--     set internal = true
--     where agent_user_id in ('<your-user-id-1>', '<your-user-id-2>');
