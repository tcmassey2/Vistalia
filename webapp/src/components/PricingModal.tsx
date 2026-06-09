import { useEffect, useState } from "react";
import { startCheckout, fetchUsage, type CheckoutTier } from "../lib/api";
import { useStore } from "../lib/store";

/**
 * PricingModal — in-app upgrade picker.
 *
 * Three tiers (matching the landing page + STRIPE_PRICE_* env vars):
 *   - Quick Reel       $79/mo   — 10 videos
 *   - Cinematic AI     $149/mo  — 25 videos (most popular)
 *   - Cinematic AI 4K  $299/mo  — 60 videos + 4K + premium features
 *
 * On select: hits POST /api/create-checkout-session and redirects the
 * browser to the Stripe-hosted checkout URL. On return Stripe lands the
 * user back on /app/?checkout=success which the rest of the app handles.
 *
 * The user's current tier is highlighted; their button changes to "Current
 * plan" (disabled) so they can't double-subscribe.
 */

interface PricingModalProps {
  open: boolean;
  onClose: () => void;
}

interface TierCard {
  slug: CheckoutTier;
  name: string;
  tagline: string;
  price: string;
  features: string[];
  featured?: boolean;
}

const TIERS: TierCard[] = [
  {
    slug: "quick_reel",
    name: "Quick Reel",
    tagline: "For agents shipping listings every week.",
    price: "$79",
    features: [
      "10 finished videos per month",
      "Cinematic photo motion",
      "HD 1080p output, 9:16 vertical",
      "Branded outro with your contact details",
      "Music library access",
      "Email support"
    ]
  },
  {
    slug: "cinematic_ai",
    name: "Cinematic AI",
    tagline: "For agents who want the difference buyers feel.",
    price: "$149",
    featured: true,
    features: [
      "25 finished videos per month",
      "True AI image-to-video (Runway Gen-4)",
      "AI photo upscale on small images",
      "Animated address card opener",
      "Priority rendering queue",
      "Priority chat support"
    ]
  },
  {
    slug: "cinematic_4k",
    name: "Cinematic AI Pro",
    tagline: "For luxury teams and brokerages.",
    price: "$299",
    features: [
      "60 finished videos per month",
      "Runway Gen-4 Turbo — same AI engine, no daily cap",
      "Priority rendering — front of the queue",
      "60-second video length option",
      "Brokerage white-label branding",
      "Concierge onboarding",
      "Premium chat + email support"
    ]
  }
];

export default function PricingModal({ open, onClose }: PricingModalProps) {
  const session = useStore((s) => s.session);
  const [busy, setBusy] = useState<CheckoutTier | null>(null);
  const [error, setError] = useState("");
  // Fetch the user's current tier on open so we can mark the right card
  // as "Current plan" — the store doesn't carry usage globally.
  const [currentTier, setCurrentTier] = useState<string>("trial");

  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetchUsage()
      .then((u) => { if (alive && u?.tier) setCurrentTier(String(u.tier)); })
      .catch(() => { /* fall back to "trial" assumption */ });
    return () => { alive = false; };
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const userEmail = session?.user?.email || "";

  const handlePick = async (tier: CheckoutTier) => {
    setBusy(tier);
    setError("");
    try {
      const result = await startCheckout({
        tier,
        email: userEmail,
        returnUrl: `${window.location.origin}/app/`
      });
      if (result.url) {
        // Stripe-hosted checkout takes over from here.
        window.location.href = result.url;
        return;
      }
      setError(result.error || "Couldn't start checkout. Try again.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start checkout.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/72 backdrop-blur-sm flex items-start sm:items-center justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      {/* v26: dialog semantics for assistive tech. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Pick a plan"
        className="relative w-full max-w-5xl bg-surface rounded-2xl border border-edge shadow-2xl my-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-6 sm:px-8 py-5 border-b border-edge-soft">
          <div>
            <h2 className="text-lg font-semibold tracking-tightish">Pick a plan</h2>
            <p className="text-xs text-ink-muted mt-1">
              7-day free trial on every plan. Cancel any time from Settings.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid place-items-center w-9 h-9 rounded-full bg-surface-input border border-edge hover:border-gold text-ink-muted hover:text-ink transition-colors flex-shrink-0"
          >
            ×
          </button>
        </div>

        <div className="px-6 sm:px-8 py-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          {TIERS.map((tier) => {
            const isCurrent = currentTier === tier.slug;
            const isBusy = busy === tier.slug;
            return (
              <div
                key={tier.slug}
                className={
                  "relative rounded-xl border p-5 flex flex-col gap-4 transition-colors " +
                  (tier.featured
                    ? "border-gold bg-gold/5"
                    : "border-edge bg-surface-input")
                }
              >
                {tier.featured && (
                  <span className="absolute -top-3 left-5 text-[9px] font-bold tracking-widest px-2 py-1 rounded-full bg-gold text-paper uppercase">
                    Most popular
                  </span>
                )}
                <div>
                  <div className="text-sm font-semibold tracking-tightish text-ink">{tier.name}</div>
                  <div className="text-xs text-ink-muted mt-1 leading-relaxed">{tier.tagline}</div>
                </div>
                <div className="text-3xl font-bold tracking-tight text-ink">
                  {tier.price}
                  <span className="text-sm font-medium text-ink-muted ml-1">/mo</span>
                </div>
                <ul className="flex flex-col gap-2 text-xs text-ink-muted leading-relaxed flex-1">
                  {tier.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2">
                      <span className="text-gold mt-0.5 flex-shrink-0">✓</span>
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => handlePick(tier.slug)}
                  disabled={isCurrent || isBusy || !!busy}
                  className={
                    "card-press h-10 px-4 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed " +
                    (isCurrent
                      ? "bg-surface text-ink-muted border border-edge"
                      : tier.featured
                        ? "bg-gold text-paper hover:bg-gold-light"
                        : "bg-surface-raised text-ink border border-edge hover:border-gold")
                  }
                >
                  {isCurrent ? "Current plan" : isBusy ? "Opening Stripe…" : "Choose this plan"}
                </button>
              </div>
            );
          })}
        </div>

        {error && (
          <div className="mx-6 sm:mx-8 mb-4 px-3 py-2.5 rounded-lg border border-red-500/30 bg-red-500/10 text-xs text-red-300">
            {error}
          </div>
        )}

        <div className="px-6 sm:px-8 pb-6 text-[11px] text-ink-dim leading-relaxed">
          Payments handled by Stripe. We never see your card. Plan changes take effect
          on the next billing cycle. Cancel anytime — no penalties, no questions asked.
        </div>
      </div>
    </div>
  );
}
