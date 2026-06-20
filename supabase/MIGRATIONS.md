# Vistalia — Supabase migrations (single source of truth)

The `migrations/` folder IS the source of truth for the database schema. The
"saved queries" in the Supabase **SQL Editor are NOT** — they're just bookmarked
text and can be deleted freely; deleting them never changes the database. Clear
the clutter there and treat this list as canonical.

Apply order = numeric/alphabetical filename order. Almost all are **idempotent**
(`if not exists` / `create or replace` / plain `update`), so re-running the safe
ones to reconcile an uncertain database is fine.

| # | File | Purpose | Re-run safe? |
|---|------|---------|--------------|
| base | `schema.sql` | Full baseline schema (run on a fresh DB first) | yes |
| 02 | `02_subscriptions.sql` | Tiers, profiles, render_usage | yes |
| 03 | `03_storage_policies.sql` | Storage bucket RLS | yes |
| 04 | `04_brokerages.sql` | Brokerage tier + **render_audit_log** | yes |
| 05 | `05_per_scene_regen.sql` | `render_audit_log.scenes` JSONB (regen) | yes |
| 06 | `06_brand_kit_app_fields.sql` | Brand kit fields | yes |
| 07 | `07_trial_enforcement.sql` | Trial caps | yes |
| 08 | `08_email_dedupe.sql` | Email dedupe column | yes |
| 08b | `08b_per_scene_audit.sql` | Per-scene engine breakdown (re-asserts `scenes`) | yes |
| 09 | `09_render_jobs_queue.sql` | Render jobs queue/status table | yes |
| 10 | `10_org_billing.sql` | Org Stripe billing fields | yes |
| 11 | `11_depth_engine_in_ai_tiers.sql` | Add `depth` to AI tier engines | yes (plain UPDATE) |
| 12 | `12_render_credit_refunds.sql` | Credit-refund helper | yes |
| 13 | `13_v26_pricing_tiers.sql` | v26 pay-per-video tiers | yes |
| 14 | `14_render_credit_packs.sql` | Credit packs | yes |
| 15 | `15_usage_ledger_fix.sql` | Usage-ledger refund symmetry | yes |
| — | `20260501_live_schema_hardening.sql` | Large idempotent hardening pass | yes |
| **21** | `21_engine_check_allow_veo_depth.sql` | **Library fix** — widen `engine` CHECK to allow `veo`/`depth` | yes |

Helpers (not migrations): `seed.sql` (sample data), `LAUNCH_MIGRATIONS_consolidated.sql`
(a one-shot bundle of 12–15; redundant once 12–15 are applied — keep for reference or delete).

## Fixed in this cleanup
- **Duplicate `08` prefix** resolved: `08_per_scene_audit.sql` → `08b_per_scene_audit.sql`.

## What to do now (in order)
1. **Run `21_engine_check_allow_veo_depth.sql`** if you haven't — this is the active
   library bug fix; nothing renders into the library until it's applied.
2. Clear the 27 saved snippets in the SQL Editor (cosmetic; safe).
3. Run the verification query (`supabase/verify_schema.sql`) to confirm your live DB
   matches this list — it reports missing tables, the engine constraints, and whether
   audit rows are now landing.

## One thing to verify (flagged, not yet fixed)
Migration 11 sets AI-tier `available_engines = ['remotion','runway','depth']` — it does
**not** list `veo`. Renders work today (the gate allows the pre-upgrade engine), but
`veo` arguably belongs in that array for correctness. Confirm with the verification
query before deciding whether to add it.
