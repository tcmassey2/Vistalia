import { useEffect, useRef, useState } from "react";
import {
  listMfaFactors,
  enrollTotpFactor,
  verifyTotpEnrollment,
  unenrollTotpFactor
} from "../lib/supabase";

/**
 * 2FA / TOTP enrollment widget for the Settings screen.
 *
 * States:
 *   - loading       — fetching current factors
 *   - off           — no verified factor; "Enable two-factor"
 *   - enrolling     — QR code shown, waiting for 6-digit verify
 *   - on            — factor verified; "Disable two-factor"
 *
 * This component handles enrollment + disable. Sign-in challenge for
 * already-enrolled users is in AuthScreen.
 */

interface FactorRow {
  id: string;
  status: string;
  friendly_name?: string;
}

interface EnrollData {
  id: string;
  totp: { qr_code: string; secret: string; uri: string };
}

export default function TwoFactorSection() {
  const [factors, setFactors] = useState<FactorRow[] | null>(null);
  const [enroll, setEnroll] = useState<EnrollData | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const codeInputRef = useRef<HTMLInputElement | null>(null);

  // Autofocus the 6-digit input as soon as enrollment kicks off.
  useEffect(() => {
    if (enroll) {
      const t = setTimeout(() => codeInputRef.current?.focus(), 80);
      return () => clearTimeout(t);
    }
  }, [enroll]);

  const refresh = async () => {
    setError("");
    try {
      const list = await listMfaFactors();
      setFactors(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read 2FA state.");
      setFactors([]);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const verified = factors?.find((f) => f.status === "verified") || null;
  const isLoading = factors === null;

  const handleEnroll = async () => {
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const data = await enrollTotpFactor();
      setEnroll(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start 2FA enrollment.");
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async () => {
    if (!enroll || code.length !== 6) return;
    setBusy(true);
    setError("");
    try {
      await verifyTotpEnrollment(enroll.id, code);
      setEnroll(null);
      setCode("");
      setInfo("Two-factor authentication is now on. We'll ask for a code on every sign-in.");
      await refresh();
    } catch (err) {
      setError(
        err instanceof Error
          ? `Code didn't match. ${err.message}`
          : "Code didn't match. Try the latest code from your authenticator app."
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    if (!verified) return;
    if (!window.confirm("Turn off two-factor authentication?")) return;
    setBusy(true);
    setError("");
    setInfo("");
    try {
      await unenrollTotpFactor(verified.id);
      setInfo("Two-factor authentication is off. We won't ask for a code on next sign-in.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't disable 2FA.");
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) {
    return (
      <div className="rounded-lg border border-edge-soft bg-surface-input p-4 animate-pulse">
        <div className="h-4 w-40 bg-edge rounded mb-2" />
        <div className="h-3 w-56 bg-edge rounded" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold tracking-tightish flex items-center gap-2">
            Two-factor authentication
            {verified ? (
              <span className="text-[10px] font-bold tracking-widest px-2 py-0.5 rounded bg-gold/15 text-gold border border-gold/40 uppercase">
                On
              </span>
            ) : (
              <span className="text-[10px] font-bold tracking-widest px-2 py-0.5 rounded bg-surface-input text-ink-muted border border-edge uppercase">
                Off
              </span>
            )}
          </div>
          <div className="text-xs text-ink-muted mt-0.5 max-w-md">
            Adds a one-time 6-digit code to sign-in. Pair with any authenticator app
            (1Password, Authy, Google Authenticator).
          </div>
        </div>
        {!verified && !enroll && (
          <button
            type="button"
            onClick={handleEnroll}
            disabled={busy}
            className="card-press h-9 px-4 rounded-lg text-xs font-semibold bg-surface-input border border-edge hover:border-gold text-ink hover:text-gold transition-colors disabled:opacity-50"
          >
            {busy ? "Generating…" : "Enable two-factor"}
          </button>
        )}
        {verified && (
          <button
            type="button"
            onClick={handleDisable}
            disabled={busy}
            className="card-press h-9 px-4 rounded-lg text-xs font-semibold bg-surface-input border border-edge hover:border-red-500/40 text-ink hover:text-red-300 transition-colors disabled:opacity-50"
          >
            Disable
          </button>
        )}
      </div>

      {/* Enrollment in progress: show the QR + verify field */}
      {enroll && (
        <div className="rounded-xl border border-gold/30 bg-gold/5 p-5 mt-2">
          <div className="text-xs uppercase tracking-widest text-gold mb-3 font-mono">Step 1 — Scan</div>
          <div className="flex flex-col sm:flex-row gap-5 items-start">
            <div
              className="bg-white rounded-lg p-3 flex-shrink-0"
              dangerouslySetInnerHTML={{ __html: enroll.totp.qr_code }}
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-ink-muted leading-relaxed">
                Open your authenticator app and scan this QR code. Or paste the secret manually:
              </p>
              <code className="block mt-2 px-3 py-2 bg-surface-input rounded-md text-xs text-gold font-mono break-all">
                {enroll.totp.secret}
              </code>
            </div>
          </div>

          <div className="text-xs uppercase tracking-widest text-gold mt-5 mb-3 font-mono">Step 2 — Verify</div>
          {/* Wrapped in a form so Enter from the input fires the verify
              button — much faster than reaching for the mouse. */}
          <form
            className="flex flex-wrap gap-3 items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.length === 6 && !busy) handleVerify();
            }}
          >
            <label className="flex flex-col gap-1.5 flex-1 min-w-[180px]">
              <span className="text-xs text-ink-soft">6-digit code</span>
              <input
                ref={codeInputRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123 456"
                className="h-11 px-3.5 bg-surface-input border border-edge rounded-lg text-ink text-lg font-mono tracking-widest focus:outline-none focus:border-gold focus:ring-2 focus:ring-gold/15 transition-colors"
              />
            </label>
            <button
              type="submit"
              disabled={busy || code.length !== 6}
              className="card-press h-11 px-5 rounded-lg text-sm font-semibold bg-gold text-paper hover:bg-gold-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? "Verifying…" : "Verify and enable"}
            </button>
            <button
              type="button"
              onClick={() => { setEnroll(null); setCode(""); setError(""); }}
              disabled={busy}
              className="card-press h-11 px-3 rounded-lg text-xs text-ink-muted hover:text-ink transition-colors"
            >
              Cancel
            </button>
          </form>
        </div>
      )}

      {error && (
        <div className="px-3 py-2.5 rounded-lg border border-red-500/30 bg-red-500/10 text-xs text-red-300">
          {error}
        </div>
      )}
      {info && (
        <div className="px-3 py-2.5 rounded-lg border border-gold/30 bg-gold/10 text-xs text-gold-light">
          {info}
        </div>
      )}
    </div>
  );
}
