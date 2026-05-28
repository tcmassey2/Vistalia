// Zustand store — single source of truth for app state.
// Three screens: auth, dashboard (projects list), project (editor).
// The project editor is a single view with sections (no wizard).

import { create } from "zustand";
import type { Session } from "@supabase/supabase-js";
import type {
  AgentBranding,
  EditPlan,
  ListingDetails,
  Organization,
  Photo,
  RenderEngine,
  RenderJobStatus,
  StyleId,
  UserProfile
} from "./types";
import { onAuthChange, getSession, fetchBrandKit, saveBrandKit } from "./supabase";
import { fetchOrganization } from "./api";

export type Screen = "auth" | "dashboard" | "project" | "brokerage" | "settings";

// Render Safety levels — the only knob users have to think about for
// hallucination control. The manifest builder maps these to the worker's
// existing complianceMode + protectHighRiskRooms + hallucinationGuard fields.
export type RenderSafety = "off" | "smart" | "max";

export interface ProjectSummary {
  id: string;
  title: string;
  createdAt: string;
  thumbnailUrl: string;
  status: "draft" | "rendering" | "complete";
  mp4Url?: string;
}

interface AppState {
  // Auth
  session: Session | null;
  authReady: boolean;
  profile: UserProfile | null;

  // Brokerage / organization (null = solo agent)
  organization: Organization | null;
  organizationLoaded: boolean;

  // Routing
  screen: Screen;

  // Dashboard
  projectList: ProjectSummary[];

  // Active project (editor state)
  projectId: string;
  projectTitle: string;
  photos: Photo[];
  listing: ListingDetails;
  branding: AgentBranding;
  selectedStyleId: StyleId;
  // Music selector: null = use the style's default track. Otherwise the id
  // of a specific track from MUSIC_CATALOG (see lib/music-catalog.ts).
  selectedMusicTrackId: string | null;
  renderEngine: RenderEngine;
  // Default OFF — narration adds 30-60s to render time and gates on
  // ElevenLabs availability. Agents can opt in once they trust the basics.
  narrationEnabled: boolean;
  // v24.2: independent music toggle + volume. Previously music was
  // forced-on whenever a track existed. Now agents can ship voice-only,
  // music-only, or silent. musicVolume is 0.0-1.0, multiplied with the
  // worker's musicBedLevel at mix time (default 0.22).
  musicEnabled: boolean;
  musicVolume: number;
  // v24: target video length in seconds. 30s default for social-first
  // hero cuts, 60s max for longer-form listing tours. Drives scene count
  // in the edit plan generator (30s = 6 scenes for Cinematic AI).
  targetDurationSec: 30 | 60;
  // Default OFF — xfade crossfades require ~3-8 min of CPU on a 24-clip
  // render and OOM-killed Render Standard 2GB. Safe to enable on Pro 4GB+.
  crossfadesEnabled: boolean;
  // v23: Day-to-Dusk twilight conversion on the hero photo. Premium tier
  // only — costs ~$0.04 per render in Replicate compute. Default OFF.
  twilightHero: boolean;
  // v23.1: 4K Ultra HD output. Cinematic AI 4K tier ($299) only. Defaults
  // ON for 4K subscribers (they paid for it) but can be toggled OFF to
  // save render time on quick previews. Worker reads this as
  // manifest.export4K and upscales master + variants accordingly.
  export4K: boolean;
  // Render Safety — collapsed from the legacy trio (complianceMode,
  // protectHighRiskRooms, hallucinationGuard) into one setting. The
  // manifest builder translates this into the legacy fields the worker
  // already understands, so nothing on the render side has to change.
  //   "off"   — pure AI motion. Highest hallucination risk.
  //   "smart" — DEFAULT. Auto-protects kitchens, bathrooms, and any
  //             scene with appliances/parallel surfaces. AI everywhere
  //             else. Best mix of cinematic feel + reliability.
  //   "max"   — Ken Burns motion for every scene. Zero AI hallucination,
  //             MLS-grade safe.
  renderSafety: RenderSafety;
  editPlan: EditPlan | null;
  renderJob: RenderJobStatus | null;

