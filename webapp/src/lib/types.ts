// Vistalia — domain types

// v26.6: "veo" is the production AI engine. "runway" retained for the
// rollback path (the worker upgrades runway→veo); "remotion" is the
// legacy Ken Burns path, still referenced by older code.
export type RenderEngine = "remotion" | "runway" | "veo";

export type ExportFormat = "vertical" | "wide" | "square";

export type RoomType =
  | "exterior"
  | "kitchen"
  | "living"
  | "bedroom"
  | "bathroom"
  | "outdoor"
  | "amenity"
  | "detail";

export type CameraMotion =
  | "push_in"
  | "pull_out"
  | "lateral_pan"
  | "vertical_reveal"
  | "parallax_zoom"
  | "detail_sweep";

export type Transition =
  | "crossfade"
  | "blur_wipe"
  | "whip_pan"
  | "match_cut"
  | "light_leak";

export type StyleId =
  | "cinematic-luxury"
  | "modern-social"
  | "mls-clean"
  | "investor-tour";

export type Tier = "trial" | "quick_reel" | "cinematic_ai" | "cinematic_4k";

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "unpaid";

export interface Photo {
  id: string;
  fileName: string;
  publicUrl: string;       // From Supabase storage public URL
  durableUrl: string;      // Same as publicUrl when bucket is public
  storagePath: string;     // {userId}/projects/{projectId}/{file}
  bucket: string;
  width: number;
  height: number;
  size: number;
  category?: RoomType;
  caption?: string;
  order: number;
  uploadedAt: string;      // ISO
}

export interface ListingDetails {
  address: string;
  city: string;
  price: string;
  beds: string;
  baths: string;
  squareFeet: string;
  hook: string;            // Marketing hook line
}

export interface AgentBranding {
  fullName: string;
  brokerage: string;
  phone: string;
  email: string;
  headshotUrl?: string;
  // Brokerage logo (PNG/SVG with transparent bg works best). Composited
  // onto the outro card next to the agent's headshot. Optional but
  // strongly recommended for MLS-compliant marketing.
  brokerageLogoUrl?: string;
  // State-issued real estate license number. Displayed on the outro card
  // for MLS / state advertising compliance. E.g. "DRE# 01234567" (CA),
  // "TREC# 0123456" (TX), "AZ SA-123456" (AZ).
  licenseNumber?: string;
  // ACTIVE narrator: either a preset slug ("luxury-warm") or a raw
  // ElevenLabs cloned voice_id. Empty/undefined = style default. This is
  // what the render worker resolves at synth time.
  voiceId?: string;
  // Display name of the active voice — preset label or agent's first name.
  voiceLabel?: string;
  // v34.7: the agent's cloned voice, remembered PERMANENTLY and separately
  // from voiceId. Before this split, picking any preset in Settings
  // overwrote voiceId and silently destroyed the clone linkage — the
  // clone card's Preview became a no-op and renders stopped using the clone.
  clonedVoiceId?: string;
  clonedVoiceLabel?: string;
}

export interface SceneOverlay {
  headline: string;
  subline: string;
}

export interface SceneCard {
  headline: string;
  subline: string;
}

export interface EditPlanScene {
  photoId: string;
  order: number;
  roomType: RoomType;
  visibleFeatures: string[];
  qualityScore: number;
  duration: number;
  cameraMotion: CameraMotion;
  transition: Transition;
  overlay: SceneOverlay;
  runwayPrompt?: string;
  veoPrompt?: string;
  // Conversational 1-2 sentence narration for this scene. The Motion
  // Director only writes a line when narration would add to the moment
  // (intro / kitchen / outdoor / outro CTA). Silent scenes let the photo
  // and music breathe.
  narrationLine?: string;
}

export interface EditPlan {
  id: string;
  source: "openai-motion-director" | "deterministic-fallback";
  engine: RenderEngine;
  heroPhotoId: string;
  exportFormat: ExportFormat;
  selectedStyle: string;
  musicMood: string;
  introCard: SceneCard;
  outroCard: SceneCard;
  scenes: EditPlanScene[];
  runwayConfig?: {
    model: string;
    ratio: string;
    duration: number;
    motionStrength: number;
  } | null;
}

export interface Project {
  id: string;
  createdAt: string;
  photos: Photo[];
  listing: ListingDetails;
  branding: AgentBranding;
  selectedStyleId: StyleId;
  renderEngine: RenderEngine;
  editPlan: EditPlan | null;
}

export interface RenderFormatVariant {
  mp4Url: string;
  storagePath?: string;
  dimensions?: { width: number; height: number } | null;
}

export interface SocialShortClip {
  clipNumber: number;
  mp4Url: string;
  durationSec: number;
  sourceSceneOrder?: number;
  roomType?: string;
}

export interface RenderJobStatus {
  jobId: string;
  status: "queued" | "rendering" | "completed" | "failed";
  phase: string;
  progress: number;
  mp4Url?: string; // primary deliverable (vertical 9:16)
  thumbnailUrl?: string;
  // Multi-format atomic export — one render produces 9:16 + 1:1 + 16:9.
  formats?: {
    vertical?: RenderFormatVariant;
    square?: RenderFormatVariant;
    wide?: RenderFormatVariant;
  };
  // Three hero clips auto-cut from the master, ready for Instagram Reels /
  // TikTok / Shorts. Each is ~10 seconds, vertical, with the brand watermark.
  socialShorts?: SocialShortClip[];
  error?: string;
  engine?: RenderEngine;
  // v27 Edit Studio: per-scene clips of the finished render, so a single
  // scene can be previewed and re-rendered without redoing the whole video.
  scenes?: SceneClipMeta[];
}

