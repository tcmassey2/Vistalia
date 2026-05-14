import { useEffect, useRef } from "react";
import { env } from "../lib/env";

/**
 * Tiny hCaptcha widget. Loads the hCaptcha script on first mount, renders
 * the invisible-by-default widget into a fresh div, and reports the
 * token back via onVerify.
 *
 * Renders nothing when HCAPTCHA_SITE_KEY isn't configured (dev / staging),
 * which means signup just works without the captcha — safe because Supabase
 * Auth's CAPTCHA enforcement is also a server-side toggle. Either both are
 * on or both are off.
 */

interface HCaptchaInstance {
  render: (
    container: HTMLElement,
    opts: {
      sitekey: string;
      theme?: "light" | "dark";
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
    hcaptcha?: HCaptchaInstance;
  }
}

const SCRIPT_URL = "https://js.hcaptcha.com/1/api.js?render=explicit";

export default function HCaptcha({
  onVerify,
  onExpire
}: {
  onVerify: (token: string) => void;
  onExpire?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const siteKey = env().HCAPTCHA_SITE_KEY || "";

  useEffect(() => {
    if (!siteKey || !containerRef.current) return;
    let cancelled = false;
    let mountedWidgetId: string | null = null;

    const renderWidget = () => {
      if (cancelled || !window.hcaptcha || !containerRef.current) return;
      try {
        mountedWidgetId = window.hcaptcha.render(containerRef.current, {
          sitekey: siteKey,
          theme: "dark",
          callback: (token: string) => onVerify(token),
          "expired-callback": () => onExpire?.(),
          "error-callback": (err: unknown) => {
            console.warn("[hcaptcha] widget error:", err);
          }
        });
        widgetIdRef.current = mountedWidgetId;
      } catch (err) {
        console.warn("[hcaptcha] render failed:", err);
      }
    };

    const ensureScript = (): Promise<void> =>
      new Promise((resolve, reject) => {
        if (window.hcaptcha) return resolve();
        const existing = document.querySelector('script[data-hcaptcha="1"]') as HTMLScriptElement | null;
        if (existing) {
          // Another instance is already loading; wait for it.
          const check = setInterval(() => {
            if (window.hcaptcha) {
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
        script.setAttribute("data-hcaptcha", "1");
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("hcaptcha script failed"));
        document.head.appendChild(script);
      });

    ensureScript().then(renderWidget).catch((err) => {
      console.warn("[hcaptcha] script load failed:", err);
    });

    return () => {
      cancelled = true;
      // Clean up the widget so re-renders don't stack iframes.
      if (mountedWidgetId && window.hcaptcha) {
        try { window.hcaptcha.remove(mountedWidgetId); } catch { /* noop */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  if (!siteKey) return null; // CAPTCHA not configured — render nothing.
  return <div ref={containerRef} className="flex justify-center my-2" />;
}
