import { useEffect, Component, type ReactNode } from "react";
import { useStore } from "./lib/store";
import AuthScreen from "./screens/AuthScreen";
import DashboardScreen from "./screens/DashboardScreen";
import ProjectScreen from "./screens/ProjectScreen";
import BrokerageScreen from "./screens/BrokerageScreen";
import TopBar from "./components/TopBar";
import Toast from "./components/Toast";

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
  }, [init]);

  if (!authReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="spinner" aria-label="Loading" />
      </div>
    );
  }

  return (
    <ErrorBoundary>
      {screen !== "auth" && <TopBar />}
      <main>
        {screen === "auth" && <AuthScreen />}
        {screen === "dashboard" && <DashboardScreen />}
        {screen === "project" && <ProjectScreen />}
        {screen === "brokerage" && <BrokerageScreen />}
      </main>
      <Toast />
    </ErrorBoundary>
  );
}
