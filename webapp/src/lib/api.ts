// Typed wrappers for /api/* routes. Every call attaches the Supabase JWT so
// /api/render's tier guard can identify the user.

import { getSession } from "./supabase";
import type {
  AgentBranding,
  EditPlan,
  ExportFormat,
  LibraryEntry,
  ListingDetails,
  OrgAuditLogEntry,
  OrgRosterMember,
  Organization,
  Photo,
  RenderEngine,
  RenderJobStatus,
  UserProfile
} from "./types";

// Exported so hand-rolled fetches (e.g. the voice clone/preview calls in
// ProjectScreen) attach the Supabase token too — without it the /api/*
// endpoints reject with 401 "Sign in to use this feature."
export async function authHeaders(): Promise<Record<string, string>> {
  const session = await getSession();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  return headers;
}

/* ============================================================
   /api/health — diagnostic
   ============================================================ */

export interface HealthReport {
  productionReady: boolean;
  summary: string;
  mode: { MOCK_AI: boolean; MOCK_RENDERING: boolean; MOCK_SUPABASE: boolean; MOCK_STRIPE: boolean };
  subsystems: Record<string, { ready: boolean; missing: string[]; note: string }>;
  workerCheck?: { ok: boolean; status?: number; error?: string };
}

export async function fetchHealth(): Promise<HealthReport> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json();
}

/* ============================================================
   /api/usage — current user's tier + quota
   ============================================================ */

