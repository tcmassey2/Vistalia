import { useEffect, useState, type FormEvent } from "react";
import { useStore } from "../lib/store";
import {
  signIn,
  signUp,
  requestPasswordReset,
  updatePassword,
  resendConfirmationEmail
} from "../lib/supabase";
import { events, track } from "../lib/analytics";

type Mode = "signin" | "signup" | "forgot" | "reset";

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
    setError("");
    setInfo("");
    setBusy(true);
    try {
      if (mode === "signup") {
        track(events.signupStarted);
        await signUp(email, password);
        track(events.signupCompleted);
        setPendingConfirmEmail(email);
        setInfo("Check your email to confirm. We've sent the link to " + email + ".");
        setMode("signin");
      } else if (mode === "signin") {
        await signIn(email, password);
        track(events.signinCompleted);
        setToast("Signed in");
        // store.init's onAuthChange handler will move us to dashboard
      } else if (mode === "forgot") {
        await requestPasswordReset(email);
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
    } finally {
      setBusy(false);
    }
  };

  const handleResendConfirmation = async () => {
    if (!pendingConfirmEmail) return;
    setError("");
    setInfo("");
    setBusy(true);
    try {
      await resendConfirmationEmail(pendingConfirmEmail);
      setInfo("Confirmation email re-sent to " + pendingConfirmEmail + ".");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Resend failed.";
      setError(humanizeAuthError(message));
    } finally {
      setBusy(false);
    }
  };

  // Mode-specific copy, kept in one place so the JSX stays readable.
  const heading =
    mode === "signup" ? "Make your first listing video."
    : mode === "signin" ? "Welcome back."
    : mode === "forgot" ? "Reset your password."
    : "Set a new password.";
  const subhead =
    mode === "signup" ? "Free 7-day trial · 3 videos · No credit card."
    : mode === "signin" ? "Pick up where you left off."
    : mode === "forgot" ? "We'll email you a secure link to set a new one."
    : "Choose a strong password to finish resetting.";
  const submitLabel =
    mode === "signup" ? "Create account"
    : mode === "signin" ? "Sign in"
    : mode === "forgot" ? "Send reset link"
    : "Set new password";
  const showEmail = mode !== "reset";
  const showPassword = mode !== "forgot";

  return (
    <div className="min-h-screen flex flex-col">
      <header className="px-6 py-5">
        <a href="/" className="inline-flex items-center gap-2 text-ink hover:text-gold-light transition-colors">
          <span className="grid place-items-center w-7 h-7 rounded-md bg-gradient-to-br from-gold-light to-gold-dim text-paper font-bold italic">
            E
          </span>
          <span className="font-semibold tracking-tightish">EstateMotion</span>
        </a>
      </header>

      <div className="flex-1 grid place-items-center px-6 pb-16">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-semibold tracking-tighter2">{heading}</h1>
            <p className="text-ink-muted text-sm mt-2">{subhead}</p>
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
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="h-11 px-3.5 bg-surface-input border border-edge rounded-lg text-ink placeholder:text-ink-dim focus:outline-none focus:border-gold focus:ring-2 focus:ring-gold/15 transition-colors"
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
                    required
                    minLength={8}
                    autoComplete={mode === "signup" || mode === "reset" ? "new-password" : "current-password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="h-11 px-3.5 bg-surface-input border border-edge rounded-lg text-ink placeholder:text-ink-dim focus:outline-none focus:border-gold focus:ring-2 focus:ring-gold/15 transition-colors"
                    placeholder={mode === "signup" || mode === "reset" ? "At least 8 characters" : "Your password"}
                  />
                </label>
              )}

              {error && (
                <div className="px-3 py-2.5 rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-300">
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

            {mode === "signup" && (
              <p className="text-xs text-ink-dim text-center mt-5 leading-relaxed">
                By creating an account you agree to our terms and privacy policy.
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
  if (/user not found|no user/i.test(msg)) return "We couldn't find that account.";
  return msg;
}
