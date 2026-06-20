import { useEffect, useState } from "react";
import { useStore } from "../lib/store";

/**
 * Toast — single-instance notification at the bottom-right.
 *
 * Slide-in animation, click to dismiss, auto-fade after the store's
 * 3.5s timer. Visually mirrors the rest of the brand: surface card with
 * gold accent stripe on the left so it reads as part of Vistalia
 * rather than a generic OS notification.
 *
 * Detects the message type heuristically:
 *   - "Failed", "Error", "Couldn't" → muted-red accent
 *   - default                       → gold accent
 *   - everything else stays neutral with the gold dot
 */
export default function Toast() {
  const toast = useStore((s) => s.toast);
  const setToast = useStore((s) => s.setToast);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (toast) {
      // Trigger the slide-in by setting mounted on the next frame.
      requestAnimationFrame(() => setMounted(true));
    } else {
      setMounted(false);
    }
  }, [toast]);

  if (!toast) return null;

  const isError = /failed|error|couldn'?t|invalid|expired/i.test(toast);

  return (
    <div
      className={
        "fixed bottom-6 right-6 z-50 max-w-sm transition-all duration-200 ease-out " +
        (mounted
          ? "translate-x-0 opacity-100"
          : "translate-x-6 opacity-0")
      }
      role="status"
      aria-live="polite"
    >
      <div
        className={
          "flex items-start gap-3 pl-4 pr-3 py-3 rounded-xl bg-surface-raised border shadow-2xl backdrop-blur-md " +
          (isError
            ? "border-red-500/30 bg-red-500/[0.04]"
            : "border-edge")
        }
      >
        {/* Accent stripe on the left edge */}
        <div
          className={
            "w-1 self-stretch rounded-full " +
            (isError ? "bg-red-400/80" : "bg-gold")
          }
        />
        <div className="flex-1 min-w-0 pt-0.5">
          <div className="text-sm text-ink leading-snug">{toast}</div>
        </div>
        <button
          type="button"
          onClick={() => setToast("")}
          className="text-ink-muted hover:text-ink transition-colors p-1 -m-1 leading-none"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