export async function fetchUsage(): Promise<UserProfile | null> {
  const headers = await authHeaders();
  const res = await fetch("/api/usage", { headers });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Usage fetch failed: ${res.status}`);
  return res.json();
}

/* ============================================================
   /api/create-edit-plan — Motion Director
   ============================================================ */

export interface CreateEditPlanArgs {
  photos: Photo[];
  listing: ListingDetails;
  selectedStyle: string;
  exportFormat: ExportFormat;
  engine: RenderEngine;
  // Brand kit travels with the plan request so the Motion Director can
  // write narration in the agent's voice (referencing their name/brokerage)
  // and tailor the outro CTA.
  brandKit?: AgentBranding;
  // v24: target video length in seconds. 30s default (social-first),
  // 60s max. Drives the scene count in the edit plan generator.
  targetDurationSec?: 30 | 60;
  // v30 beat-sync: chosen music track filename so the plan snaps scene cuts
  // to THIS track's beat grid (not the style default). Must match the
  // manifest.musicTrack sent at render time.
  musicTrack?: string;
}

export interface CreateEditPlanResult {
  status: "complete" | "fallback" | "failed";
  reason?: string;
  errorCategory?: string;
  editPlan: EditPlan | null;
}

export async function createEditPlan(args: CreateEditPlanArgs): Promise<CreateEditPlanResult> {
  const headers = await authHeaders();
  const res = await fetch("/api/create-edit-plan", {
    method: "POST",
    headers,
    body: JSON.stringify({
      photos: args.photos.map((p) => ({
        id: p.id,
        durableUrl: p.durableUrl,
        publicUrl: p.publicUrl,
        fileName: p.fileName,
        width: p.width,
        height: p.height,
        category: p.category || ""
      })),
      listingDetails: args.listing,
      selectedStyle: args.selectedStyle,
      exportFormat: args.exportFormat,
      engine: args.engine,
      brandKit: args.brandKit || null,
      targetDurationSec: args.targetDurationSec || 30,
      musicTrack: args.musicTrack || ""
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Edit plan request failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

/* ============================================================
   /api/render — submit + poll
   ============================================================ */

export interface RenderManifest {
  app: "Vistalia";
  engine: RenderEngine;
  exportFormat: ExportFormat;
  // v32: one continuous voiceover script for the whole tour — synthesized in
  // a single TTS pass by the worker (replaces per-scene line scheduling).
  narrationScript?: string;
  // The Remotion composition reads listing facts from manifest.project to
  // populate address overlays, lower-third price card, and the EndCard.
  // Keep these fields populated; missing values render as blank slots.
  project: {
    id: string;
    userId: string;
    title: string;
    address?: string;
    city?: string;
    price?: string;
    beds?: string;
    baths?: string;
    squareFeet?: string;
    hook?: string;
  };
  scenes: Array<{
    photoId: string;
    type: "photo" | "intro" | "outro" | "stat";
    durableUrl?: string;
    publicUrl?: string;
    fileName?: string;
    duration: number;
    // roomType + qualityScore travel with the scene so the worker's social
    // shorts cutter can pick the highest-engagement frames.
    roomType?: string;
    qualityScore?: number;
    cameraMotion?: string;
    transition?: string;
    overlay?: { headline: string; subline: string };
    runwayPrompt?: string;
    veoPrompt?: string;
    // Conversational voiceover line for this scene. Empty/missing = silent.
    // The render-worker synthesizes via ElevenLabs and ducks music under it.
    narrationLine?: string;
  }>;
  orderedPhotos: Photo[];
  introCard: { headline: string; subline: string };
  outroCard: { headline: string; subline: string };
  musicMood: string;
  // Music selector: explicit track filename (matches one of the .mp3 files in
  // render-worker/music/). Optional; worker falls back to style default if
  // missing or unrecognized.
  musicTrack?: string;
  // v24.2: when true, the worker skips the music mix step entirely.
  // Master ships with voice-only (if narration is on) or silent audio.
  skipMusic?: boolean;
  // v24.2: music bed level override. Multiplied with the worker's
  // default in the mix step. 0 = silent, 1.0 = default, 1.5 = louder.
  musicBedLevel?: number;
  selectedStyle: string;
  runwayConfig?: {
    model?: string;
    ratio?: string;
    duration?: number;
    // Opt-in crossfade transitions between scenes. Default OFF — xfade
    // re-encodes the entire video and OOMs Render Standard 2GB. Enable
    // only when worker is on Pro 4GB+ for the smoother look.
    useCrossfades?: boolean;
    // Upscale every variant to 4K-equivalent resolution. Defaults to true
    // now that we're on Render Pro 4GB+ and Supabase Pro can store the
    // larger files. Worker reads either this OR the top-level export4K.
    is4K?: boolean;
    // Legacy spelling — accepted for backward compat.
    upscale4K?: boolean;
    // Random seed if you want deterministic Runway output (rarely useful).
    seed?: number | null;
    motionStrength?: number;
  } | null;
  // Brand kit drives the closing card on every video — agent headshot,
  // brokerage, contact line. Both engines (Remotion + Runway) consume this.
  brandKit: AgentBranding;
  // Organization (brokerage) the agent belongs to. The render-worker uses
  // it to attribute the audit-log row to the brokerage so admins can
  // monitor everything produced under their license.
  organizationId?: string | null;
  // When true, the worker skips ElevenLabs voice synthesis entirely and
  // ships music-only audio. Useful when narration would slow renders down
  // (e.g. live demo) or when ElevenLabs is having availability issues.
  skipNarration?: boolean;
  // v35.1: opt-in 1:1 square deliverable — recomposed from source clips on
  // the worker (~2 extra minutes). Default false = vertical-only render.
  includeSquare?: boolean;
  // v38: burn word-synced captions over the narration (default true).
  captionsEnabled?: boolean;
  // When true, the worker upscales the master + every aspect variant to
  // 4K-equivalent resolution (2160×3840 vertical, etc). Defaults to true
  // now that we're on Render Pro 4GB / Supabase Pro 5GB-per-file.
  export4K?: boolean;
  // Compliance Mode — bypass Runway entirely, use Ken Burns motion for
  // every scene. Zero hallucination risk, faster renders, no Runway
  // credits burned. Trade-off: less "AI motion" feel. Right default for
  // listings that need MLS-grade faithfulness above all.
  complianceMode?: boolean;
  // Surgical fallback — route only kitchens and bathrooms (the highest-
  // hallucination room types) through Ken Burns while letting the rest
  // use Cinematic AI. Cleaner than all-or-nothing Compliance Mode.
  // (Legacy field — superseded by hallucinationGuard. Kept for back-compat:
  // protectHighRiskRooms=true maps to hallucinationGuard="balanced",
  // protectHighRiskRooms=false maps to "off".)
  protectHighRiskRooms?: boolean;
  // Hallucination Guard — content-aware Runway-vs-Ken-Burns routing.
  //   "off"      — pure Runway. Use only when you're willing to accept that
  //                kitchens may have split countertops or phantom fans.
  //   "balanced" — default. Kitchens + bathrooms (and any other scene whose
  //                content scores risky) auto-route to Ken Burns; the rest
  //                use Cinematic AI motion.
  //   "strict"   — same as balanced but with a lower risk threshold. Locks
  //                ALL kitchens regardless of features. Best for production-
  //                grade reliability when an AI mishap would be a liability.
  hallucinationGuard?: "off" | "balanced" | "strict";
  // Per-scene regenerate-only: skip ElevenLabs re-synthesis even if the
  // original render had narration. Saves ~30s per regen and avoids
  // resplicing voice tracks against a swapped scene's new timing.
  regenSkipNarration?: boolean;
  // v23: Prompt version stamp from /api/create-edit-plan. Flows through to
  // render_audit_log.prompt_version for offline tuning correlation.
  promptVersion?: string | null;
  // v23: Creative-direction flags grouped under one bag.
  creative?: {
    // Twilight Magic — converts the hero (first) photo to a warm dusk
    // scene with glowing windows via SDXL on Replicate before render.
    // Premium-tier gated; worker checks before calling.
    twilightHero?: boolean;
    // Inject Pexels lifestyle B-roll cutaways. Default true; set false
    // to opt out per-render. PEXELS_API_KEY required server-side.
    injectBroll?: boolean;
    // Override the music track BPM if known (otherwise the worker uses a
    // curated table by music slot, falling back to 100 BPM).
    musicBpm?: number;
    // Allow forwarding extra creative fields without breaking the type.
    [key: string]: unknown;
  };
  // v23: Skip the 3.5s animated address card opener. Default false (card
  // shows on every render). Worker honors this in both engines.
  disableAddressCard?: boolean;
  // v23: User's resolved tier — stamped server-side from get_user_tier_state
  // so the worker can gate paid features (upscale, day-to-dusk) without
  // a second Supabase round-trip.
  userTier?: string;
}

export interface SubmitRenderResult {
  status: "queued" | "rendering" | "completed" | "failed";
  jobId?: string;
  phase?: string;
  progress?: number;
  mp4Url?: string;
  error?: string;
  upgradeRequired?: boolean;
  currentTier?: string;
}

export async function submitRender(manifest: RenderManifest): Promise<SubmitRenderResult> {
  const headers = await authHeaders();
  const res = await fetch("/api/render", {
    method: "POST",
    headers,
    body: JSON.stringify({ manifest, requestedFormat: manifest.exportFormat })
  });
  const payload = await res.json().catch(() => ({} as SubmitRenderResult));
  if (res.status === 402) {
    return {
      status: "failed",
      error: payload.error || "Plan upgrade required.",
      upgradeRequired: true,
      currentTier: payload.currentTier
    };
  }
  if (!res.ok) {
    throw new Error(payload.error || `Render submission failed (${res.status})`);
  }
  return payload;
}

// Typed error so callers can distinguish a "worker has no record of this job"
// (404 — worker restarted between submit and poll) from other failures.
export class RenderJobMissingError extends Error {
  constructor(jobId: string) {
    super(`Render worker has no record of job ${jobId} — it likely restarted (deploy or OOM).`);
    this.name = "RenderJobMissingError";
  }
}

export async function pollRender(jobId: string): Promise<RenderJobStatus> {
  const res = await fetch(`/api/render?jobId=${encodeURIComponent(jobId)}`);
  if (res.status === 404) throw new RenderJobMissingError(jobId);
  if (!res.ok) throw new Error(`Render status request failed: ${res.status}`);
  return res.json();
}

/* ============================================================
   /api/library — past renders for the signed-in agent
   ============================================================ */

export interface LibraryResponse {
  status: "ok" | "failed";
  library: LibraryEntry[];
  note?: string;
  error?: string;
}

/* ============================================================
   /api/send-desktop-link — mobile → desktop handoff
   Emails the signed-in user a fresh magic link so they can pick
   up on the computer where their listing photos live. Server-side
   because client OTP calls require a captcha.
   ============================================================ */
export async function sendDesktopLink(): Promise<{ ok: boolean; error?: string }> {
  const headers = await authHeaders();
  const res = await fetch("/api/send-desktop-link", { method: "POST", headers });
  const payload = await res.json().catch(() => ({} as { status?: string; error?: string }));
  if (!res.ok || payload.status === "failed") {
    return { ok: false, error: payload.error || `Couldn't send the link (${res.status}).` };
  }
  return { ok: true };
}

