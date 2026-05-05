// Zustand store — single source of truth for app state.
// Three screens: auth, dashboard (projects list), project (editor).
// The project editor is a single view with sections (no wizard).

import { create } from "zustand";
import type { Session } from "@supabase/supabase-js";
import type {
  EditPlan,
  ListingDetails,
  Photo,
  RenderEngine,
  RenderJobStatus,
  StyleId,
  UserProfile
} from "./types";
import { onAuthChange, getSession } from "./supabase";

export type Screen = "auth" | "dashboard" | "project";

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

  // Routing
  screen: Screen;

  // Dashboard
  projectList: ProjectSummary[];

  // Active project (editor state)
  projectId: string;
  projectTitle: string;
  photos: Photo[];
  listing: ListingDetails;
  selectedStyleId: StyleId;
  renderEngine: RenderEngine;
  editPlan: EditPlan | null;
  renderJob: RenderJobStatus | null;

  // UI
  loading: string;
  error: string;
  toast: string;

  // Actions
  init: () => Promise<void>;
  setSession: (s: Session | null) => void;
  setProfile: (p: UserProfile | null) => void;
  goToScreen: (s: Screen) => void;

  newProject: () => void;
  openProject: (id: string) => void;

  setProjectTitle: (t: string) => void;
  setListing: (patch: Partial<ListingDetails>) => void;
  addPhotos: (photos: Photo[]) => void;
  removePhoto: (id: string) => void;
  reorderPhotos: (ids: string[]) => void;
  updatePhoto: (id: string, patch: Partial<Photo>) => void;
  setStyle: (id: StyleId) => void;
  setEngine: (e: RenderEngine) => void;
  setEditPlan: (plan: EditPlan | null) => void;
  setRenderJob: (job: RenderJobStatus | null) => void;
  setLoading: (msg: string) => void;
  setError: (msg: string) => void;
  setToast: (msg: string) => void;
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

const emptyProject = () => ({
  projectId: newProjectId(),
  projectTitle: "Untitled listing",
  photos: [] as Photo[],
  listing: { ...emptyListing },
  selectedStyleId: "cinematic-luxury" as StyleId,
  renderEngine: "remotion" as RenderEngine,
  editPlan: null as EditPlan | null,
  renderJob: null as RenderJobStatus | null
});

export const useStore = create<AppState>((set, get) => ({
  session: null,
  authReady: false,
  profile: null,
  screen: "auth",
  projectList: [],
  ...emptyProject(),
  loading: "",
  error: "",
  toast: "",

  init: async () => {
    const session = await getSession();
    set({
      session,
      authReady: true,
      screen: session ? "dashboard" : "auth"
    });
    try {
      onAuthChange((s) => {
        const prev = get().session;
        set({ session: s });
        if (!prev && s) set({ screen: "dashboard", error: "" });
        if (prev && !s) set({ ...emptyProject(), screen: "auth", projectList: [], error: "" });
      });
    } catch {
      // Supabase not configured — auth state changes won't fire, but the
      // app still renders. The user will see an error when they try to sign in.
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
  updatePhoto: (id, patch) => {
    set({
      photos: get().photos.map((p) => (p.id === id ? { ...p, ...patch } : p))
    });
  },
  setStyle: (id) => set({ selectedStyleId: id, editPlan: null }),
  setEngine: (e) => set({ renderEngine: e, editPlan: null }),
  setEditPlan: (plan) => set({ editPlan: plan }),
  setRenderJob: (job) => set({ renderJob: job }),
  setLoading: (msg) => set({ loading: msg }),
  setError: (msg) => set({ error: msg }),
  setToast: (msg) => {
    set({ toast: msg });
    if (msg) setTimeout(() => set((cur) => (cur.toast === msg ? { toast: "" } : {})), 3500);
  }
}));
