-- Migration 26 — v34.7: dedicated clone-voice columns on brand_kits.
--
-- WHY: voice_id held EITHER a preset slug OR the ElevenLabs cloned voice id,
-- and two UIs wrote it. Picking a preset in Settings overwrote the clone id —
-- the only place it lived — silently unlinking the user's voice clone
-- ("the voice clone is not playing back my voice", 2026-07-05).
--
-- voice_id remains the ACTIVE narrator (slug, raw id, or null = style
-- default). cloned_voice_id permanently remembers the user's clone so the
-- picker can re-offer it forever.
--
-- Idempotent: safe to re-run.

alter table public.brand_kits
  add column if not exists cloned_voice_id text,
  add column if not exists cloned_voice_label text;

-- Backfill: any existing voice_id that isn't a known preset slug and isn't
-- null IS a raw ElevenLabs clone id — copy it into the dedicated column.
update public.brand_kits
set
  cloned_voice_id = voice_id,
  cloned_voice_label = coalesce(voice_label, 'Your voice')
where cloned_voice_id is null
  and voice_id is not null
  and voice_id not in (
    'luxury-warm', 'luxury-male', 'luxury-british',
    'viral-energetic', 'viral-confident', 'investor-deep', 'mls-neutral'
  );