export async function fetchLibrary(args: { limit?: number; offset?: number } = {}): Promise<LibraryResponse> {
  const headers = await authHeaders();
  const params = new URLSearchParams();
  if (args.limit) params.set("limit", String(args.limit));
  if (args.offset) params.set("offset", String(args.offset));
  const qs = params.toString();
  const res = await fetch(`/api/library${qs ? `?${qs}` : ""}`, { headers });
  if (res.status === 401) {
    return { status: "failed", library: [], error: "Sign in expired." };
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    return { status: "failed", library: [], error: payload.error || `Library fetch failed (${res.status}).` };
  }
  return res.json();
}

/**
 * Delete a single library entry. Hard-deletes the audit row + best-effort
 * wipes the Supabase Storage folder (master + thumbnail + per-scene clips).
 * Caller must own the entry — server scopes by agent_user_id.
 */
export interface DeleteLibraryEntryResponse {
  status: "ok" | "failed";
  deleted?: { jobId: string; auditRowId?: string };
  storageWarnings?: string[];
  error?: string;
}

export async function deleteLibraryEntry(jobId: string): Promise<DeleteLibraryEntryResponse> {
  const headers = await authHeaders();
  const res = await fetch(`/api/library?jobId=${encodeURIComponent(jobId)}`, {
    method: "DELETE",
    headers
  });
  if (res.status === 401) {
    return { status: "failed", error: "Sign in expired." };
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    return { status: "failed", error: payload.error || `Delete failed (${res.status}).` };
  }
  return res.json();
}

