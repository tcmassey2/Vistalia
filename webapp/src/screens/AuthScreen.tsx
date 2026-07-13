import { useEffect, useRef, useState, type FormEvent } from "react";
import { useStore } from "../lib/store";
import {
  signIn,
  signUp,
  requestPasswordReset,
  updatePassword,
  resendConfirmationEmail,
  needsTotpChallenge,
  challengeAndVerifyTotp,
  signOut
} from "../lib/supabase";
import { events, track } from "../lib/analytics";
import { trackLead } from "../lib/pixel";
import Turnstile from "../components/Turnstile";
import { env } from "../lib/env";

type Mode = "signin" | "signup" | "forgot" | "reset" | "totp";

export default function AuthScreen() {
  const [mode, setMode] = useState<Mode>("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  // Track the email of the just-finished signup so the "Resend confirmation"
  // button knows which address to retarget when the original mail vanishes.
  const [pendingConfirmEmail, setPendingConfirmEmail] = useState("");
  // Turnstile token from the widget. Required by Supabase Auth when CAPTCHA
  // is enabled in the project settings AND TURNSTILE_SITE_KEY is configured.
  // When the site key is empty, the widget renders nothing and this stays
  // empty — Supabase accepts the request without it.
  const [captchaToken, setCaptchaToken] = useState("");
  // Bumped after every failed submit so the Turnstile widget gets
  // remounted with a fresh iframe — otherwise the widget returns the
  // SAME token from its internal cache and Supabase 422s with
  // 'captcha protection: request disallowed (already-seen-response)'.
  const [captchaResetKey, setCaptchaResetKey] = useState(0);
  const captchaRequired = Boolean(env().TURNSTILE_SITE_KEY);
  // Turnstile tokens are only valid for 300s after the widget solves — but
  // the widget solves ON MOUNT and then displays "Success!" forever. A user
  // who loads the page, types slowly (or tabs away), and submits minutes
  // later sends a dead token and Supabase rejects with the cryptic
  // 'captcha protection: request disallowed (timeout-or-duplicate)'.
  // So we stamp each token's birth time and, at submit, refresh any token
  // older than CAPTCHA_MAX_AGE_MS before calling auth.
  const CAPTCHA_MAX_AGE_MS = 120_000;
  const captchaTokenAtRef = useRef(0);
  const captchaWaiterRef = useRef<{ resolve: (token: string) => void } | null>(null);

  // Reset both the local token AND force the widget to re-render.
  // Call after any failed submit OR after a successful submit that
  // doesn't navigate away (so the next captcha-required action gets
  // a fresh challenge).
  const resetCaptcha = () => {
    setCaptchaToken("");
    captchaTokenAtRef.current = 0;
    setCaptchaResetKey((k) => k + 1);
  };

  // Return a token guaranteed to be fresh enough for Supabase's siteverify
  // call. If the current one is young, use it; otherwise remount the widget
  // (which auto-solves) and await the new token from onVerify. Rejects after
  // 30s so a broken/blocked widget surfaces a readable error instead of
  // hanging the submit button.
  const ensureFreshCaptcha = (): Promise<string> => {
    const age = Date.now() - captchaTokenAtRef.current;
    if (captchaToken && age < CAPTCHA_MAX_AGE_MS) return Promise.resolve(captchaToken);
    const fresh = new Promise<string>((resolve, reject) => {
      captchaWaiterRef.current = { resolve };
      window.setTimeout(() => {
        if (captchaWaiterRef.current) {
          captchaWaiterRef.current = null;
          reject(new Error("The security check didn't respond. Complete the CAPTCHA below, then try again."));
        }
      }, 30_000);
    });
    resetCaptcha(); // burn the stale token; the remounted widget solves and resolves the promise
    return fresh;
  };
  // 2FA challenge state. When sign-in returns with the user enrolled in
  // TOTP, we flip to mode='totp' and stash the factorId here for the
  // verify call.
  const [totpCode, setTotpCode] = useState("");
  const [totpFactorId, setTotpFactorId] = useState("");
  const setToast = useStore((s) => s.setToast);

  // Detect Supabase recovery tokens in the URL hash. When the user clicks the
  // password-reset email link, Supabase redirects them back here with a
  // #access_token=… that auto-establishes a session — we then flip to "reset"
  // mode to let them type a new password.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash || "";
    if (hash.includes("type=recovery")) {
      setMode("reset");
      // Clean the hash so a future page reload doesn't re-trigger reset mode.
      try {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      } catch {
        /* noop */
      }
    }
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // Guard against double-submit: setBusy is async, so two clicks in the
    // same frame would both pass a disabled-button check and fire two auth
    // calls with the SAME single-use token — the second one dies with
    // 'timeout-or-duplicate'.
    if (busy) return;
    setError("");
    setInfo("");
    setBusy(true);
    try {
      if (mode === "signup") {
        const token = captchaRequired ? await ensureFreshCaptcha() : undefined;
        track(events.signupStarted);
        await signUp(email, password, token);
        track(events.signupCompleted);
        trackLead(); // Meta pixel Lead — the ad account optimizes on this
        resetCaptcha(); // single-use token; force re-challenge on retry
        setPendingConfirmEmail(email);
        setInfo("Check your email to confirm. We've sent the link to " + email + ".");
        setMode("signin");
      } else if (mode === "signin") {
        // Captcha is required on sign-in too when Supabase has bot protection
        // enabled (which we do, project-wide). Without a token Supabase
        // rejects with "captcha protection: request disallowed".
        const token = captchaRequired ? await ensureFreshCaptcha() : undefined;
        await signIn(email, password, token);
        resetCaptcha();
        // Check whether this account has 2FA enrolled. If so, the session
        // is at aal1 — we need a TOTP challenge to upgrade to aal2 before
        // the dashboard route is allowed. signOut() if the challenge is
        // canceled, so we don't leave a half-authed session lying around.
        const totp = await needsTotpChallenge();
        if (totp.needed && totp.factorId) {
          setTotpFactorId(totp.factorId);
          setMode("totp");
          setInfo("Enter the 6-digit code from your authenticator app.");
          return;
        }
        track(events.signinCompleted);
        setToast("Signed in");
        // store.init's onAuthChange handler will move us to dashboard
      } else if (mode === "totp") {
        await challengeAndVerifyTotp(totpFactorId, totpCode);
        track(events.signinCompleted);
        setToast("Signed in");
        setTotpCode("");
        setTotpFactorId("");
        // store.init's onAuthChange will route to dashboard now that
        // the session is at aal2.
      } else if (mode === "forgot") {
        const token = captchaRequired ? await ensureFreshCaptcha() : undefined;
        await requestPasswordReset(email, token);
        resetCaptcha();
        setInfo(
          "If an account exists for " + email + ", a password-reset link is on its way. Check your inbox."
        );
        // Stay on this view so the user can re-request without retyping.
      } else if (mode === "reset") {
        await updatePassword(password);
        setToast("Password updated");
        setInfo("Password updated. You're signed in.");
        // store.init's onAuthChange will route to dashboard once the session
        // (already active from the recovery link) propagates.
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Authentication failed.";
      setError(humanizeAuthError(message));
      // CRITICAL: reset captcha on failure too. Supabase consumed the
      // token whether or not auth succeeded — keeping it in state means
      // the next attempt sends the burned token and gets the misleading
      // 'already-seen-response' error instead of the real password-wrong
      // message.
      if (captchaRequired) resetCaptcha();
    } finally {
      setBusy(false);
    }
  };

  const handleResendConfirmation = async () => {
    if (!pendingConfirmEmail || busy) return;
    setError("");
    setInfo("");
    setBusy(true);
    try {
      const token = captchaRequired ? await ensureFreshCaptcha() : undefined;
      await resendConfirmationEmail(pendingConfirmEmail, token);
      resetCaptcha();
      setInfo("Confirmation email re-sent to " + pendingConfirmEmail + ".");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Resend failed.";
      setError(humanizeAuthError(message));
      if (captchaRequired) resetCaptcha();
    } finally {
      setBusy(false);
    }
  };

  // Mode-specific copy, kept in one place so the JSX stays readable.
  const heading =
    mode === "signup" ? "Make your first listing video."
    : mode === "signin" ? "Welcome back."
    : mode === "forgot" ? "Reset your password."
    : mode === "totp"   ? "Two-factor required."
    : "Set a new password.";
  const subhead =
    mode === "signup" ? "Your first video is free. No credit card."
    : mode === "signin" ? "Pick up where you left off."
    : mode === "forgot" ? "We'll email you a secure link to set a new one."
    : mode === "totp"   ? "Enter the 6-digit code from your authenticator app."
    : "Choose a strong password to finish resetting.";
  const submitLabel =
    mode === "signup" ? "Create account"
    : mode === "signin" ? "Sign in"
    : mode === "forgot" ? "Send reset link"
    : mode === "totp"   ? "Verify code"
    : "Set new password";
  const showEmail = mode !== "reset" && mode !== "totp";
  const showPassword = mode !== "forgot" && mode !== "totp";

  // v2.1 dynamic input feedback: green glow when a field is validly filled.
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const passwordValid = password.length >= 8;

  return (
    <div className="min-h-screen flex flex-col relative">
      {/* v2 revamp: ambient filmic glow so auth feels like entering a studio,
          not a plain form. Matches the marketing landing's backdrop. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0"
        style={{
          background:
            "radial-gradient(900px 480px at 70% -8%, rgba(199,167,108,0.10), transparent 60%), radial-gradient(700px 400px at 0% 105%, rgba(199,167,108,0.05), transparent 55%)"
        }}
      />
      <header className="px-6 py-5 relative">
        <a href="/" className="inline-flex items-center gap-2.5 text-ink hover:text-gold-light transition-colors">
          <span className="grid place-items-center w-8 h-8 rounded-lg bg-[#0B0B0D] border border-[#C7A76C] text-[#E6CE8E] font-display font-semibold text-lg leading-none">
            V
          </span>
          <span className="font-display text-lg font-semibold tracking-tightish">Vistalia</span>
        </a>
      </header>

      <div className="flex-1 grid place-items-center px-6 pb-16 relative">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-gold mb-3">Vistalia</div>
            <h1 className="font-display text-4xl sm:text-[2.75rem] leading-[1.05] font-semibold tracking-tighter2">{heading}</h1>
            <p className="text-ink-soft text-[15px] mt-3">{subhead}</p>
          </div>

          <div className="bg-surface border border-edge rounded-2xl p-6 sm:p-8">
            {(mode === "signin" || mode === "signup") && (
              <div className="inline-flex p-1 bg-surface-input rounded-full border border-edge mb-6">
                <button
                  type="button"
                  onClick={() => { setMode("signin"); setError(""); setInfo(""); }}
                  className={`h-8 px-4 rounded-full text-sm font-medium transition-colors ${
                    mode === "signin" ? "bg-gold text-paper" : "text-ink-muted hover:text-ink"
                  }`}
                >
                  Sign in
                </button>
                <button
                  type="button"
                  onClick={() => { setMode("signup"); setError(""); setInfo(""); }}
                  className={`h-8 px-4 rounded-full text-sm font-medium transition-colors ${
                    mode === "signup" ? "bg-gold text-paper" : "text-ink-muted hover:text-ink"
                  }`}
                >
                  Create account
                </button>
              </div>
            )}

            <form onSubmit={submit} className="flex flex-col gap-4">
              {showEmail && (
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-ink-soft">Email</span>
                  <input
                    type="email"
                    name="email"
                    id="auth-email"
                    required
                    autoComplete="email"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={`h-11 px-3.5 bg-surface-input border border-edge rounded-lg text-ink placeholder:text-ink-dim focus:outline-none focus:border-gold focus:ring-2 focus:ring-gold/15 transition-all ${emailValid ? "input-valid" : ""}`}
                    placeholder="agent@example.com"
                  />
                </label>
              )}

              {showPassword && (
                <label className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs text-ink-soft">
                      {mode === "reset" ? "New password" : "Password"}
                    </span>
                    {mode === "signin" && (
                      <button
                        type="button"
                        onClick={() => { setMode("forgot"); setError(""); setInfo(""); setPassword(""); }}
                        className="text-xs text-ink-muted hover:text-gold transition-colors"
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>
                  <input
                    type="password"
                    name="password"
                    id="auth-password"
                    required
                    minLength={8}
                    autoComplete={mode === "signup" || mode === "reset" ? "new-password" : "current-password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={`h-11 px-3.5 bg-surface-input border border-edge rounded-lg text-ink placeholder:text-ink-dim focus:outline-none focus:border-gold focus:ring-2 focus:ring-gold/15 transition-all ${passwordValid && (mode === "signup" || mode === "reset") ? "input-valid" : ""}`}
                    placeholder={mode === "signup" || mode === "reset" ? "At least 8 characters" : "Your password"}
                  />
                </label>
              )}

              {/* TOTP code input — appears in 'totp' mode only. We treat it
                  as the sole input on this view; the email/password fields
                  are hidden because the user already authenticated to aal1. */}
              {mode === "totp" && (
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-ink-soft">6-digit code</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="one-time-code"
                    maxLength={6}
                    required
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="123 456"
                    className="h-12 px-3.5 bg-surface-input border border-edge rounded-lg text-ink text-2xl font-mono tracking-widest text-center focus:outline-none focus:border-gold focus:ring-2 focus:ring-gold/15 transition-colors"
                  />
                </label>
              )}

              {/* hCaptcha — required for every Supabase auth flow when
                  bot protection is enabled (signup, signin, password reset,
                  email-confirm resend). The widget remounts when mode changes,
                  which forces a fresh challenge each time. */}
              {captchaRequired && (mode === "signup" || mode === "signin" || mode === "forgot") && (
                <Turnstile
                  // Remount on mode switch OR after any failed/successful
                  // submit (captchaResetKey bumps). Forces a fresh iframe
                  // so hCaptcha can't cache and replay the burned token —
                  // root cause of 'already-seen-response' on retry.
                  key={`${mode}-${captchaResetKey}`}
                  onVerify={(token) => {
                    setCaptchaToken(token);
                    captchaTokenAtRef.current = Date.now();
                    // A submit may be awaiting this fresh token (ensureFreshCaptcha).
                    captchaWaiterRef.current?.resolve(token);
                    captchaWaiterRef.current = null;
                  }}
                  onExpire={() => {
                    setCaptchaToken("");
                    captchaTokenAtRef.current = 0;
                  }}
                />
              )}

              {error && (
                <div key={error} className="shake px-3 py-2.5 rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-300">
                  {error}
                </div>
              )}
              {info && (
                <div className="px-3 py-2.5 rounded-lg border border-gold/30 bg-gold/10 text-sm text-gold-light">
                  {info}
                </div>
              )}

              <button
                type="submit"
                // Don't gate the button on captchaToken: tokens expire and get
                // cleared (onExpire), which used to brick the button silently.
                // submit() now acquires a fresh token itself via
                // ensureFreshCaptcha(), so a click always works or errors loudly.
                disabled={busy}
                className="btn-primary-em h-11 mt-2 rounded-lg disabled:opacity-50"
              >
                {busy ? (
                  <span className="inline-flex items-center gap-2 justify-center">
                    <span className="spinner" /> Working…
                  </span>
                ) : submitLabel}
              </button>
            </form>

            {/* Resend confirmation — appears on the signin tab right after a
                fresh signup, when the user might still be staring at the
                "check your inbox" message and not seeing the email arrive. */}
            {mode === "signin" && pendingConfirmEmail && (
              <div className="mt-5 pt-5 border-t border-edge-soft text-center">
                <p className="text-xs text-ink-muted mb-2">
                  Didn't get the confirmation email?
                </p>
                <button
                  type="button"
                  onClick={handleResendConfirmation}
                  disabled={busy}
                  className="text-xs text-gold hover:text-gold-light transition-colors disabled:opacity-50"
                >
                  Resend to {pendingConfirmEmail}
                </button>
              </div>
            )}

            {mode === "forgot" && (
              <div className="mt-5 pt-5 border-t border-edge-soft text-center">
                <button
                  type="button"
                  onClick={() => { setMode("signin"); setError(""); setInfo(""); }}
                  className="text-xs text-ink-muted hover:text-ink transition-colors"
                >
                  ← Back to sign in
                </button>
              </div>
            )}

            {mode === "totp" && (
              <div className="mt-5 pt-5 border-t border-edge-soft text-center">
                <button
                  type="button"
                  onClick={async () => {
                    // Bail out of the half-authed (aal1) session so we
                    // don't leave a stale token around.
                    try { await signOut(); } catch { /* noop */ }
                    setMode("signin");
                    setTotpCode("");
                    setTotpFactorId("");
                    setError("");
                    setInfo("");
                  }}
                  className="text-xs text-ink-muted hover:text-ink transition-colors"
                >
                  ← Cancel sign in
                </button>
              </div>
            )}

            {mode === "signup" && (
              <p className="text-xs text-ink-dim text-center mt-5 leading-relaxed">
                By creating an account you agree to our{" "}
                <a href="/legal/terms.html" target="_blank" rel="noopener" className="text-gold-light hover:underline">Terms of Service</a>{" "}
                and{" "}
                <a href="/legal/privacy.html" target="_blank" rel="noopener" className="text-gold-light hover:underline">Privacy Policy</a>.
              </p>
            )}
          </div>

          <div className="text-center mt-6">
            <a href="/" className="text-sm text-ink-muted hover:text-ink transition-colors">
              ← Back to homepage
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function humanizeAuthError(msg: string): string {
  if (/invalid login/i.test(msg)) return "Invalid email or password.";
  if (/email not confirmed/i.test(msg)) return "Confirm your email first — check your inbox.";
  if (/already registered|already exists/i.test(msg)) return "That email is already registered. Try signing in.";
  if (/password.{0,30}(short|weak|6 character)/i.test(msg)) return "Password must be at least 8 characters.";
  if (/Supabase isn't configured/i.test(msg)) return "Auth isn't configured yet. Contact support.";
  if (/rate.?limit|too many requests/i.test(msg)) return "Too many attempts — wait a minute and try again.";
  // Supabase's raw captcha rejections are cryptic. All of them mean the same
  // thing to the user: the check went stale, and a retry (which now always
  // fetches a fresh token) will fix it.
  if (/timeout-or-duplicate|already-seen-response|captcha protection/i.test(msg)) {
    return "The security check expired. Just click the button again — it refreshes automatically.";
  }
  if (/user not found|no user/i.test(msg)) return "We couldn't find that account.";
  return msg;
}
