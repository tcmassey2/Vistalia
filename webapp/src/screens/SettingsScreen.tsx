import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import { fetchUsage, openBillingPortal, deleteAccount } from "../lib/api";
import { signOut, requestPasswordReset } from "../lib/supabase";
import type { UserProfile } from "../lib/types";
import TwoFactorSection from "../components/TwoFactorSection";

/**
 * SettingsScreen — account + subscription management.
 *
 * Sections:
 *   1. Account     — email, change password (sends reset link)
 *   2. Subscription — current tier, quota usage, "Manage subscription"
 *                     button that opens Stripe Customer Portal in a new tab.
 *                     Shows "Pick a plan" CTAs for free-trial users who don't
 *                     have a Stripe customer record yet.
 *   3. Sign out
 */
export default function SettingsScreen() {
  const session = useStore((s) => s.session);
  const goToScreen = useStore((s) => s.goToScreen);
  const setToast = useStore((s) => s.setToast);
  const setError = useStore((s) => s.setError);

  const [usage, setUsage] = useState<UserProfile | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [portalLoading, setPortalLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);

  const email = session?.user?.email || "";

  useEffect(() => {
    let alive = true;
    fetchUsage()
      .then((u) => { if (alive) setUsage(u); })
      .catch(() => { if (alive) setUsage(null); })
      .finally(() => { if (alive) setUsageLoading(false); });
    return () => { alive = false; };
  }, []);

  const handleManageBilling = async () => {
    setPortalLoading(true);
    setError("");
    try {
      const { url, error, needsCheckout } = await openBillingPortal();
      if (url) {
        // Open in new tab so the user keeps EstateMotion open behind it.
        window.open(url, "_blank", "noopener");
        return;
      }
      if (needsCheckout) {
        setToast("You don't have a paid plan yet — pick one below to set up billing.");
        return;
      }
      setError(error || "Couldn't open the billing portal.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open the billing portal.");
    } finally {
      setPortalLoading(false);
    }
  };

  const handlePasswordReset = async () => {
    if (!email) return;
    setResetLoading(true);
    setError("");
    try {
      await requestPasswordReset(email);
      setToast(`Password reset email sent to ${email}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send reset email.");
    } finally {
      setResetLoading(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    // store.init's onAuthChange will route us back to /auth.
  };

  // Data export download. We can't use a plain <a download> because the
  // /api/export-account endpoint requires the Supabase JWT in an
  // Authorization header. Fetch with auth, turn the response body into a
  // blob, then trigger a download via a temporary object URL.
  const [exporting, setExporting] = useState(false);
  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    setError("");
    try {
      const sessionRes = await import("../lib/supabase").then((m) => m.getSession());
      const token = sessionRes?.access_token;
      if (!token) {
        setError("Sign in expired. Refresh the page.");
        return;
      }
      const res = await fetch("/api/export-account", {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        setError(payload.error || `Export failed (${res.status}).`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const today = new Date().toISOString().split("T")[0];
      a.download = `estatemotion-export-${today}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setToast("Your data was downloaded.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  };

  const tier = usage?.tier || "trial";
  const tierLabel = TIER_LABELS[tier] || tier;
  const isPaidTier = tier !== "trial";
  const isEmailConfirmed = Boolean(session?.user?.email_confirmed_at);

  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between mb-10">
        <div>
          <p className="text-xs uppercase tracking-wider text-gold mb-2 font-mono">Settings</p>
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tighter2">Account &amp; billing</h1>
        </div>
        <button
          onClick={() => goToScreen("dashboard")}
          className="text-sm text-ink-muted hover:text-ink transition-colors"
        >
          ← Back to dashboard
        </button>
      </div>

      {/* ============================================================
          Account section
          ============================================================ */}
      <Section title="Account" subtitle="The email you use to sign in.">
        <div className="flex flex-col gap-4">
          <Field label="Email">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium truncate">{email}</span>
              {isEmailConfirmed ? (
                <span className="text-[10px] font-bold tracking-widest px-2 py-0.5 rounded bg-gold/15 text-gold border border-gold/40 uppercase">
                  Confirmed
                </span>
              ) : (
                <span className="text-[10px] font-bold tracking-widest px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/40 uppercase">
                  Unconfirmed
                </span>
              )}
            </div>
          </Field>

          <Field label="Password">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-ink-muted">
                We'll send a reset link to your email.
              </span>
              <button
                type="button"
                onClick={handlePasswordReset}
                disabled={resetLoading || !email}
                className="card-press h-8 px-3 rounded-md text-xs font-semibold bg-surface-input border border-edge hover:border-gold text-ink hover:text-gold transition-colors disabled:opacity-50"
              >
                {resetLoading ? "Sending…" : "Send reset link"}
              </button>
            </div>
          </Field>
        </div>
      </Section>

      {/* ============================================================
          Two-factor authentication
          ============================================================ */}
      <Section title="Security" subtitle="Stronger account protection.">
        <TwoFactorSection />
      </Section>

      {/* ============================================================
          Subscription section
          ============================================================ */}
      <Section title="Subscription" subtitle="Plan, billing, and invoices.">
        {usageLoading ? (
          <div className="rounded-lg border border-edge-soft bg-surface-input p-4 animate-pulse">
            <div className="h-4 w-32 bg-edge rounded mb-2" />
            <div className="h-3 w-48 bg-edge rounded" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <Field label="Current plan">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-base font-semibold tracking-tightish">{tierLabel}</div>
                  {usage && (
                    <div className="text-xs text-ink-muted mt-0.5">
                      {tier === "trial"
                        ? `${usage.trial_renders_used ?? 0} of ${usage.trial_render_cap ?? 3} trial videos used`
                        : `${usage.videos_used_this_month} of ${usage.monthly_video_quota} videos this cycle`}
                    </div>
                  )}
                </div>
                {isPaidTier ? (
                  <button
                    type="button"
                    onClick={handleManageBilling}
                    disabled={portalLoading}
                    className="card-press h-9 px-4 rounded-lg text-xs font-semibold bg-gold text-paper hover:bg-gold-light transition-colors disabled:opacity-50"
                  >
                    {portalLoading ? "Opening…" : "Manage subscription ↗"}
                  </button>
                ) : (
                  <a
                    href="/#pricing"
                    className="card-press h-9 px-4 rounded-lg text-xs font-semibold bg-gold text-paper hover:bg-gold-light transition-colors inline-flex items-center"
                  >
                    Pick a plan
                  </a>
                )}
              </div>
            </Field>
            {isPaidTier && (
              <p className="text-[11px] text-ink-dim leading-relaxed">
                The Stripe portal opens in a new tab. From there you can update your payment method,
                view invoices, switch plans, or cancel.
              </p>
            )}
          </div>
        )}
      </Section>

      {/* ============================================================
          Data export — portable JSON snapshot, free for any user.
          Encouraged before account deletion but not gated on it.
          ============================================================ */}
      <div className="mt-10 pt-8 border-t border-edge-soft flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold tracking-tightish">Download my data</div>
          <div className="text-xs text-ink-muted mt-0.5 max-w-md">
            JSON snapshot of your account, brand kit, and library — including
            URLs to every rendered file. Useful before deleting your account.
          </div>
        </div>
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          className="card-press h-10 px-4 rounded-lg text-sm font-semibold bg-surface-input border border-edge hover:border-gold text-ink hover:text-gold transition-colors disabled:opacity-50"
        >
          {exporting ? "Preparing…" : "Download JSON"}
        </button>
      </div>

      {/* ============================================================
          Sign out — recoverable, separated from destructive zone below
          ============================================================ */}
      <div className="mt-6 pt-6 border-t border-edge-soft flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold tracking-tightish">Sign out</div>
          <div className="text-xs text-ink-muted mt-0.5">
            You can sign back in any time with your email and password.
          </div>
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          className="card-press h-10 px-4 rounded-lg text-sm font-semibold bg-surface-input border border-edge hover:border-edge-strong text-ink transition-colors"
        >
          Sign out
        </button>
      </div>

      {/* ============================================================
          Delete account — fully destructive, type-to-confirm guard
          ============================================================ */}
      <DangerZone email={email} />
    </div>
  );
}

function DangerZone({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const setToast = useStore((s) => s.setToast);

  const ready = typed.trim().toLowerCase() === email.toLowerCase() && email.length > 0;

  const handleDelete = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await deleteAccount(email);
      if (result.error) {
        setError(result.error + (result.detail ? ` — ${result.detail}` : ""));
        return;
      }
      setToast("Your account has been deleted. Goodbye.");
      // Sign out triggers store to route back to /auth.
      await signOut();
      // As a belt-and-suspenders, redirect to home in case the auth state
      // change doesn't propagate (e.g., session was already invalid).
      setTimeout(() => { window.location.href = "/"; }, 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Account deletion failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-12 pt-8 border-t border-red-500/15">
      <div className="rounded-2xl border border-red-500/25 bg-red-500/[0.04] p-6 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-sm font-semibold tracking-tightish text-red-300">
              Delete account
            </div>
            <div className="text-xs text-ink-muted mt-1 max-w-md leading-relaxed">
              Permanently removes your profile, brand kit, library, render audit log,
              and all uploaded photos from EstateMotion. Stripe billing records are
              retained as required by tax law. This cannot be undone.
            </div>
          </div>
          {!open && (
            <button
              type="button"
              onClick={() => { setOpen(true); setError(""); setTyped(""); }}
              className="card-press h-10 px-4 rounded-lg text-sm font-semibold bg-surface-input border border-red-500/30 hover:border-red-500/60 text-red-300 transition-colors"
            >
              Delete my account
            </button>
          )}
        </div>

        {open && (
          <div className="mt-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-muted">
                Type <strong className="text-ink">{email}</strong> to confirm deletion
              </span>
              <input
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={email}
                autoComplete="off"
                spellCheck={false}
                className="h-11 px-3.5 bg-surface-input border border-edge rounded-lg text-ink placeholder:text-ink-dim focus:outline-none focus:border-red-500/60 focus:ring-2 focus:ring-red-500/20 transition-colors font-mono text-sm"
              />
            </label>

            {error && (
              <div className="px-3 py-2.5 rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-300">
                {error}
              </div>
            )}

            <div className="flex gap-2 mt-1">
              <button
                type="button"
                onClick={() => { setOpen(false); setTyped(""); setError(""); }}
                disabled={busy}
                className="card-press h-10 px-4 rounded-lg text-sm font-semibold bg-surface-input border border-edge hover:border-edge-strong text-ink transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={!ready || busy}
                className={
                  "card-press h-10 px-4 rounded-lg text-sm font-semibold transition-colors " +
                  (ready
                    ? "bg-red-500/90 hover:bg-red-500 text-paper"
                    : "bg-surface-input border border-edge text-ink-dim cursor-not-allowed")
                }
              >
                {busy ? "Deleting…" : "Delete forever"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-surface border border-edge rounded-2xl p-6 sm:p-8 mb-6">
      <header className="mb-5">
        <h2 className="text-lg font-semibold tracking-tightish">{title}</h2>
        {subtitle && <p className="text-sm text-ink-muted mt-0.5">{subtitle}</p>}
      </header>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-ink-soft">{label}</span>
      <div className="rounded-lg bg-surface-input border border-edge px-4 py-3">
        {children}
      </div>
    </div>
  );
}

const TIER_LABELS: Record<string, string> = {
  trial: "Free Trial",
  quick_reel: "Quick Reel",
  cinematic_ai: "Cinematic AI",
  cinematic_4k: "Cinematic AI 4K"
};
