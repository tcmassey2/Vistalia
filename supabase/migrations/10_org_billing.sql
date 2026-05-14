-- EstateMotion — Organization (brokerage) Stripe billing fields
--
-- The original 04_brokerages.sql created the organizations table but
-- didn't include subscription columns — brokerages were intended for
-- "ship when first asked" billing. This migration adds them so the
-- existing Stripe webhook can flip an org's subscription state and the
-- brokerage admin UI can show seat counts + renewal dates.
--
-- Apply via Supabase Dashboard → SQL Editor.
-- Safe to run multiple times.

alter table public.organizations
  add column if not exists stripe_customer_id text unique,
  add column if not exists stripe_subscription_id text unique,
  add column if not exists subscription_status text
    check (subscription_status in ('trialing','active','past_due','canceled','incomplete','unpaid')),
  add column if not exists seats integer not null default 5,
  add column if not exists current_period_end timestamptz,
  add column if not exists cancel_at_period_end boolean default false;

comment on column public.organizations.seats is
  'Number of paid seats from the Stripe per-seat subscription. The agent_seat_cap column (existing) defaults to this on each webhook update.';
