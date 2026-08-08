// Vistalia — Meta Pixel (browser events).
//
// Runtime-injected: the fbq loader only runs when VITE_META_PIXEL_ID is set,
// so dev/preview builds never fire events and there's no snippet rotting in
// index.html. One source of truth for event names + purchase values.
//
// Events wired at launch (GROWTH_PLAN_500 §Week 0), completed v62.55 —
// the full funnel Troy's UGC campaign optimizes on
// (ad → signup → free watermarked render → $39 unlock):
//   PageView         — on app boot
//   Lead             — successful signup (AuthScreen)
//   StartTrial       — free watermarked render accepted (ProjectScreen);
//                      the mid-funnel event with real volume, so the
//                      campaign can conversion-optimize long before
//                      Purchase counts are statistically usable
//   InitiateCheckout — paywall tier clicked, pre-Stripe (PaywallModal)
//   Purchase         — Stripe checkout return (?checkout=success), with value
//
// The ads account optimizes LINK_CLICKS until this pixel has ~200 of the
// target event; then the campaign switches to conversion optimization.
// NOTE: everything below no-ops until VITE_META_PIXEL_ID is set in the
// Vercel BUILD environment (it is a build-time var — set it, redeploy).

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

// v62.84: first-touch attribution captured by the static site's head snippet
// (?src / utm_* / fbclid → localStorage "vistalia.attribution.v1", same
// origin as /app). It rides along on conversion events as custom params, so
// per-channel conversion counts read straight out of Events Manager — the
// weekly ritual's "?src visits → StartTrial" join, with no backend column.
// Fail-open: no stored attribution → events fire exactly as before.
function attribution(): Record<string, string> {
  try {
    const raw = localStorage.getItem("vistalia.attribution.v1");
    if (!raw) return {};
    const d = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const k of ["src", "utm_source", "utm_campaign", "landing"]) {
      const v = d[k];
      if (typeof v === "string" && v) out[k] = v.slice(0, 120);
    }
    return out;
  } catch {
    return {};
  }
}

export function trackLead(): void {
  if (!PIXEL_ID) return;
  window.fbq?.("track", "Lead", { content_name: "signup", ...attribution() });
}

// v62.55: the free watermarked render — the funnel's mid-step and the
// event with enough volume to conversion-optimize on from week one.
// predicted_ltv carries the $39 unlock this trial is expected to become.
export function trackStartTrial(): void {
  if (!PIXEL_ID) return;
  window.fbq?.("track", "StartTrial", {
    value: 0,
    currency: "USD",
    content_name: "free_watermarked_render",
    predicted_ltv: 39,
    ...attribution()
  });
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

// v62.55: paywall click, pre-Stripe. Meta reads InitiateCheckout→Purchase
// as the checkout-abandonment gap — the number that tells us whether the
// $39 price or the Stripe page is losing people.
export function trackInitiateCheckout(tierOrOffer: string): void {
  if (!PIXEL_ID) return;
  const key = String(tierOrOffer || "").toLowerCase();
  const value = TIER_VALUES[key];
  window.fbq?.(
    "track",
    "InitiateCheckout",
    value
      ? { value, currency: "USD", content_name: key }
      : { content_name: key || "unknown" }
  );
}

export function trackPurchase(tierOrOffer: string): void {
  if (!PIXEL_ID) return;
  const key = String(tierOrOffer || "").toLowerCase();
  const value = TIER_VALUES[key];
  window.fbq?.(
    "track",
    "Purchase",
    value
      ? { value, currency: "USD", content_name: key, ...attribution() }
      : { content_name: key || "unknown", ...attribution() }
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
