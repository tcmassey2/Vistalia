import { useEffect, useRef } from "react";
import { env } from "../lib/env";

/**
 * Cloudflare Turnstile widget — the low-friction CAPTCHA. Loads the Turnstile
 * script on first mount, renders the (usually invisible / one-click) widget,
 * and reports the token back via onVerify. Drop-in replacement for the old
 * hCaptcha widget; Supabase Auth verifies the token server-side when its
 * CAPTCHA provider is set to "Turnstile".
 *
 * Renders nothing when TURNSTILE_SITE_KEY isn't configured (dev/staging), so
 * auth just works without a captcha — safe because Supabase's CAPTCHA toggle is
 * also server-side. Either both are on or both are off.
 */

interface TurnstileInstance {
  render: (
    container: HTMLElement,
    opts: {
      sitekey: string;
      theme?: "light" | "dark" | "auto";
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: (err: unknown) => void;
    }
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileInstance;
  }
}

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export default function Turnstile({
  onVerify,
  onExpire
}: {
  onVerify: (token: string) => void;
  onExpire?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const siteKey = env().TURNSTILE_SITE_KEY || "";

  useEffect(() => {
    if (!siteKey || !containerRef.current) return;
    let cancelled = false;
    let mountedWidgetId: string | null = null;

    const renderWidget = () => {
      if (cancelled || !window.turnstile || !containerRef.current) return;
      try {
        mountedWidgetId = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme: "dark",
          callback: (token: string) => onVerify(token),
          "expired-callback": () => onExpire?.(),
          "error-callback": (err: unknown) => {
            console.warn("[turnstile] widget error:", err);
          }
        });
        widgetIdRef.current = mountedWidgetId;
      } catch (err) {
        console.warn("[turnstile] render failed:", err);
      }
    };

    const ensureScript = (): Promise<void> =>
      new Promise((resolve, reject) => {
        if (window.turnstile) return resolve();
        const existing = document.querySelector('script[data-turnstile="1"]') as HTMLScriptElement | null;
        if (existing) {
          const check = setInterval(() => {
            if (window.turnstile) {
              clearInterval(check);
              resolve();
            }
          }, 100);
          setTimeout(() => clearInterval(check), 10000);
          return;
        }
        const script = document.createElement("script");
        script.src = SCRIPT_URL;
        script.async = true;
        script.defer = true;
        script.setAttribute("data-turnstile", "1");
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("turnstile script failed"));
        document.head.appendChild(script);
      });

    ensureScript().then(renderWidget).catch((err) => {
      console.warn("[turnstile] script load failed:", err);
    });

    return () => {
      cancelled = true;
      if (mountedWidgetId && window.turnstile) {
        try { window.turnstile.remove(mountedWidgetId); } catch { /* noop */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  if (!siteKey) return null; // CAPTCHA not configured — render nothing.
  return <div ref={containerRef} className="flex justify-center my-2" />;
}
