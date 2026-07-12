import { useEffect, Component, type ReactNode } from "react";
import { useStore } from "./lib/store";
import AuthScreen from "./screens/AuthScreen";
import DashboardScreen from "./screens/DashboardScreen";
import ProjectScreen from "./screens/ProjectScreen";
import BrokerageScreen from "./screens/BrokerageScreen";
import SettingsScreen from "./screens/SettingsScreen";
import EditStudioScreen from "./screens/EditStudioScreen";
import TopBar from "./components/TopBar";
import Toast from "./components/Toast";
import PolishFX from "./components/PolishFX";
import { initPixel, consumeCheckoutReturn } from "./lib/pixel";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center px-6">
          <div className="w-full max-w-md bg-surface border border-red-500/30 rounded-2xl p-8 text-center">
            <div className="text-red-400 text-lg font-semibold mb-2">Something went wrong</div>
            <pre className="text-xs text-ink-muted text-left bg-surface-input rounded-lg p-4 overflow-auto max-h-48 mt-4">
              {this.state.error.message}
              {"\n"}
              {this.state.error.stack}
            </pre>
            <button
              onClick={() => window.location.reload()}
              className="mt-6 h-10 px-6 bg-gold hover:bg-gold-light text-paper font-semibold rounded-lg transition-colors text-sm"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const init = useStore((s) => s.init);
  const screen = useStore((s) => s.screen);
  const authReady = useStore((s) => s.authReady);

  useEffect(() => {
    init();
    // Meta pixel: PageView on boot; if this load is a Stripe checkout
    // return (?checkout=success&tier=…), fire Purchase with the q7 value
    // and scrub the params so refresh can't double-fire. No-ops entirely
    // when VITE_META_PIXEL_ID is unset (dev/preview).
    initPixel();
    const purchasedTier = consumeCheckoutReturn();
    if (purchasedTier) {
      useStore.getState().setToast("You're in — welcome to Vistalia. Your plan is active.");
    }
  }, [init]);

  // v45.9: if a render was in flight when the tab reloaded, boot straight
  // back into the render screen instead of My Work. ProjectScreen's
  // reconnect effect then resumes live polling on the saved jobId.
  useEffect(() => {
    if (!authReady) return;
    try {
      const raw = localStorage.getItem("vistalia.active-render.v1");
      if (!raw) return;
      const saved = JSON.parse(raw) as { jobId?: string; startedAt?: number };
      if (saved?.jobId && Date.now() - (saved.startedAt || 0) < 35 * 60 * 1000) {
        useStore.getState().goToScreen("project");
      }
    } catch {
      /* ignore */
    }
  }, [authReady]);

  if (!authReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="spinner" aria-label="Loading" />
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <PolishFX />
      {screen !== "auth" && <TopBar />}
      {/*
        Re-keying <main> on screen change forces a fresh mount, which
        re-runs the fade-up-in animation each time. Cheap "page transition"
        feel without bringing in a router. Adds ~180ms of soft entry on
        every Dashboard ↔ Project ↔ Settings hop.
      */}
      <main key={screen} className="fade-up-in">
        {screen === "auth" && <AuthScreen />}
        {screen === "dashboard" && <DashboardScreen />}
        {screen === "project" && <ProjectScreen />}
        {screen === "brokerage" && <BrokerageScreen />}
        {screen === "settings" && <SettingsScreen />}
        {screen === "editStudio" && <EditStudioScreen />}
      </main>
      <Toast />
    </ErrorBoundary>
  );
}
