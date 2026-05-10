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

async function authHeaders(): Promise<HeadersInit> {
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
      brandKit: args.brandKit || null
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
  app: "EstateMotion";
  engine: RenderEngine;
  exportFormat: ExportFormat;
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
    // Conversational voiceover line for this scene. Empty/missing = silent.
    // The render-worker synthesizes via ElevenLabs and ducks music under it.
    narrationLine?: string;
  }>;
  orderedPhotos: Photo[];
  introCard: { headline: string; subline: string };
  outroCard: { headline: string; subline: string };
  musicMood: string;
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
  // When true, the worker upscales the master + every aspect variant to
  // 4K-equivalent resolution (2160×3840 vertical, etc). Defaults to true
  // now that we're on Render Pro 4GB / Supabase Pro 5GB-per-file.
  export4K?: boolean;
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

export async function pollRender(jobId: string): Promise<RenderJobStatus> {
  const res = await fetch(`/api/render?jobId=${encodeURIComponent(jobId)}`);
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
  const res = await fetch(`/api/lookup-property?${params}`);
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
