import { useState, type FormEvent } from "react";
import { useStore } from "../lib/store";
import { signIn, signUp } from "../lib/supabase";

export default function AuthScreen() {
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const setToast = useStore((s) => s.setToast);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setInfo("");
    setBusy(true);
    try {
      if (mode === "signup") {
        await signUp(email, password);
        setInfo("Check your email to confirm. Then sign in.");
        setMode("signin");
      } else {
        await signIn(email, password);
        setToast("Signed in");
        // store.init's onAuthChange handler will move us to dashboard
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Authentication failed.";
      setError(humanizeAuthError(message));
    } finally {
      setBusy(false);
    }
  };

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
            <h1 className="text-3xl font-semibold tracking-tighter2">
              {mode === "signup" ? "Create your account" : "Welcome back"}
            </h1>
            <p className="text-ink-muted text-sm mt-2">
              {mode === "signup"
                ? "7-day free trial. No credit card required."
                : "Sign in to continue your listing video."}
            </p>
          </div>

          <div className="bg-surface border border-edge rounded-2xl p-6 sm:p-8">
            <div className="inline-flex p-1 bg-surface-input rounded-full border border-edge mb-6">
              <button
                type="button"
                onClick={() => setMode("signin")}
                className={`h-8 px-4 rounded-full text-sm font-medium transition-colors ${
                  mode === "signin" ? "bg-gold text-paper" : "text-ink-muted hover:text-ink"
                }`}
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={() => setMode("signup")}
                className={`h-8 px-4 rounded-full text-sm font-medium transition-colors ${
                  mode === "signup" ? "bg-gold text-paper" : "text-ink-muted hover:text-ink"
                }`}
              >
                Create account
              </button>
            </div>

            <form onSubmit={submit} className="flex flex-col gap-4">
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

              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-soft">Password</span>
                <input
                  type="password"
                  required
                  minLength={8}
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-11 px-3.5 bg-surface-input border border-edge rounded-lg text-ink placeholder:text-ink-dim focus:outline-none focus:border-gold focus:ring-2 focus:ring-gold/15 transition-colors"
                  placeholder={mode === "signup" ? "At least 8 characters" : "Your password"}
                />
              </label>

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
                className="h-11 mt-2 bg-gold hover:bg-gold-light text-paper font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {busy ? "Working..." : mode === "signup" ? "Create account" : "Sign in"}
              </button>
            </form>

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
  return msg;
}