  // UI
  loading: string;
  error: string;
  toast: string;
  // Counter the dashboard's PlanStatusBanner watches. Bumping this triggers
  // a re-fetch of /api/usage so the meter reflects the latest tier state
  // (e.g., right after a successful render that consumed a quota slot).
  usageRefresh: number;

  // Actions
  init: () => Promise<void>;
  hydrateBrandKit: () => Promise<void>;
  setSession: (s: Session | null) => void;
  setProfile: (p: UserProfile | null) => void;
  setOrganization: (org: Organization | null) => void;
  refreshOrganization: () => Promise<void>;
  goToScreen: (s: Screen) => void;

  newProject: () => void;
  openProject: (id: string) => void;

  setProjectTitle: (t: string) => void;
  setListing: (patch: Partial<ListingDetails>) => void;
  setBranding: (patch: Partial<AgentBranding>) => void;
  addPhotos: (photos: Photo[]) => void;
  removePhoto: (id: string) => void;
  reorderPhotos: (ids: string[]) => void;
  updatePhoto: (id: string, patch: Partial<Photo>) => void;
  // AI photo curation removed — photos render in upload (or drag-reordered) order.
  setStyle: (id: StyleId) => void;
  setMusicTrack: (trackId: string | null) => void;
  setEngine: (e: RenderEngine) => void;
  setNarrationEnabled: (enabled: boolean) => void;
  setMusicEnabled: (enabled: boolean) => void;
  setMusicVolume: (volume: number) => void;
  setTargetDuration: (sec: 30 | 60) => void;
  setCrossfadesEnabled: (enabled: boolean) => void;
  setTwilightHero: (enabled: boolean) => void;
  setExport4K: (enabled: boolean) => void;
  setRenderSafety: (level: RenderSafety) => void;
  setEditPlan: (plan: EditPlan | null) => void;
  setRenderJob: (job: RenderJobStatus | null) => void;
  setLoading: (msg: string) => void;
  setError: (msg: string) => void;
  setToast: (msg: string) => void;
  bumpUsageRefresh: () => void;
}

