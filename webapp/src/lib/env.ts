// Reads the public env config that /api/env sets on window.ESTATEMOTION_ENV.
// /api/env auto-detects MOCK mode based on which keys are configured server-side.

import type { AppEnv } from "./types";

const DEFAULTS: AppEnv = {
  MOCK_AI: false,
  MOCK_RENDERING: false,
  MOCK_SUPABASE: false,
  MOCK_STRIPE: true,
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
  LISTING_PHOTOS_BUCKET: "listing-photos",
  CREATE_EDIT_PLAN_ENDPOINT: "/api/create-edit-plan",
  RENDER_ENDPOINT: "/api/render",
  STRIPE_PUBLISHABLE_KEY: ""
};

export function env(): AppEnv {
  const fromWindow = (window.ESTATEMOTION_ENV ?? {}) as Partial<AppEnv>;
  return { ...DEFAULTS, ...fromWindow };
}

export function isProductionReady(): boolean {
  const e = env();
  return !e.MOCK_RENDERING && !e.MOCK_SUPABASE && Boolean(e.SUPABASE_URL && e.SUPABASE_ANON_KEY);
}
