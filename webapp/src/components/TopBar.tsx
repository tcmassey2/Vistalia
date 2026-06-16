import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { signOut } from "../lib/supabase";

export default function TopBar() {
  const screen = useStore((s) => s.screen);
  const session = useStore((s) => s.session);
  const goToScreen = useStore((s) => s.goToScreen);
  const projectTitle = useStore((s) => s.projectTitle);
  const organization = useStore((s) => s.organization);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close the mobile menu on outside click + on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const onSignOut = async () => {
    try {
      await signOut();
    } catch {
      window.location.href = "/";
    }
  };

  const isWorkScreen = screen === "dashboard" || screen === "project";

  return (
    <header className="sticky top-0 z-20 border-b border-edge-soft bg-paper/85 backdrop-blur-md">
      <div className="max-w-6xl mx-auto px-5 sm:px-6 h-14 flex items-center justify-between gap-3">
        <button
          onClick={() => goToScreen("dashboard")}
          title="Home — your dashboard"
          aria-label="Home — your dashboard"
          className="flex items-center gap-2 text-ink hover:text-gold-light transition-colors flex-shrink-0"
        >
          <span className="grid place-items-center w-7 h-7 rounded-md bg-gradient-to-br from-gold-light to-gold-dim text-paper font-bold italic">
            E
          </span>
          <span className="font-semibold tracking-tightish hidden xs:inline">EstateMotion</span>
        </button>

        {screen === "project" && (
          <span className="hidden md:block text-sm text-ink-muted truncate max-w-md">
            {projectTitle}
          </span>
        )}

        {/* DESKTOP NAV — md+ shows every action inline (the original layout). */}
        <div className="hidden md:flex items-center gap-2 lg:gap-3">
          <NavButton active={isWorkScreen} onClick={() => goToScreen("dashboard")}>
            My work
          </NavButton>
          <NavButton active={screen === "brokerage"} onClick={() => goToScreen("brokerage")}>
            <span className="inline-flex items-center gap-1.5">
              Brokerage
              {organization && (
                <span className="text-[9px] font-bold tracking-widest px-1 py-px rounded bg-gold/20 text-gold-light uppercase">
                  {organization.role}
                </span>
              )}
            </span>
          </NavButton>
          <a
            href="/"
            className="btn-press text-xs text-ink-muted hover:text-ink px-3 py-1.5 rounded-md border border-transparent hover:border-edge transition-colors"
            title="View the public site"
          >
            View site
          </a>
          <a
            href="/help.html"
            target="_blank"
            rel="noopener"
            className="btn-press text-xs text-ink-muted hover:text-ink px-3 py-1.5 rounded-md border border-transparent hover:border-edge transition-colors"
            title="Help center & FAQ"
          >
            Help
          </a>
          <NavButton active={screen === "settings"} onClick={() => goToScreen("settings")}>
            Settings
          </NavButton>
          {session?.user?.email && (
            <span className="hidden lg:inline text-xs text-ink-muted ml-1 truncate max-w-[180px]">
              {session.user.email}
            </span>
          )}
          <button
            onClick={onSignOut}
            className="btn-press text-xs text-ink-muted hover:text-ink px-3 py-1.5 rounded-md border border-edge hover:border-edge-strong"
          >
            Sign out
          </button>
        </div>

        {/* MOBILE NAV — small screens show My work inline + a hamburger
            menu that contains everything else. The 5-button bar overflows
            an iPhone-13 width otherwise. */}
        <div className="md:hidden flex items-center gap-2">
          <button
            onClick={() => goToScreen("dashboard")}
            className={`btn-press text-xs px-3 py-1.5 rounded-md transition-colors ${
              isWorkScreen
                ? "text-ink bg-surface-input border border-edge-strong"
                : "text-ink-muted border border-transparent"
            }`}
          >
            My work
          </button>
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="btn-press grid place-items-center w-10 h-10 rounded-md border border-edge bg-surface text-ink hover:border-gold transition-colors"
              aria-label="Menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              {/* Three-line icon */}
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <line x1="3" y1="5" x2="15" y2="5" />
                <line x1="3" y1="9" x2="15" y2="9" />
                <line x1="3" y1="13" x2="15" y2="13" />
              </svg>
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full mt-2 w-56 bg-surface-raised border border-edge rounded-xl shadow-2xl py-1 overflow-hidden"
              >
                {session?.user?.email && (
                  <div className="px-4 py-2.5 border-b border-edge-soft">
                    <div className="text-[10px] uppercase tracking-widest text-ink-dim font-mono mb-0.5">
                      Signed in
                    </div>
                    <div className="text-xs text-ink-muted truncate">{session.user.email}</div>
                  </div>
                )}
                <MenuItem
                  active={screen === "brokerage"}
                  onClick={() => { goToScreen("brokerage"); setMenuOpen(false); }}
                >
                  Brokerage
                  {organization && (
                    <span className="ml-auto text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded bg-gold/20 text-gold-light uppercase">
                      {organization.role}
                    </span>
                  )}
                </MenuItem>
                <MenuItem
                  active={screen === "settings"}
                  onClick={() => { goToScreen("settings"); setMenuOpen(false); }}
                >
                  Settings
                </MenuItem>
                <a
                  role="menuitem"
                  href="/"
                  onClick={() => setMenuOpen(false)}
                  className="block px-4 py-2.5 text-sm text-ink-muted hover:bg-surface-input hover:text-ink transition-colors"
                >
                  View site
                </a>
                <a
                  role="menuitem"
                  href="/help.html"
                  target="_blank"
                  rel="noopener"
                  onClick={() => setMenuOpen(false)}
                  className="block px-4 py-2.5 text-sm text-ink-muted hover:bg-surface-input hover:text-ink transition-colors"
                >
                  Help center
                </a>
                <div className="border-t border-edge-soft mt-1 pt-1">
                  <MenuItem onClick={() => { setMenuOpen(false); onSignOut(); }}>
                    Sign out
                  </MenuItem>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

function NavButton({
  active,
  onClick,
  children
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`btn-press text-xs px-3 py-1.5 rounded-md transition-colors ${
        active
          ? "text-ink bg-surface-input border border-edge-strong"
          : "text-ink-muted hover:text-ink border border-transparent"
      }`}
    >
      {children}
    </button>
  );
}

function MenuItem({
  active,
  onClick,
  children
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={
        "w-full text-left px-4 py-2.5 text-sm transition-colors flex items-center gap-2 " +
        (active
          ? "bg-surface-input text-ink"
          : "text-ink-muted hover:bg-surface-input hover:text-ink")
      }
    >
      {children}
    </button>
  );
}