const newProjectId = () => `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const emptyListing: ListingDetails = {
  address: "",
  city: "",
  price: "",
  beds: "",
  baths: "",
  squareFeet: "",
  hook: ""
};

// Brand kit persistence — TWO layers, in order of preference:
//   1. Supabase brand_kits table (the source of truth, follows the user
//      across browsers + devices). Hydrated on auth.
//   2. localStorage (offline-friendly cache, used while waiting on the
//      Supabase fetch and as fallback when Supabase isn't configured).
//
// Writes go to BOTH layers. localStorage is synchronous; the Supabase
// write is debounced + fire-and-forget so typing in a brand kit field
// never blocks the UI.

const BRANDING_STORAGE_KEY = "estatemotion.brandkit.v2";
// v1 key kept around so users who saved a kit before v18 can be migrated
// forward instead of seeing an empty form. Pre-v18 the kit only held 5
// fields (fullName, brokerage, phone, email, headshotUrl); v2 added logo,
// license, voice. Migrating means: read v1, copy fields into v2 shape,
// write to v2, delete v1.
const BRANDING_STORAGE_KEY_V1 = "estatemotion.brandkit.v1";

const EMPTY_BRANDING: AgentBranding = {
  fullName: "",
  brokerage: "",
  phone: "",
  email: "",
  headshotUrl: "",
  brokerageLogoUrl: "",
  licenseNumber: "",
  voiceId: undefined,
  voiceLabel: undefined
};

function parseBrandingJson(raw: string): AgentBranding | null {
  try {
    const parsed = JSON.parse(raw);
    return {
      fullName: String(parsed.fullName || ""),
      brokerage: String(parsed.brokerage || ""),
      phone: String(parsed.phone || ""),
      email: String(parsed.email || ""),
      headshotUrl: String(parsed.headshotUrl || ""),
      brokerageLogoUrl: String(parsed.brokerageLogoUrl || ""),
      licenseNumber: String(parsed.licenseNumber || ""),
      voiceId: parsed.voiceId || undefined,
      voiceLabel: parsed.voiceLabel || undefined
    };
  } catch {
    return null;
  }
}

function loadStoredBranding(): AgentBranding {
  if (typeof window === "undefined") return EMPTY_BRANDING;
  try {
    // 1) Try v2 first (the current key).
    const rawV2 = window.localStorage.getItem(BRANDING_STORAGE_KEY);
    if (rawV2) {
      const parsed = parseBrandingJson(rawV2);
      if (parsed) return parsed;
    }
    // 2) BUG FIX (v1→v2 migration): if v2 is empty but v1 exists (user
    //    saved a brand kit before the v18 ship), migrate it forward so
    //    they don't see an empty form. Write to v2, delete v1.
    const rawV1 = window.localStorage.getItem(BRANDING_STORAGE_KEY_V1);
    if (rawV1) {
      const migrated = parseBrandingJson(rawV1);
      if (migrated) {
        window.localStorage.setItem(BRANDING_STORAGE_KEY, JSON.stringify(migrated));
        window.localStorage.removeItem(BRANDING_STORAGE_KEY_V1);
        return migrated;
      }
    }
    return EMPTY_BRANDING;
  } catch {
    return EMPTY_BRANDING;
  }
}

function persistBranding(branding: AgentBranding) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BRANDING_STORAGE_KEY, JSON.stringify(branding));
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
}

// Debounce the Supabase write so typing into "Phone" doesn't fire 10 PATCHes.
let brandKitSaveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSupabaseBrandSave(userId: string, branding: AgentBranding) {
  if (!userId) return;
  if (brandKitSaveTimer) clearTimeout(brandKitSaveTimer);
  brandKitSaveTimer = setTimeout(() => {
    saveBrandKit(userId, branding).catch(() => {});
  }, 600);
}

// Hydration race guard. `hydrateBrandKit` runs async on every sign-in.
// If the user starts editing branding before the Supabase fetch returns,
// the hydrate would overwrite their in-flight edits. We bump this counter
// every time setBranding is called, snapshot it before the fetch, and
// check at apply-time — if the counter moved while we were fetching, skip
// the apply because the user typed something we shouldn't clobber.
let brandEditEpoch = 0;

const emptyProject = () => ({
  projectId: newProjectId(),
  projectTitle: "Untitled listing",
  photos: [] as Photo[],
  listing: { ...emptyListing },
  branding: loadStoredBranding(),
  selectedStyleId: "cinematic-luxury" as StyleId,
  // null = use the style's default track. The MusicSelector flips this to
  // a specific track id when the user picks something other than the default.
  selectedMusicTrackId: null as string | null,
  renderEngine: "remotion" as RenderEngine,
  // v23.2: was false (which silently disabled narration on every render
  // since launch — nobody knew to turn it on). Now defaults true. The
  // worker still gracefully falls back to music-only if ElevenLabs is
  // unavailable, so this is safe.
  narrationEnabled: true,
  musicEnabled: true,
  // 1.0 = use the worker's default musicBedLevel as-is. 0.0 = silent.
  // 1.5 = music 50% louder than default. Slider in UI typically 0-1.5.
  musicVolume: 1.0,
  // v24: 30s default. Attention-span research + Troy's user-testing
  // showed people don't watch past ~30s of any listing video.
  targetDurationSec: 30 as 30 | 60,
  crossfadesEnabled: true,
  twilightHero: false,
  // Default ON — 4K-tier subscribers paid for 4K, give them 4K out of the
  // box. The RenderQualityPanel renders this as a toggleable switch only
  // for tier === cinematic_4k; other tiers see it locked at 1080p.
  export4K: true,
  // Default "smart" — the right answer for 95% of renders. AI motion
  // everywhere except scenes that score risky (kitchens with appliances,
  // anywhere mentioning fans/parallel surfaces).
  renderSafety: "smart" as RenderSafety,
  editPlan: null as EditPlan | null,
  renderJob: null as RenderJobStatus | null
});

export const useStore = create<AppState>((set, get) => ({
  session: null,
  authReady: false,
  profile: null,
  organization: null,
  organizationLoaded: false,
  screen: "auth",
  projectList: [],
  ...emptyProject(),
  loading: "",
  error: "",
  toast: "",
  usageRefresh: 0,

  init: async () => {
    const session = await getSession();
    set({
      session,
      authReady: true,
      screen: session ? "dashboard" : "auth"
    });
    if (session) {
      // Fire-and-forget — UI doesn't block on org lookup
      get().refreshOrganization().catch(() => {});
      // Hydrate brand kit from Supabase. If found, overwrite localStorage's
      // cached copy so the cloud is the source of truth on this device too.
      get().hydrateBrandKit().catch(() => {});
    }
    try {
      onAuthChange((s) => {
        const prev = get().session;
        set({ session: s });
        if (!prev && s) {
          set({ screen: "dashboard", error: "" });
          get().refreshOrganization().catch(() => {});
          // Same brand-kit hydration on subsequent sign-ins.
          get().hydrateBrandKit().catch(() => {});
        }
        if (prev && !s) set({
          ...emptyProject(),
          organization: null,
          organizationLoaded: false,
          screen: "auth",
          projectList: [],
          error: ""
        });
      });
    } catch {
      // Supabase not configured — auth state changes won't fire, but the
      // app still renders. The user will see an error when they try to sign in.
    }
  },

  hydrateBrandKit: async () => {
    const userId = get().session?.user?.id;
    if (!userId) return;
    // Snapshot the edit counter BEFORE the network call. If the user types
    // anything during the fetch, brandEditEpoch will increase and we'll
    // bail at apply-time without clobbering their edits.
    const snapshot = brandEditEpoch;
    const remote = await fetchBrandKit(userId);
    if (!remote) return; // user has no saved kit yet — leave localStorage as is
    if (brandEditEpoch !== snapshot) {
      console.info("[brand-kit] hydrate skipped — user edited branding mid-fetch.");
      return;
    }
    // Merge remote into current state, preferring remote fields when set.
    // (Empty strings in remote count as "set" — if the user explicitly
    //  cleared a field, that clear should propagate to this device too.)
    const next: AgentBranding = {
      fullName: remote.fullName ?? get().branding.fullName,
      brokerage: remote.brokerage ?? get().branding.brokerage,
      phone: remote.phone ?? get().branding.phone,
      email: remote.email ?? get().branding.email,
      headshotUrl: remote.headshotUrl ?? get().branding.headshotUrl,
      brokerageLogoUrl: remote.brokerageLogoUrl ?? get().branding.brokerageLogoUrl,
      licenseNumber: remote.licenseNumber ?? get().branding.licenseNumber,
      voiceId: remote.voiceId ?? get().branding.voiceId,
      voiceLabel: remote.voiceLabel ?? get().branding.voiceLabel
    };
    persistBranding(next);
    set({ branding: next });
  },

  setOrganization: (org) => set({ organization: org, organizationLoaded: true }),
  refreshOrganization: async () => {
    try {
      const org = await fetchOrganization();
      set({ organization: org, organizationLoaded: true });
    } catch {
      // Failure to fetch org shouldn't break the app — solo-agent mode
      // is the default fallback.
      set({ organization: null, organizationLoaded: true });
    }
  },

  setSession: (s) => set({ session: s }),
  setProfile: (p) => set({ profile: p }),
  goToScreen: (s) => set({ screen: s, error: "" }),

  newProject: () => set({ ...emptyProject(), screen: "project", error: "" }),
  openProject: (id) => {
    // Stub: in MVP we just open a fresh editor. Persistence comes later.
    const summary = get().projectList.find((p) => p.id === id);
    set({
      ...emptyProject(),
      projectId: id,
      projectTitle: summary?.title || "Listing",
      screen: "project"
    });
  },

  setProjectTitle: (t) => set({ projectTitle: t }),
  setListing: (patch) => set({ listing: { ...get().listing, ...patch } }),
  setBranding: (patch) => {
    // Bump the hydration race counter so any in-flight hydrateBrandKit
    // knows the user has typed and skips its overwrite at apply-time.
    brandEditEpoch++;
    const next = { ...get().branding, ...patch };
    persistBranding(next);
    set({ branding: next });
    // Mirror to Supabase (debounced). No-op when signed out.
    const userId = get().session?.user?.id;
    if (userId) scheduleSupabaseBrandSave(userId, next);
  },

  addPhotos: (newOnes) => {
    const existing = get().photos;
    const combined = [...existing, ...newOnes];
    const ordered = combined.map((p, i) => ({ ...p, order: i + 1 }));
    set({ photos: ordered, editPlan: null }); // adding photos invalidates the plan
  },
  removePhoto: (id) => {
    const remaining = get().photos.filter((p) => p.id !== id).map((p, i) => ({ ...p, order: i + 1 }));
    set({ photos: remaining, editPlan: null });
  },
  reorderPhotos: (ids) => {
    const map = new Map(get().photos.map((p) => [p.id, p]));
    const next = ids
      .map((id, i) => {
        const photo = map.get(id);
        if (!photo) return null;
        return { ...photo, order: i + 1 };
      })
      .filter((p): p is Photo => p !== null);
    set({ photos: next });
  },
  // curatePhotosWithAI removed — see api/curate-photos.js. The endpoint
  // still exists but nothing in the app calls it.
  updatePhoto: (id, patch) => {
    set({
      photos: get().photos.map((p) => (p.id === id ? { ...p, ...patch } : p))
    });
  },
  setStyle: (id) =>
    // Changing styles also resets music selection — the new style's default
    // takes over until the user picks something else.
    set({ selectedStyleId: id, selectedMusicTrackId: null, editPlan: null }),
  setMusicTrack: (trackId) => set({ selectedMusicTrackId: trackId }),
  setEngine: (e) => set({ renderEngine: e, editPlan: null }),
  setNarrationEnabled: (enabled) => set({ narrationEnabled: enabled, editPlan: null }),
  setMusicEnabled: (enabled) => set({ musicEnabled: enabled }),
  setMusicVolume: (volume) => set({ musicVolume: Math.max(0, Math.min(2, Number(volume) || 1)) }),
  setTargetDuration: (sec) => set({ targetDurationSec: sec, editPlan: null }),
  setCrossfadesEnabled: (enabled) => set({ crossfadesEnabled: enabled }),
  setTwilightHero: (enabled) => set({ twilightHero: enabled }),
  setExport4K: (enabled) => set({ export4K: enabled }),
  setRenderSafety: (level) => set({ renderSafety: level, editPlan: null }),
  setEditPlan: (plan) => set({ editPlan: plan }),
  setRenderJob: (job) => set({ renderJob: job }),
  setLoading: (msg) => set({ loading: msg }),
  setError: (msg) => set({ error: msg }),
  setToast: (msg) => {
    set({ toast: msg });
    if (msg) setTimeout(() => set((cur) => (cur.toast === msg ? { toast: "" } : {})), 3500);
  },
  bumpUsageRefresh: () => set((s) => ({ usageRefresh: s.usageRefresh + 1 }))
}));
