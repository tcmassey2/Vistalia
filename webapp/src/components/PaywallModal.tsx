import { useEffect, useState } from "react";
import { startCheckout, type CheckoutTier } from "../lib/api";
import { useStore } from "../lib/store";

/**
 * PaywallModal — the free-video → paid moment (q6 subscription model).
 *
 * Two plans (Pro / Studio), billed monthly or annually, plus a $39 one-off
 * "pay as you go" video. Annual is the DEFAULT toggle: it shows a lower
 * monthly-equivalent headline (Reel-E plays this exact card) and ~2 months
 * free vs paying monthly. Tier slugs map to Stripe in create-checkout-session:
 *   pro / pro_annual / studio / studio_annual  → subscriptions
 *   payg                                        → one-time $39 (1 credit)
 */

interface PaywallModalProps {
  open: boolean;
  onClose: () => void;
  /** Optional context line, e.g. the gate reason from /api/usage. */
  reason?: string;
}

type Billing = "annual" | "monthly";

interface Plan {
  name: string;
  videos: string;
  popular?: boolean;
  monthly: { price: number; tier: CheckoutTier };
  annual: { perMo: number; yearly: number; tier: CheckoutTier };
  features: string[];
}

const PLANS: Plan[] = [
  {
    name: "Pro",
    videos: "5 videos / month",
    popular: true,
    monthly: { price: 49, tier: "pro" },
    annual: { perMo: 41, yearly: 490, tier: "pro_annual" },
    features: [
      "5 cinematic listing videos / month",
      "Narrated in your own cloned voice",
      "60-second tours + all formats",
      "Priority rendering"
    ]
  },
  {
    name: "Studio",
    videos: "10 videos / month",
    monthly: { price: 99, tier: "studio" },
    annual: { perMo: 83, yearly: 990, tier: "studio_annual" },
    features: [
      "10 cinematic listing videos / month",
      "Everything in Pro",
      "Front-of-queue rendering",
      "Priority support"
    ]
  }
];

export default function PaywallModal({ open, onClose, reason }: PaywallModalProps) {
  const session = useStore((s) => s.session);
  const [billing, setBilling] = useState<Billing>("annual"); // default = annual
  const [busy, setBusy] = useState<CheckoutTier | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleBuy = async (tier: CheckoutTier) => {
    setBusy(tier);
    setError("");
    try {
      const result = await startCheckout({
        tier,
        email: session?.user?.email || "",
        returnUrl: `${window.location.origin}/app/`
      });
      if (result.url) {
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
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose a plan"
        className="spring-in relative w-full max-w-3xl bg-surface rounded-2xl border border-edge shadow-2xl my-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-6 sm:px-8 py-5 border-b border-edge-soft">
          <div>
            <h2 className="font-display text-2xl font-semibold tracking-tighter2">Keep rendering</h2>
            <p className="text-xs text-ink-muted mt-1.5">
              {reason || "You've used your free video. Pick a plan to keep creating cinematic listings in your own voice."}
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

        {/* Billing toggle — annual is preselected */}
        <div className="flex items-center justify-center gap-3 pt-6">
          <div className="inline-flex items-center rounded-full border border-edge bg-surface-input p-1">
            <button
              type="button"
              onClick={() => setBilling("annual")}
              className={
                "px-4 h-8 rounded-full text-xs font-semibold transition-colors " +
                (billing === "annual" ? "bg-gold text-paper" : "text-ink-muted hover:text-ink")
              }
            >
              Annual
            </button>
            <button
              type="button"
              onClick={() => setBilling("monthly")}
              className={
                "px-4 h-8 rounded-full text-xs font-semibold transition-colors " +
                (billing === "monthly" ? "bg-gold text-paper" : "text-ink-muted hover:text-ink")
              }
            >
              Monthly
            </button>
          </div>
          <span className="text-[11px] font-semibold text-emerald-400">
            {billing === "annual" ? "2 months free" : "Save with annual"}
          </span>
        </div>

        <div className="px-6 sm:px-8 py-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
          {PLANS.map((plan) => {
            const isAnnual = billing === "annual";
            const tier = isAnnual ? plan.annual.tier : plan.monthly.tier;
            const bigPrice = isAnnual ? plan.annual.perMo : plan.monthly.price;
            const isBusy = busy === tier;
            return (
              <div
                key={plan.name}
                className={
                  "relative rounded-xl border p-5 flex flex-col gap-3 transition-colors " +
                  (plan.popular ? "border-gold bg-gold/5" : "border-edge bg-surface-input")
                }
              >
                {plan.popular && (
                  <span className="absolute -top-3 left-5 text-[9px] font-bold tracking-widest px-2 py-1 rounded-full bg-gold text-paper uppercase">
                    Most popular
                  </span>
                )}
                <div className="text-sm font-semibold tracking-tightish text-ink">{plan.name}</div>
                <div className="font-display text-4xl font-semibold tracking-tighter2 text-ink">
                  ${bigPrice}
                  <span className="font-sans text-sm font-medium text-ink-muted ml-1">/ mo</span>
                </div>
                <div className="text-xs -mt-1 h-4">
                  {isAnnual
                    ? <span className="text-emerald-400 font-semibold">billed ${plan.annual.yearly}/yr · 2 months free</span>
                    : <span className="text-ink-muted">{plan.videos}</span>}
                </div>
                <ul className="flex flex-col gap-2 text-xs text-ink-muted leading-relaxed flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <span className="text-gold mt-0.5 flex-shrink-0">✓</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => handleBuy(tier)}
                  disabled={isBusy || !!busy}
                  className={
                    "card-press h-11 px-4 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed " +
                    (plan.popular
                      ? "bg-gold text-paper hover:bg-gold-light"
                      : "bg-surface-raised text-ink border border-edge hover:border-gold")
                  }
                >
                  {isBusy ? "Opening Stripe…" : `Start ${plan.name}`}
                </button>
              </div>
            );
          })}
        </div>

        {/* One-off pay-as-you-go */}
        <div className="mx-6 sm:mx-8 mb-2 rounded-xl border border-edge bg-surface-input px-5 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="text-sm font-semibold text-ink">Just one listing?</div>
            <div className="text-xs text-ink-muted mt-0.5">Pay as you go — one cinematic video, no subscription.</div>
          </div>
          <button
            type="button"
            onClick={() => handleBuy("payg")}
            disabled={busy === "payg" || !!busy}
            className="card-press h-10 px-4 rounded-lg text-sm font-semibold bg-surface-raised text-ink border border-edge hover:border-gold transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
          >
            {busy === "payg" ? "Opening Stripe…" : "$39 / video →"}
          </button>
        </div>

        {error && (
          <div className="mx-6 sm:mx-8 mb-4 px-3 py-2.5 rounded-lg border border-red-500/30 bg-red-500/10 text-xs text-red-300">
            {error}
          </div>
        )}

        <div className="px-6 sm:px-8 pb-6 pt-2 flex items-center justify-between gap-4 flex-wrap">
          <span className="text-xs text-ink-muted">Cancel anytime. Your first video was on us.</span>
          <span className="text-[11px] text-ink-dim">Payments by Stripe. We never see your card.</span>
        </div>
      </div>
    </div>
  );
}
