// EstateMotion — engine label centralization.
//
// Single source of truth for the user-facing engine name + short
// description. Used by DashboardScreen, LibraryDetailModal,
// BrokerageScreen, and anywhere else we surface "which engine
// produced this render".
//
// When a new engine ships, add it here and every label in the UI
// updates at once.

import type { RenderEngine } from "./types";

export function engineLabel(engine: RenderEngine | string | null | undefined): string {
  const e = String(engine || "remotion").toLowerCase();
  if (e === "veo" || e === "runway") return "Cinematic AI";
  if (e === "depth") return "Cinematic Depth";
  return "Quick Reel";
}

export function engineDescription(engine: RenderEngine | string | null | undefined): string {
  const e = String(engine || "remotion").toLowerCase();
  if (e === "veo") return "Veo 3.1 cinematic image-to-video generation";
  if (e === "runway") return "Runway Gen-4 image-to-video generation";
  if (e === "depth") return "Depth-based 2.5D parallax with geometric camera moves";
  return "Ken Burns camera motion on still photos";
}

// True for any engine that uses AI image-to-video generation. Used to
// gate UI affordances (regen-this-scene, etc.) that only make sense for
// AI-generated clips. v26.9: veo is the production AI engine.
export function isAiVideoEngine(engine: RenderEngine | string | null | undefined): boolean {
  const e = String(engine || "remotion").toLowerCase();
  return e === "veo" || e === "runway" || e === "depth";
}
