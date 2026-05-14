import { useStore } from "../lib/store";
import { signOut } from "../lib/supabase";

export default function TopBar() {
  const screen = useStore((s) => s.screen);
  const session = useStore((s) => s.session);
  const goToScreen = useStore((s) => s.goToScreen);
  const projectTitle = useStore((s) => s.projectTitle);
  const organization = useStore((s) => s.organization);

  const onSignOut = async () => {
    try {
      await signOut();
    } catch {
      window.location.href = "/";
    }
  };

  return (
    <header className="sticky top-0 z-20 border-b border-edge-soft bg-paper/85 backdrop-blur-md">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between gap-4">
        <button
          onClick={() => goToScreen("dashboard")}
          className="flex items-center gap-2 text-ink hover:text-gold-light transition-colors"
        >
          <span className="grid place-items-center w-7 h-7 rounded-md bg-gradient-to-br from-gold-light to-gold-dim text-paper font-bold italic">
            E
          </span>
          <span className="font-semibold tracking-tightish">EstateMotion</span>
        </button>

        {screen === "project" && (
          <span className="hidden md:block text-sm text-ink-muted truncate max-w-md">
            {projectTitle}
          </span>
        )}

        <div className="flex items-center gap-2 sm:gap-3">
          <button
            onClick={() => goToScreen("dashboard")}
            className={`btn-press text-xs px-3 py-1.5 rounded-md transition-colors ${
              screen === "dashboard" || screen === "project"
                ? "text-ink bg-surface-input border border-edge-strong"
                : "text-ink-muted hover:text-ink border border-transparent"
            }`}
          >
            My work
          </button>
          <button
            onClick={() => goToScreen("brokerage")}
            className={`btn-press text-xs px-3 py-1.5 rounded-md transition-colors inline-flex items-center gap-1.5 ${
              screen === "brokerage"
                ? "text-ink bg-surface-input border border-edge-strong"
                : "text-ink-muted hover:text-ink border border-transparent"
            }`}
          >
            Brokerage
            {organization && (
              <span className="text-[9px] font-bold tracking-widest px-1 py-px rounded bg-gold/20 text-gold-light uppercase">
                {organization.role}
              </span>
            )}
          </button>
          <a
            href="/help.html"
            target="_blank"
            rel="noopener"
            className="btn-press text-xs text-ink-muted hover:text-ink px-3 py-1.5 rounded-md border border-transparent hover:border-edge transition-colors"
            title="Help center & FAQ"
          >
            Help
          </a>
          <button
            onClick={() => goToScreen("settings")}
            className={`btn-press text-xs px-3 py-1.5 rounded-md transition-colors inline-flex items-center gap-1.5 ${
              screen === "settings"
                ? "text-ink bg-surface-input border border-edge-strong"
                : "text-ink-muted hover:text-ink border border-transparent"
            }`}
            title="Account & billing"
          >
            Settings
          </button>
          {session?.user?.email && (
            <span className="hidden lg:inline text-xs text-ink-muted ml-1">{session.user.email}</span>
          )}
          <button
            onClick={onSignOut}
            className="btn-press text-xs text-ink-muted hover:text-ink px-3 py-1.5 rounded-md border border-edge hover:border-edge-strong"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