/* ============================================================
   /api/delete-account — GDPR/CCPA self-service account deletion
   ============================================================ */

export interface DeleteAccountResponse {
  status?: "deleted";
  deleted?: Record<string, unknown>;
  warnings?: string[];
  error?: string;
  detail?: string;
  note?: string;
}

export async function deleteAccount(confirmEmail: string): Promise<DeleteAccountResponse> {
  const headers = await authHeaders();
  const res = await fetch("/api/delete-account", {
    method: "POST",
    headers,
    body: JSON.stringify({ confirmEmail })
  });
  const payload = await res.json().catch(() => ({} as DeleteAccountResponse));
  if (!res.ok) {
    return { error: payload.error || `Delete failed (${res.status}).`, detail: payload.detail };
  }
  return payload;
}

/* ============================================================
   /api/billing-portal — Stripe Customer Portal session
   ============================================================ */

export interface BillingPortalResponse {
  url?: string;
  error?: string;
  needsCheckout?: boolean;
}

export async function openBillingPortal(): Promise<BillingPortalResponse> {
  const headers = await authHeaders();
  const res = await fetch("/api/billing-portal", { method: "POST", headers });
  if (res.status === 404) {
    const payload = await res.json().catch(() => ({}));
    return { needsCheckout: true, error: payload.error || "No paid plan yet." };
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    return { error: payload.error || `Billing portal request failed (${res.status}).` };
  }
  const payload = await res.json().catch(() => ({}));
  return { url: payload.url };
}

