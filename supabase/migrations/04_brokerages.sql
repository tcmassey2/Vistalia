-- EstateMotion — Brokerage admin tier
--
-- Adds multi-agent organizations (brokerages), agent membership, and a
-- per-render audit log so brokerage owners can monitor everything their
-- agents publish under the firm's name.
--
-- Apply via Supabase Dashboard → SQL Editor.
-- Safe to run multiple times (uses IF NOT EXISTS / DROP POLICY IF EXISTS).

-- ============================================================
-- ORGANIZATIONS
-- ============================================================
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),

  -- Identity
  name text not null,                 -- "Pinnacle Peak Realty"
  legal_name text,                    -- "Pinnacle Peak Realty, LLC"
  slug text unique,                   -- "pinnacle-peak-realty" (URL-safe)

  -- Compliance / state — drives the auto-overlays on every video produced
  -- under this brokerage. State is a 2-letter code ("AZ", "CA", "TX") so
  -- the renderer can pick the right state-specific disclosure.
  state text,
  license_number text,                -- DRE# / TREC# / state-specific
  fair_housing_required boolean default true,
  compliance_disclaimer text,         -- free-form override if state default isn't enough

  -- Brand pack — propagates to agents via the manifest pipe
  logo_url text,
  primary_color text,                 -- HEX, e.g. "#0D0D0D"
  accent_color text,                  -- HEX, e.g. "#C7A76C"

  -- Plan / billing
  -- "team" = $499/mo, 5 seats
  -- "brokerage" = $1,999/mo, 20 seats
  -- "enterprise" = $4,999/mo, 100 seats
  tier text not null default 'team'
    check (tier in ('team', 'brokerage', 'enterprise')),
  agent_seat_cap integer not null default 5,
  stripe_customer_id text,
  stripe_subscription_id text,

  -- Audit
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

create index if not exists idx_organizations_created_by on public.organizations(created_by);
create index if not exists idx_organizations_slug on public.organizations(slug);

-- ============================================================
-- ORGANIZATION MEMBERS — links auth.users to organizations with a role.
--
-- One user can belong to multiple orgs (rare but valid — broker who works
-- across two firms). The first org they create / join is treated as their
-- "primary" org by the API; the frontend lets them switch.
-- ============================================================
create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'agent')),
  invited_email text,
  invited_by uuid references auth.users(id),
  joined_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create index if not exists idx_org_members_user on public.organization_members(user_id);
create index if not exists idx_org_members_org on public.organization_members(organization_id);

-- ============================================================
-- RENDER AUDIT LOG — one row per render produced by any agent in any org.
--
-- This is the brokerage's compliance + visibility surface: every video
-- their license is on, who made it, when, for which listing, with the
-- played-back video URL. Brokerage admins can review or pull a video down
-- if it violates standards.
-- ============================================================
create table if not exists public.render_audit_log (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid references public.organizations(id) on delete set null,
  agent_user_id uuid not null references auth.users(id) on delete cascade,

  -- Render identity
  job_id text not null,
  engine text not null check (engine in ('remotion', 'runway')),

  -- Listing context (denormalized so the audit log survives even if the
  -- project record is deleted)
  listing_address text,
  listing_city text,
  listing_price text,
  project_title text,

  -- Deliverable URLs
  master_mp4_url text,
  thumbnail_url text,
  social_short_count integer default 0,
  formats_count integer default 1,
  narration_applied boolean default false,
  narration_voice_id text,

  -- Status
  status text not null default 'completed'
    check (status in ('queued', 'rendering', 'completed', 'failed')),
  error_message text,

  -- Audit
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_org_created on public.render_audit_log(organization_id, created_at desc);
create index if not exists idx_audit_agent_created on public.render_audit_log(agent_user_id, created_at desc);
create index if not exists idx_audit_job on public.render_audit_log(job_id);

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Returns the caller's primary organization + their role inside it.
-- Used by /api/organization and the frontend admin gating.
create or replace function public.get_user_organization(p_user_id uuid)
returns table (
  organization_id uuid,
  organization_name text,
  organization_slug text,
  organization_tier text,
  organization_state text,
  organization_license_number text,
  organization_logo_url text,
  organization_accent_color text,
  role text,
  joined_at timestamptz,
  agent_seat_cap integer,
  agent_seat_count_used bigint
) language plpgsql security definer as $$
begin
  return query
  select
    o.id,
    o.name,
    o.slug,
    o.tier,
    o.state,
    o.license_number,
    o.logo_url,
    o.accent_color,
    om.role,
    om.joined_at,
    o.agent_seat_cap,
    (select count(*) from public.organization_members om2 where om2.organization_id = o.id)
  from public.organization_members om
  join public.organizations o on o.id = om.organization_id
  where om.user_id = p_user_id
  order by om.joined_at asc
  limit 1;
end $$;

-- Returns true if the caller is an owner or admin of the given org.
create or replace function public.is_org_admin(p_user_id uuid, p_org_id uuid)
returns boolean language sql security definer as $$
  select exists (
    select 1 from public.organization_members
    where user_id = p_user_id
    and organization_id = p_org_id
    and role in ('owner', 'admin')
  );
$$;

-- ============================================================
-- ROW-LEVEL SECURITY
-- ============================================================
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.render_audit_log enable row level security;

-- Organizations: members read; owners/admins update.
drop policy if exists "Members read their orgs" on public.organizations;
create policy "Members read their orgs" on public.organizations
  for select using (
    exists (
      select 1 from public.organization_members om
      where om.organization_id = organizations.id
      and om.user_id = auth.uid()
    )
  );

drop policy if exists "Authenticated users can create orgs" on public.organizations;
create policy "Authenticated users can create orgs" on public.organizations
  for insert with check (
    auth.uid() is not null and created_by = auth.uid()
  );

drop policy if exists "Org admins update their org" on public.organizations;
create policy "Org admins update their org" on public.organizations
  for update using (public.is_org_admin(auth.uid(), id))
  with check (public.is_org_admin(auth.uid(), id));

-- Organization members: members read the roster of their own org.
drop policy if exists "Members read roster" on public.organization_members;
create policy "Members read roster" on public.organization_members
  for select using (
    exists (
      select 1 from public.organization_members om2
      where om2.organization_id = organization_members.organization_id
      and om2.user_id = auth.uid()
    )
  );

-- Org admins manage membership (invite/remove). Self-create as owner is
-- handled by the API service-role insert when creating the org.
drop policy if exists "Org admins manage membership" on public.organization_members;
create policy "Org admins manage membership" on public.organization_members
  for all using (public.is_org_admin(auth.uid(), organization_id))
  with check (public.is_org_admin(auth.uid(), organization_id));

-- Render audit log:
--   - Agents read their own rows (so they can see their render history)
--   - Org admins read every row in their org
--   - Inserts come from the service-role worker only (no client RLS path)
drop policy if exists "Agents read own audit rows" on public.render_audit_log;
create policy "Agents read own audit rows" on public.render_audit_log
  for select using (agent_user_id = auth.uid());

drop policy if exists "Org admins read org audit rows" on public.render_audit_log;
create policy "Org admins read org audit rows" on public.render_audit_log
  for select using (
    organization_id is not null
    and public.is_org_admin(auth.uid(), organization_id)
  );

-- ============================================================
-- TRIGGER — keep organizations.updated_at fresh
-- ============================================================
create or replace function public.touch_organizations_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_touch_organizations_updated_at on public.organizations;
create trigger trg_touch_organizations_updated_at
  before update on public.organizations
  for each row execute function public.touch_organizations_updated_at();
