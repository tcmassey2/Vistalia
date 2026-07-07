// Vistalia — Meta Pixel (browser events).
//
// Runtime-injected: the fbq loader only runs when VITE_META_PIXEL_ID is set,
// so dev/preview builds never fire events and there's no snippet rotting in
// index.html. One source of truth for event names + purchase values.
//
// Events wired at launch (GROWTH_PLAN_500 §Week 0):
//   PageView  — on app boot
//   Lead      — successful signup (AuthScreen)
//   Purchase  — Stripe checkout return (?checkout=success), with value
//
// The ads account optimizes LINK_CLICKS until this pixel has ~200 Lead
// events; then the campaign switches to conversion optimization.

const PIXEL_ID = String(import.meta.env.VITE_META_PIXEL_ID || "").trim();

declare global {
  interface Window {
    fbq?: ((...args: unknown[]) => void) & { queue?: unknown[]; loaded?: boolean };
    _fbq?: unknown;
  }
}

let initialized = false;

export function initPixel(): void {
  if (initialized || !PIXEL_ID || typeof window === "undefined") return;
  initialized = true;
  // Standard Meta loader, minus the document.write path.
  const w = window;
  if (!w.fbq) {
    const fbq: Window["fbq"] = function (...args: unknown[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const f = fbq as any;
      if (f.callMethod) f.callMethod(...args);
      else f.queue.push(args);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fbq as any).push = fbq;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fbq as any).loaded = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fbq as any).version = "2.0";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fbq as any).queue = [];
    w.fbq = fbq;
    w._fbq = fbq;
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://connect.facebook.net/en_US/fbevents.js";
    document.head.appendChild(script);
  }
  w.fbq?.("init", PIXEL_ID);
  w.fbq?.("track", "PageView");
}

export function trackLead(): void {
  if (!PIXEL_ID) return;
  window.fbq?.("track", "Lead", { content_name: "signup" });
}

// q7 price map for Purchase values. Unknown tiers fire without a value
// rather than firing a wrong one.
const TIER_VALUES: Record<string, number> = {
  payg: 39,
  single: 39,
  pro: 69,
  studio: 149,
  pro_annual: 490,
  studio_annual: 990
};

export function trackPurchase(tierOrOffer: string): void {
  if (!PIXEL_ID) return;
  const key = String(tierOrOffer || "").toLowerCase();
  const value = TIER_VALUES[key];
  window.fbq?.(
    "track",
    "Purchase",
    value
      ? { value, currency: "USD", content_name: key }
      : { content_name: key || "unknown" }
  );
}

/* Reads Stripe's return params once per page load, fires Purchase, then
   scrubs the params so a refresh can't double-fire. Returns the tier when
   a successful checkout was detected so the caller can toast/celebrate. */
export function consumeCheckoutReturn(): string | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const checkout = url.searchParams.get("checkout");
  if (!checkout) return null;
  const tier = url.searchParams.get("tier") || url.searchParams.get("offer") || "";
  url.searchParams.delete("checkout");
  url.searchParams.delete("tier");
  url.searchParams.delete("offer");
  window.history.replaceState({}, "", url.toString());
  if (checkout === "success") {
    trackPurchase(tier);
    return tier || "unknown";
  }
  return null;
}
