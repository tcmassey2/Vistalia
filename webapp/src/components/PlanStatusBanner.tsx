import { useEffect, useState } from "react";
import { fetchUsage } from "../lib/api";
import { useStore } from "../lib/store";
import type { UserProfile } from "../lib/types";

/**
 * PlanStatusBanner — top-of-dashboard quota + trial visibility.
 *
 * Wires up the previously-dead /api/usage endpoint. Three primary states:
 *   - TRIAL (active): "X days · Y of 3 renders left in your free trial" + Upgrade CTA
 *   - TRIAL (expired): "Trial ended — pick a plan" + prominent Upgrade
 *   - PAID: "On Cinematic AI · 8 of 25 videos this cycle · resets in 12 days"
 *
 * Calls fetchUsage() on mount and on the `usageRefresh` counter from the
 * store (bumped after a successful render so the meter reflects new counts
 * without a hard refresh).
 */
export default function PlanStatusBanner({ onUpgrade }: { onUpgrade?: () => void }) {
  const session = useStore((s) => s.session);
  const usageRefresh = useStore((s) => s.usageRefresh);
  const [usage, setUsage] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!session?.user) {
      setUsage(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    fetchUsage()
      .then((u) => {
        if (!alive) return;
        setUsage(u);
        setError(u ? "" : "Couldn't load your plan status.");
      })
      .catch((err) => {
        if (!alive) return;
        const msg = err instanceof Error ? err.message : "Plan status fetch failed.";
        setError(msg);
        setUsage(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [session?.user?.id, usageRefresh]);

  if (!session?.user) return null;
  if (loading && !usage) return <Skeleton />;
  if (error && !usage) {
    return (
      <div className="rounded-xl border border-edge-soft bg-surface-input px-4 py-3 text-xs text-ink-muted mb-6">
        Couldn't load your plan status. {error}
      </div>
    );
  }
  if (!usage) return null;

  const isTrial = usage.tier === "trial";
  const credits = usage.render_credits ?? 0;
  const now = new Date();
  const trialEndsAt = usage.trial_ends_at ? new Date(usage.trial_ends_at) : null;
  const daysLeft = trialEndsAt
    ? Math.max(0, Math.ceil((trialEndsAt.getTime() - now.getTime()) / 86_400_000))
    : 0;
  const rendersLeft = Math.max(
    0,
    (usage.trial_render_cap ?? 1) - (usage.trial_renders_used ?? 0)
  );
  const tierLabel = TIER_LABELS[usage.tier] || usage.tier;

  // v26.6: pay-per-video. If the user holds purchased credits, that's the
  // truth regardless of trial state — show a credits banner, not "trial over."
  if (credits > 0) {
    return (
      <div className="rounded-xl border border-edge bg-surface p-4 sm:p-5 mb-6 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-mono uppercase tracking-widest text-gold mb-1.5">Video credits</div>
          <div className="text-base sm:text-lg font-semibold tracking-tightish">
            {credits} {credits === 1 ? "video credit" : "video credits"} ready
          </div>
          <div className="text-xs text-ink-muted mt-0.5">Credits never expire. A 60-second video uses 2.</div>
        </div>
        <UpgradeButton onUpgrade={onUpgrade} label="Buy more" primary={false} />
      </div>
    );
  }

  const trialExpired = isTrial && (!usage.can_render || daysLeft === 0 || rendersLeft === 0);

  if (isTrial && trialExpired) {
    return (
      <div className="rounded-xl border border-gold/40 bg-gradient-to-br from-gold/12 to-gold/4 p-4 sm:p-5 mb-6 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-mono uppercase tracking-widest text-gold mb-1.5">
            Trial complete
          </div>
          <div className="text-base sm:text-lg font-semibold tracking-tightish">
            You've used your free video — pick a plan to keep rendering.
          </div>
          <div className="text-xs text-ink-muted mt-0.5">
            {usage.reason || "Plans from $69/mo ($41/mo billed annually), or $39 per one-off video. Credits never expire."}
          </div>
        </div>
        <UpgradeButton onUpgrade={onUpgrade} label="See plans" primary />
      </div>
    );
  }

  if (isTrial) {
    const lowOnEither = daysLeft <= 2 || rendersLeft <= 1;
    return (
      <div
        className={
          "rounded-xl border p-4 sm:p-5 mb-6 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5 " +
          (lowOnEither
            ? "border-gold/40 bg-gold/8"
            : "border-edge bg-surface")
        }
      >
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-mono uppercase tracking-widest text-gold mb-1.5">
            Free trial
          </div>
          <div className="text-base sm:text-lg font-semibold tracking-tightish flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span>{daysLeft} {daysLeft === 1 ? "day" : "days"} left</span>
            <span className="text-ink-dim">·</span>
            <span>
              {rendersLeft} of {usage.trial_render_cap ?? 1} free {rendersLeft === 1 ? "video" : "videos"} left
            </span>
          </div>
          <div className="text-xs text-ink-muted mt-1">
            {lowOnEither
              ? "Add videos any time — $39 each, or subscribe from $69/mo ($41/mo annual)."
              : "Your first video's on us. After that, plans start at $69/mo ($41/mo annual) — or $39 per one-off video."}
          </div>
        </div>
        <UpgradeButton onUpgrade={onUpgrade} label="See plans" primary={lowOnEither} />
      </div>
    );
  }

  // Paid tier
  const usedThisCycle = usage.videos_used_this_month ?? 0;
  const quota = usage.monthly_video_quota ?? 0;
  const cycleEnd = usage.current_period_end ? new Date(usage.current_period_end) : null;
  const cycleDaysLeft = cycleEnd
    ? Math.max(0, Math.ceil((cycleEnd.getTime() - now.getTime()) / 86_400_000))
    : null;
  const pct = quota > 0 ? Math.min(100, Math.round((usedThisCycle / quota) * 100)) : 0;

  return (
    <div className="rounded-xl border border-edge bg-surface p-4 sm:p-5 mb-6 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5">
      <div className="flex-1 min-w-0">
        <div className="text-[10px] font-mono uppercase tracking-widest text-gold mb-1.5">
          {tierLabel}
        </div>
        <div className="text-base sm:text-lg font-semibold tracking-tightish flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span>{usedThisCycle} of {quota} this cycle</span>
          {cycleDaysLeft !== null && cycleDaysLeft <= 366 && (
            <>
              <span className="text-ink-dim">·</span>
              <span className="text-ink-muted text-sm font-normal">
                resets in {cycleDaysLeft} {cycleDaysLeft === 1 ? "day" : "days"}
              </span>
            </>
          )}
        </div>
        <div className="mt-2 h-1.5 bg-edge rounded-full overflow-hidden max-w-md">
          <div
            className={
              "h-full rounded-full transition-all duration-300 " +
              (pct >= 90 ? "bg-gold" : "bg-gold/60")
            }
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <UpgradeButton onUpgrade={onUpgrade} label="Manage plan" primary={false} />
    </div>
  );
}

function UpgradeButton({
  onUpgrade,
  primary = true,
  label
}: {
  onUpgrade?: () => void;
  primary?: boolean;
  label?: string;
}) {
  const goToScreen = useStore((s) => s.goToScreen);
  const handleClick = () => {
    if (onUpgrade) onUpgrade();
    else goToScreen("settings");
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      className={
        "card-press h-10 px-4 rounded-lg text-sm font-semibold tracking-tightish transition-colors flex-shrink-0 " +
        (primary
          ? "bg-gold text-paper hover:bg-gold-light"
          : "bg-surface-input border border-edge hover:border-gold text-ink hover:text-gold")
      }
    >
      {label || "Buy videos"}
    </button>
  );
}

function Skeleton() {
  return (
    <div className="rounded-xl border border-edge-soft bg-surface-input p-4 sm:p-5 mb-6 animate-pulse">
      <div className="h-3 w-20 bg-edge rounded mb-3" />
      <div className="h-5 w-64 bg-edge rounded" />
    </div>
  );
}

const TIER_LABELS: Record<string, string> = {
  trial: "Free Trial",
  quick_reel: "Photo Motion", // legacy tier key — customer-facing name updated v34.4
  cinematic_ai: "Cinematic AI",
  cinematic_4k: "Cinematic AI 4K",
  // q6 subscription tiers — without these, paid users render a raw lowercase
  // "pro"/"studio" instead of a proper label.
  pro: "Pro",
  studio: "Studio"
};
