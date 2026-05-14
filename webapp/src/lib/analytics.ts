// Tiny Plausible wrapper. The Plausible script is injected from /api/env
// when PLAUSIBLE_DOMAIN is configured; it exposes window.plausible.
// This module exists so the React code never has to think about whether
// analytics is loaded — it always calls track() and gets a no-op when
// it isn't.

type PlausibleProps = Record<string, string | number | boolean>;
type PlausibleFn = (event: string, options?: { props?: PlausibleProps }) => void;

declare global {
  interface Window {
    plausible?: PlausibleFn;
  }
}

export function track(event: string, props?: PlausibleProps) {
  try {
    if (typeof window === "undefined") return;
    if (!window.plausible) return; // script not loaded — no-op
    window.plausible(event, props ? { props } : undefined);
  } catch {
    /* analytics is best-effort, never throws into product code */
  }
}

// Conversion-funnel event names. Centralized so we don't typo them
// across the codebase and end up with two events for the same thing.
export const events = {
  signupStarted: "Signup Started",
  signupCompleted: "Signup Completed",
  signinCompleted: "Signin Completed",
  firstRenderStarted: "First Render Started",
  renderStarted: "Render Started",
  renderCompleted: "Render Completed",
  upgradeClicked: "Upgrade Clicked",
  checkoutCompleted: "Checkout Completed",
  trialExpired: "Trial Expired Seen",
  accountDeleted: "Account Deleted"
} as const;