/* ============================================================
   /api/create-checkout-session — start a Stripe Checkout flow
   ============================================================
   Returns the Stripe-hosted checkout URL. Caller should immediately
   navigate the browser there (window.location.href = result.url).
   On success the user lands back on returnUrl?checkout=success.
*/

// q7 lineup: pro/studio subscriptions (monthly + _annual), payg one-off ($39),
// and `overage` — subscriber-only $12 extra credit (accepts `quantity` 1-10).
// single/pack5/pack10 removed with the packs (retired SKUs, server 400s them).
// Legacy subscription slugs retained so grandfathered flows don't 500.
export type CheckoutTier = "payg" | "overage" | "pro" | "pro_annual" | "studio" | "studio_annual" | "launch" | "quick_reel" | "cinematic_ai" | "cinematic_4k" | "brokerage";

export interface CheckoutResponse {
  url?: string;
  sessionId?: string;
  error?: string;
}

export async function startCheckout(args: {
  tier: CheckoutTier;
  email?: string;
  returnUrl?: string;
  // Brokerage tier only — number of seats (clamped 3-100 server-side).
  seats?: number;
  organizationId?: string;
  // Overage tier only — number of $12 credits (clamped 1-10 server-side).
  quantity?: number;
}): Promise<CheckoutResponse> {
  const headers = await authHeaders();
  const body = {
    tier: args.tier,
    email: args.email || "",
    returnUrl: args.returnUrl || `${window.location.origin}/app/`,
    ...(args.seats ? { seats: args.seats } : {}),
    ...(args.organizationId ? { organizationId: args.organizationId } : {}),
    ...(args.quantity ? { quantity: args.quantity } : {})
  };
  const res = await fetch("/api/create-checkout-session", {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    return { error: payload.error || `Checkout failed (${res.status}).` };
  }
  const payload = await res.json().catch(() => ({}));
  return { url: payload.url, sessionId: payload.sessionId };
}

/* ============================================================
   /api/curate-photos — AI picks the best 24 in tour order
   ============================================================ */

export interface CuratedPhotoPick {
  photoId: string;
  order: number;
  roomType: string;
  score: number;
  reason: string;
}

export interface CuratedPhotoReject {
  photoId: string;
  reason: string;
}

export interface CurateResponse {
  status: "ok" | "skipped" | "fallback" | "failed";
  reason?: string;
  curated: CuratedPhotoPick[];
  rejected: CuratedPhotoReject[];
  inputCount?: number;
  keptCount?: number;
}

export async function curatePhotos(args: {
  photos: Array<{ id: string; durableUrl: string; fileName: string }>;
}): Promise<CurateResponse> {
  const headers = await authHeaders();
  const res = await fetch("/api/curate-photos", {
    method: "POST",
    headers,
    body: JSON.stringify({ photos: args.photos })
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    return {
      status: "failed",
      reason: payload?.error || `Curate failed (${res.status}).`,
      curated: [],
      rejected: []
    };
  }
  return res.json();
}

/* ============================================================
   /api/regenerate-scene — surgical single-scene re-render
   ============================================================ */

export type RegenerateMode = "ai" | "kenburns";

export interface RegenerateSceneResult {
  status: "queued" | "rendering" | "completed" | "failed";
  jobId?: string;            // progressKey: "<originalJobId>:regen:<sceneIndex>"
  originalJobId?: string;
  sceneIndex?: number;
  mode?: RegenerateMode;
  phase?: string;
  progress?: number;
  mp4Url?: string;
  error?: string;
  errorCode?: string;
  upgradeRequired?: boolean;
  currentTier?: string;
}

// Submit a per-scene regenerate. Returns immediately (202) with a progressKey
// the caller polls via pollRender(progressKey) — the worker stores regen
// progress under the same /render/status/:id surface that full renders use.
export async function submitRegenerateScene(args: {
  jobId: string;
  sceneIndex: number;
  mode: RegenerateMode;
  manifest: RenderManifest;
}): Promise<RegenerateSceneResult> {
  const headers = await authHeaders();
  const res = await fetch("/api/regenerate-scene", {
    method: "POST",
    headers,
    body: JSON.stringify(args)
  });
  const payload = await res.json().catch(() => ({} as RegenerateSceneResult));
  if (res.status === 402) {
    return {
      status: "failed",
      error: payload.error || "Plan upgrade required.",
      upgradeRequired: true,
      currentTier: payload.currentTier
    };
  }
  if (!res.ok) {
    throw new Error(payload.error || `Regenerate-scene failed (${res.status}).`);
  }
  return payload;
}

/* ============================================================
   /api/lookup-property — public-records auto-fill (RentCast)
   ============================================================ */

export interface PropertyLookupResult {
  status: "ok" | "not_found" | "failed";
  source?: string;
  message?: string;
  property?: {
    address: string;
    city: string;
    beds: string;
    baths: string;
    squareFeet: string;
    extras: {
      yearBuilt: string;
      lotSize: string;
      propertyType: string;
      lastSalePrice: string;
      lastSaleDate: string;
      latitude: number | null;
      longitude: number | null;
      county: string;
      apn: string;
    };
  };
}

export async function lookupProperty(address: string): Promise<PropertyLookupResult> {
  const params = new URLSearchParams({ address });
  // v26: send the JWT — the endpoint now requires auth (RentCast budget
  // protection). Previously this was the only api.ts call without it.
  const headers = await authHeaders();
  const res = await fetch(`/api/lookup-property?${params}`, { headers });
  // 503 = unconfigured (no RentCast key on server); surface a usable shape
  // so the UI can show a graceful "not connected yet" instead of crashing.
  if (res.status === 503) {
    const payload = await res.json().catch(() => ({}));
    return { status: "failed", message: payload.error || "Property lookup not configured." };
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `Property lookup failed (${res.status}).`);
  }
  return res.json();
}

/* ============================================================
   /api/organization — brokerage admin surface
   ============================================================ */

export async function fetchOrganization(): Promise<Organization | null> {
  const headers = await authHeaders();
  const res = await fetch("/api/organization", { headers });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Organization fetch failed: ${res.status}`);
  const payload = await res.json();
  return payload.organization || null;
}

export async function createOrganization(args: {
  name: string;
  state?: string;
  licenseNumber?: string;
}): Promise<Organization> {
  const headers = await authHeaders();
  const res = await fetch("/api/organization", {
    method: "POST",
    headers,
    body: JSON.stringify(args)
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `Could not create organization (${res.status}).`);
  if (!payload.organization) throw new Error("Organization not returned by API.");
  return payload.organization;
}

export async function fetchOrgRoster(): Promise<OrgRosterMember[]> {
  const headers = await authHeaders();
  const res = await fetch("/api/organization?roster=1", { headers });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `Roster fetch failed (${res.status}).`);
  }
  const payload = await res.json();
  return payload.roster || [];
}

export async function fetchOrgAuditLog(args: { limit?: number; offset?: number } = {}): Promise<OrgAuditLogEntry[]> {
  const headers = await authHeaders();
  const params = new URLSearchParams({ audit: "1" });
  if (args.limit) params.set("limit", String(args.limit));
  if (args.offset) params.set("offset", String(args.offset));
  const res = await fetch(`/api/organization?${params}`, { headers });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `Audit log fetch failed (${res.status}).`);
  }
  const payload = await res.json();
  return payload.auditLog || [];
}