// One generated scene clip from a finished render. Powers the Edit Studio.
export interface SceneClipMeta {
  sceneIndex: number;
  photoId: string;
  photoUrl?: string;     // durable source photo URL
  clipUrl?: string;      // durable per-scene clip URL ("" = not regenerable)
  storagePath?: string;
  roomType?: string;
  cameraMotion?: string;
  duration?: number;
  runwayPrompt?: string;
  wasFallback?: boolean;
  veoAttempts?: number;  // re-render attempts; ≥2 → auto Ken Burns
}

export interface UserProfile {
  user_id: string;
  email: string;
  tier: Tier;
  monthly_video_quota: number;
  videos_used_this_month: number;
  subscription_status: SubscriptionStatus | null;
  available_engines: RenderEngine[];
  can_render: boolean;
  reason: string | null;
  // Trial enforcement (migration 07). All four are set to NULL/0 for
  // non-trial tiers — UI should only surface the countdown when tier=='trial'.
  trial_ends_at: string | null;       // ISO timestamp
  trial_renders_used: number;
  trial_render_cap: number;
  current_period_end: string | null;  // ISO timestamp for paid users' billing cycle
  // v26.6 pay-per-video: purchased credit balance (migration 14/15). A user
  // can have 0 subscription quota but bought credits — they can still render.
  render_credits?: number;
}

/* ============================================================
   Organizations / Brokerage admin tier
   ============================================================ */

export type OrgRole = "owner" | "admin" | "agent";
export type OrgTier = "team" | "brokerage" | "enterprise";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  tier: OrgTier;
  state: string | null;
  licenseNumber: string | null;
  logoUrl: string | null;
  accentColor: string | null;
  role: OrgRole;
  joinedAt: string;
  agentSeatCap: number;
  agentSeatCount: number;
}

export interface OrgRosterMember {
  userId: string;
  email: string;
  fullName: string;
  role: OrgRole;
  joinedAt: string;
  rendersLast30Days: number;
}

// One past render in the agent's library — surfaced on the dashboard.
// Backed by the render_audit_log table on the server side.
export interface LibraryEntry {
  id: string;
  jobId: string;
  engine: RenderEngine;
  listingAddress: string;
  listingCity: string;
  listingPrice: string;
  projectTitle: string;
  mp4Url: string;
  thumbnailUrl: string;
  socialShortCount: number;
  formatsCount: number;
  narrationApplied: boolean;
  narrationVoiceId?: string | null;
  // Per-scene metadata (one entry per scene in the rendered video). Populated
  // for renders made with worker v16+ where each scene was persisted to
  // Supabase Storage. Empty for older renders — UI shows a "re-render once
  // to enable per-scene regen" hint in that case.
  scenes: LibrarySceneEntry[];
  // v23.2 diagnostic fields — render_audit_log.prompt_version + render_config.
  // Surfaced in LibraryDetailModal's "Render details" panel so users know
  // exactly what config / model / engine actually shipped.
  promptVersion?: string | null;
  renderConfig?: {
    selectedStyle?: string | null;
    complianceMode?: boolean;
    hallucinationGuard?: string | null;
    protectHighRiskRooms?: boolean;
    twilightHero?: boolean;
    injectBroll?: boolean;
    disableAddressCard?: boolean;
    userTier?: string | null;
    runwayModelRequested?: string | null;
    // v42: written by audit-log.mjs (render_config was read-but-never-
    // written since v23.2). Powers the Library "Video details" panel and
    // faithful per-scene regen re-stitching.
    musicMood?: string | null;
    musicTrack?: string | null;
    captionsEnabled?: boolean;
    useCrossfades?: boolean;
    targetDurationSec?: number | null;
  } | null;
  createdAt: string;
}

// One scene's metadata in a library entry — drives the regen UI.
export interface LibrarySceneEntry {
  sceneIndex: number;
  photoId: string;
  photoUrl: string;     // Durable URL to the source listing photo
  clipUrl: string;      // Durable URL to the persisted scene-NNN.mp4
  roomType: string;
  cameraMotion: string;
  duration: number;
  runwayPrompt: string;
  wasFallback: boolean; // true if this scene was rendered via Ken Burns
  // v23.1 per-scene engine breakdown
  engineUsed?: string;
  fallbackReason?: string | null;
  guardRisk?: number | null;
  guardLevel?: string | null;
  modelRequested?: string | null;
  modelUsed?: string | null;
}

export interface OrgAuditLogEntry {
  id: string;
  jobId: string;
  engine: RenderEngine;
  agentUserId: string;
  agentEmail: string;
  agentDisplayName: string;
  listingAddress: string | null;
  listingCity: string | null;
  listingPrice: string | null;
  projectTitle: string | null;
  mp4Url: string;
  thumbnailUrl: string;
  socialShortCount: number;
  formatsCount: number;
  narrationApplied: boolean;
  status: "queued" | "rendering" | "completed" | "failed";
  errorMessage: string | null;
  createdAt: string;
}

export interface AppEnv {
  MOCK_AI: boolean;
  MOCK_RENDERING: boolean;
  MOCK_SUPABASE: boolean;
  MOCK_STRIPE: boolean;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  LISTING_PHOTOS_BUCKET: string;
  CREATE_EDIT_PLAN_ENDPOINT: string;
  RENDER_ENDPOINT: string;
  STRIPE_PUBLISHABLE_KEY: string;
  HCAPTCHA_SITE_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  PLAUSIBLE_DOMAIN?: string;
  SENTRY_DSN_PUBLIC?: string;
  SENTRY_ENVIRONMENT?: string;
}

declare global {
  interface Window {
    ESTATEMOTION_ENV?: Partial<AppEnv>;
    ESTATEMOTION_API_ENV_UNAVAILABLE?: boolean;
  }
}
