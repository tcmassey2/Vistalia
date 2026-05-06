// Typed wrappers for /api/* routes. Every call attaches the Supabase JWT so
// /api/render's tier guard can identify the user.

import { getSession } from "./supabase";
import type {
  AgentBranding,
  EditPlan,
  ExportFormat,
  ListingDetails,
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
      engine: args.engine
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
    cameraMotion?: string;
    transition?: string;
    overlay?: { headline: string; subline: string };
    runwayPrompt?: string;
  }>;
  orderedPhotos: Photo[];
  introCard: { headline: string; subline: string };
  outroCard: { headline: string; subline: string };
  musicMood: string;
  selectedStyle: string;
  runwayConfig?: { model: string; ratio: string; duration: number } | null;
  // Brand kit drives the closing card on every video — agent headshot,
  // brokerage, contact line. Both engines (Remotion + Runway) consume this.
  brandKit: AgentBranding;
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
