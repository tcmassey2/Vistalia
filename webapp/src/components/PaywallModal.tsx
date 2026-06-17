import { useEffect, useState } from "react";
import { startCheckout, type CheckoutTier } from "../lib/api";
import { useStore } from "../lib/store";

/**
 * PaywallModal — the free-video → paid moment.
 *
 * Shown when a user is out of render credits / past their free trial video
 * and tries to render. v26.8 pay-per-video model (no subscriptions): the
 * three credit packs — $100 single, $375 5-pack (featured), $650 10-pack.
 * All collected cash, which funds the ad flywheel.
 */

interface PaywallModalProps {
  open: boolean;
  onClose: () => void;
  /** Optional context line, e.g. the gate reason from /api/usage. */
  reason?: string;
}

interface PackCard {
  slug: CheckoutTier;
  name: string;
  price: string;
  unit: string;
  save?: string;
  features: string[];
  featured?: boolean;
}

const PACKS: PackCard[] = [
  {
    slug: "single",
    name: "Single video",
    price: "$100",
    unit: "1 video",
    features: [
      "One cinematic listing video",
      "All social formats (9:16, 1:1, 16:9)",
      "Free scene regeneration",
      "Your branding on the outro"
    ]
  },
  {
    slug: "pack5",
    name: "5-video pack",
    price: "$375",
    unit: "5 videos",
    save: "Save 25% — $75 / video",
    featured: true,
    features: [
      "Five cinematic listing videos",
      "Credits never expire",
      "Everything in single, plus",
      "Priority rendering queue"
    ]
  },
  {
    slug: "pack10",
    name: "10-video pack",
    price: "$650",
    unit: "10 videos",
    save: "Save 35% — $65 / video",
    features: [
      "Ten cinematic listing videos",
      "Credits never expire",
      "Best per-video price",
      "Priority rendering queue"
    ]
  }
];

export default function PaywallModal({ open, onClose, reason }: PaywallModalProps) {
  const session = useStore((s) => s.session);
  const [busy, setBusy] = useState<CheckoutTier | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleBuy = async (slug: CheckoutTier) => {
    setBusy(slug);
    setError("");
    try {
      const result = await startCheckout({
        tier: slug,
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
        aria-label="Buy a video"
        className="relative w-full max-w-3xl bg-surface rounded-2xl border border-edge shadow-2xl my-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-6 sm:px-8 py-5 border-b border-edge-soft">
          <div>
            <h2 className="text-lg font-semibold tracking-tightish">Get your next video</h2>
            <p className="text-xs text-ink-muted mt-1">
              {reason || "You've used your free video. Buy credits to keep rendering — they never expire."}
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

        <div className="px-6 sm:px-8 py-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
          {PACKS.map((pack) => {
            const isBusy = busy === pack.slug;
            return (
              <div
                key={pack.slug}
                className={
                  "relative rounded-xl border p-5 flex flex-col gap-3 transition-colors " +
                  (pack.featured ? "border-gold bg-gold/5" : "border-edge bg-surface-input")
                }
              >
                {pack.featured && (
                  <span className="absolute -top-3 left-5 text-[9px] font-bold tracking-widest px-2 py-1 rounded-full bg-gold text-paper uppercase">
                    Best value
                  </span>
                )}
                <div className="text-sm font-semibold tracking-tightish text-ink">{pack.name}</div>
                <div className="text-3xl font-bold tracking-tight text-ink">
                  {pack.price}
                  <span className="text-sm font-medium text-ink-muted ml-1">/ {pack.unit}</span>
                </div>
                {pack.save
                  ? <div className="text-xs font-semibold text-emerald-400 -mt-1">{pack.save}</div>
                  : <div className="text-xs -mt-1 invisible">placeholder</div>}
                <ul className="flex flex-col gap-2 text-xs text-ink-muted leading-relaxed flex-1">
                  {pack.features.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <span className="text-gold mt-0.5 flex-shrink-0">✓</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => handleBuy(pack.slug)}
                  disabled={isBusy || !!busy}
                  className={
                    "card-press h-11 px-4 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed " +
                    (pack.featured
                      ? "bg-gold text-paper hover:bg-gold-light"
                      : "bg-surface-raised text-ink border border-edge hover:border-gold")
                  }
                >
                  {isBusy ? "Opening Stripe…" : pack.featured ? "Get the 5-pack →" : "Buy one video"}
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

        <div className="px-6 sm:px-8 pb-6 flex items-center justify-between gap-4 flex-wrap">
          <span className="text-xs text-ink-muted">Credits never expire. Use them whenever you list.</span>
          <span className="text-[11px] text-ink-dim">Payments by Stripe. We never see your card.</span>
        </div>
      </div>
    </div>
  );
}
