// EstateMotion — domain types

export type RenderEngine = "remotion" | "runway";

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
  // ElevenLabs voice clone ID. When set, every future render is narrated in
  // the agent's actual voice. When unset, EstateMotion still narrates using
  // a stock professional voice — so the agent always gets narration, and
  // voice cloning becomes the perceptible upgrade.
  voiceId?: string;
  // Display name of the voice clone — typically the agent's first name.
  voiceLabel?: string;
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
  createdAt: string;
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
}

declare global {
  interface Window {
    ESTATEMOTION_ENV?: Partial<AppEnv>;
    ESTATEMOTION_API_ENV_UNAVAILABLE?: boolean;
  }
}
