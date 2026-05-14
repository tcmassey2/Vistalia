export default function handler(request, response) {
  response.setHeader("Content-Type", "application/javascript; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.status(200).send(`window.ESTATEMOTION_ENV = ${JSON.stringify(publicEnv())};`);
}

// Auto-detection rule: if the real keys for a subsystem are present, mock mode
// is OFF by default. An explicit MOCK_* env var still wins, so you can force
// MOCK_RENDERING=true for staging tests even with keys present.
function publicEnv() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || "";
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || "";
  const openaiKeyPresent = Boolean(process.env.OPENAI_API_KEY);
  const renderWorkerConfigured = Boolean(process.env.RENDER_WORKER_URL || process.env.RENDER_ENDPOINT);
  const stripeConfigured = Boolean(process.env.STRIPE_SECRET_KEY || process.env.STRIPE_PUBLISHABLE_KEY);
  const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

  return {
    MOCK_AI: readFlag("MOCK_AI", !openaiKeyPresent),
    MOCK_RENDERING: readFlag("MOCK_RENDERING", !renderWorkerConfigured),
    MOCK_STRIPE: readFlag("MOCK_STRIPE", !stripeConfigured),
    MOCK_SUPABASE: readFlag("MOCK_SUPABASE", !supabaseConfigured),
    SUPABASE_URL: supabaseUrl,
    SUPABASE_ANON_KEY: supabaseAnonKey,
    LISTING_PHOTOS_BUCKET: process.env.LISTING_PHOTOS_BUCKET || process.env.SUPABASE_LISTING_PHOTOS_BUCKET || "listing-photos",
    SUPABASE_STORAGE_PRIVATE: readFlag("SUPABASE_STORAGE_PRIVATE", false),
    SUPABASE_SIGNED_URL_TTL_SECONDS: Number(process.env.SUPABASE_SIGNED_URL_TTL_SECONDS || 172800),
    OPENAI_ENDPOINT: process.env.OPENAI_ENDPOINT || "",
    VISION_CLASSIFICATION_ENDPOINT: process.env.VISION_CLASSIFICATION_ENDPOINT || "/api/classify-image",
    CREATE_EDIT_PLAN_ENDPOINT: process.env.CREATE_EDIT_PLAN_ENDPOINT || "/api/create-edit-plan",
    MUSIC_LUXURY_URL: process.env.MUSIC_LUXURY_URL || "",
    MUSIC_VIRAL_URL: process.env.MUSIC_VIRAL_URL || "",
    MUSIC_MLS_CLEAN_URL: process.env.MUSIC_MLS_CLEAN_URL || "",
    MUSIC_INVESTOR_URL: process.env.MUSIC_INVESTOR_URL || "",
    STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY || process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY || "",
    STRIPE_CHECKOUT_ENDPOINT: process.env.STRIPE_CHECKOUT_ENDPOINT || "",
    RENDER_ENDPOINT: process.env.RENDER_ENDPOINT || "",
    SUPABASE_JS_URL: process.env.SUPABASE_JS_URL || "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm",
    // Sentry — public DSN is safe to ship to the browser. Keep separate
    // from any server-side SENTRY_DSN you might add later for /api/* errors.
    SENTRY_DSN_PUBLIC: process.env.SENTRY_DSN_PUBLIC || "",
    SENTRY_ENVIRONMENT: process.env.VERCEL_ENV || process.env.SENTRY_ENVIRONMENT || "production",
    // Plausible Analytics — domain string. Empty = analytics disabled.
    PLAUSIBLE_DOMAIN: process.env.PLAUSIBLE_DOMAIN || "",
    // hCaptcha public site key. Required by Supabase auth when CAPTCHA
    // is enabled in the Supabase Dashboard. Empty = signup form skips
    // the widget and Supabase accepts unverified signups.
    HCAPTCHA_SITE_KEY: process.env.HCAPTCHA_SITE_KEY || ""
  };
}

function readFlag(key, fallback) {
  const value = process.env[key];
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true" || value === "1";
}
