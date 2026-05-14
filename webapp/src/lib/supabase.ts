// Supabase client + auth helpers + storage upload.
// Single source of truth for everything Supabase-related in the app.

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";
import type { AgentBranding, Photo } from "./types";

let cachedClient: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const e = env();
  if (!e.SUPABASE_URL || !e.SUPABASE_ANON_KEY) {
    throw new Error(
      "Supabase isn't configured. Set SUPABASE_URL and SUPABASE_ANON_KEY in Vercel env vars."
    );
  }
  cachedClient = createClient(e.SUPABASE_URL, e.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storageKey: "estatemotion.auth"
    }
  });
  return cachedClient;
}

export async function getSession(): Promise<Session | null> {
  try {
    const { data } = await supabase().auth.getSession();
    return data.session ?? null;
  } catch {
    return null;
  }
}

export async function signUp(email: string, password: string, captchaToken?: string) {
  // Pass captchaToken through when present. Supabase verifies it server-side
  // when CAPTCHA is enabled in the Auth settings; ignored otherwise. So
  // shipping this code is safe even if hCaptcha isn't configured yet.
  const { data, error } = await supabase().auth.signUp({
    email,
    password,
    options: captchaToken ? { captchaToken } : undefined
  });
  if (error) throw error;
  return data;
}

export async function signIn(email: string, password: string, captchaToken?: string) {
  const { data, error } = await supabase().auth.signInWithPassword({
    email,
    password,
    options: captchaToken ? { captchaToken } : undefined
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  await supabase().auth.signOut();
}

/* ============================================================
   Password reset + email confirmation resend
   ============================================================ */

// Sends a Supabase password-reset email. The reset link Supabase sends back
// to the inbox routes to /auth/reset (configured in Supabase dashboard →
// Authentication → URL Configuration). For now we route it to / and the
// app picks up the recovery token from the URL hash automatically.
export async function requestPasswordReset(email: string) {
  const redirectTo =
    typeof window !== "undefined" ? `${window.location.origin}/app/` : undefined;
  const { error } = await supabase().auth.resetPasswordForEmail(email, {
    redirectTo
  });
  if (error) throw error;
}

// Update the signed-in user's password (requires an active session, which
// the recovery-email link establishes when the user clicks through).
export async function updatePassword(newPassword: string) {
  const { error } = await supabase().auth.updateUser({ password: newPassword });
  if (error) throw error;
}

// Re-send the email-confirmation message for an unconfirmed signup. Useful
// when the original mail got buried, expired, or never arrived.
export async function resendConfirmationEmail(email: string) {
  const { error } = await supabase().auth.resend({
    type: "signup",
    email
  });
  if (error) throw error;
}

/* ============================================================
   2FA / TOTP — Supabase auth.mfa
   ============================================================
   Two-step flow:
     1. enrollTotpFactor() returns a QR-code SVG + secret. User scans it
        in their authenticator app (1Password, Authy, Google Authenticator).
     2. verifyTotpEnrollment(factorId, code) confirms the 6-digit code from
        the app and "activates" the factor. After this, future sign-ins
        require a TOTP challenge.
   To turn 2FA off, call unenrollTotpFactor(factorId).
   On sign-in, if the user has TOTP enrolled, signIn returns an aal2-required
   session. Use challengeAndVerifyTotp(factorId, code) to finish.
*/

export async function listMfaFactors() {
  const { data, error } = await supabase().auth.mfa.listFactors();
  if (error) throw error;
  return data?.totp || [];
}

export async function enrollTotpFactor() {
  const { data, error } = await supabase().auth.mfa.enroll({ factorType: "totp" });
  if (error) throw error;
  return data; // { id, type, totp: { qr_code, secret, uri } }
}

export async function verifyTotpEnrollment(factorId: string, code: string) {
  const { data: challenge, error: challengeError } = await supabase().auth.mfa.challenge({ factorId });
  if (challengeError) throw challengeError;
  const { data, error } = await supabase().auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code
  });
  if (error) throw error;
  return data;
}

export async function unenrollTotpFactor(factorId: string) {
  const { error } = await supabase().auth.mfa.unenroll({ factorId });
  if (error) throw error;
}

// Used when an existing 2FA-enrolled user signs in. Supabase upgrades the
// session to aal2 once the TOTP code verifies.
export async function challengeAndVerifyTotp(factorId: string, code: string) {
  const { data: challenge, error: challengeError } = await supabase().auth.mfa.challenge({ factorId });
  if (challengeError) throw challengeError;
  const { data, error } = await supabase().auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code
  });
  if (error) throw error;
  return data;
}

// True when the current session needs a 2FA step to be fully authenticated.
// Supabase exposes this as currentLevel='aal1' but nextLevel='aal2'.
export async function needsTotpChallenge(): Promise<{ needed: boolean; factorId?: string }> {
  try {
    const { data: aal } = await supabase().auth.mfa.getAuthenticatorAssuranceLevel();
    if (!aal || aal.currentLevel === aal.nextLevel) return { needed: false };
    if (aal.currentLevel === "aal1" && aal.nextLevel === "aal2") {
      // Find the verified TOTP factor we should challenge against.
      const { data: factors } = await supabase().auth.mfa.listFactors();
      const verified = factors?.totp?.find((f) => f.status === "verified");
      if (!verified) return { needed: false };
      return { needed: true, factorId: verified.id };
    }
    return { needed: false };
  } catch {
    return { needed: false };
  }
}

export function onAuthChange(cb: (session: Session | null) => void) {
  const { data } = supabase().auth.onAuthStateChange((_event, session) => cb(session));
  return () => data.subscription.unsubscribe();
}

/* ============================================================
   Photo upload — to listing-photos bucket
   ============================================================ */

export interface UploadedPhotoMeta {
  storagePath: string;
  bucket: string;
  publicUrl: string;
  durableUrl: string;
}

export async function uploadListingPhoto(
  file: File,
  userId: string,
  projectId: string,
  index: number
): Promise<UploadedPhotoMeta> {
  const e = env();
  const bucket = e.LISTING_PHOTOS_BUCKET || "listing-photos";
  const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const storagePath = `${userId}/projects/${projectId}/${Date.now()}-${index}-${safeFileName}`;

  const { error } = await supabase()
    .storage
    .from(bucket)
    .upload(storagePath, file, {
      cacheControl: "3600",
      upsert: true,
      contentType: file.type || "image/jpeg"
    });

  if (error) {
    throw new Error(`Photo upload failed: ${error.message}`);
  }

  const publicUrl = supabase().storage.from(bucket).getPublicUrl(storagePath).data.publicUrl;

  return {
    storagePath,
    bucket,
    publicUrl,
    durableUrl: publicUrl
  };
}

/* ============================================================
   Agent headshot upload — same bucket, dedicated path namespace.
   Reusing listing-photos avoids needing a new bucket + RLS policy.
   The render-worker only needs a public URL, so this works the same.
   ============================================================ */

export async function uploadAgentHeadshot(
  file: File,
  userId: string
): Promise<{ url: string; storagePath: string }> {
  return uploadBrandAsset(file, userId, "headshot");
}

export async function uploadBrokerageLogo(
  file: File,
  userId: string
): Promise<{ url: string; storagePath: string }> {
  return uploadBrandAsset(file, userId, "logo");
}

// Shared helper for brand-kit image uploads (headshot + logo). Both go to
// the listing-photos bucket under a stable per-asset path so re-uploads
// replace the prior one.
async function uploadBrandAsset(
  file: File,
  userId: string,
  kind: "headshot" | "logo"
): Promise<{ url: string; storagePath: string }> {
  const e = env();
  const bucket = e.LISTING_PHOTOS_BUCKET || "listing-photos";
  const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const storagePath = `${userId}/brand-kit/${kind}-${Date.now()}-${safeFileName}`;

  const { error } = await supabase()
    .storage
    .from(bucket)
    .upload(storagePath, file, {
      cacheControl: "3600",
      upsert: true,
      contentType: file.type || "image/jpeg"
    });

  if (error) {
    throw new Error(`${kind === "headshot" ? "Headshot" : "Logo"} upload failed: ${error.message}`);
  }

  const url = supabase().storage.from(bucket).getPublicUrl(storagePath).data.publicUrl;
  return { url, storagePath };
}

/* ============================================================
   Brand kit persistence — survives logout/login across devices
   ============================================================

   The agent's brand kit (name, brokerage, headshot, logo, license, contact,
   voice clone ID) was localStorage-only through v17 — invisible after a
   browser switch or a fresh login. Now it persists to the `brand_kits`
   table so it follows the user.

   Strategy:
   - fetchBrandKit(userId): one row per user (the "default" kit). Returns
     null when the user has never saved one — fall back to localStorage.
   - saveBrandKit(userId, branding): upsert by user_id. Debounced from the
     store so we don't write on every keystroke.
   - The table has more columns than AgentBranding (instagram_handle,
     primary_color, etc.) — those are written as their schema defaults
     and ignored by the app for now. Migration 06 added the four
     app-specific columns (full_name, license_number, voice_id,
     voice_label) so the round-trip is lossless.
*/

const BRAND_KIT_DEFAULT_NAME = "Default";

export async function fetchBrandKit(userId: string): Promise<AgentBranding | null> {
  if (!userId) return null;
  try {
    const { data, error } = await supabase()
      .from("brand_kits")
      .select(
        "id, full_name, brokerage, phone, email, headshot_url, logo_url, license_number, voice_id, voice_label"
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) {
      console.warn("[brand-kit] fetch failed:", error.message);
      return null;
    }
    const row = Array.isArray(data) && data.length ? data[0] : null;
    if (!row) return null;
    return {
      fullName: row.full_name || "",
      brokerage: row.brokerage || "",
      phone: row.phone || "",
      email: row.email || "",
      headshotUrl: row.headshot_url || "",
      brokerageLogoUrl: row.logo_url || "",
      licenseNumber: row.license_number || "",
      voiceId: row.voice_id || undefined,
      voiceLabel: row.voice_label || undefined
    };
  } catch (err) {
    console.warn("[brand-kit] fetch threw:", err);
    return null;
  }
}

export async function saveBrandKit(userId: string, branding: AgentBranding): Promise<void> {
  if (!userId) return;
  try {
    // Find existing row for this user so we update instead of inserting a
    // new one every save. brand_kits has no unique constraint on user_id
    // (multiple kits per user is allowed by the schema), so do an
    // explicit lookup → update path with insert fallback.
    const { data: existing } = await supabase()
      .from("brand_kits")
      .select("id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1);

    const row = {
      user_id: userId,
      name: BRAND_KIT_DEFAULT_NAME,
      full_name: branding.fullName || "",
      brokerage: branding.brokerage || "",
      phone: branding.phone || "",
      email: branding.email || "",
      headshot_url: branding.headshotUrl || "",
      logo_url: branding.brokerageLogoUrl || "",
      license_number: branding.licenseNumber || "",
      voice_id: branding.voiceId || null,
      voice_label: branding.voiceLabel || null
    };

    if (Array.isArray(existing) && existing.length) {
      const { error } = await supabase()
        .from("brand_kits")
        .update(row)
        .eq("id", existing[0].id);
      if (error) console.warn("[brand-kit] update failed:", error.message);
    } else {
      const { error } = await supabase()
        .from("brand_kits")
        .insert(row);
      if (error) console.warn("[brand-kit] insert failed:", error.message);
    }
  } catch (err) {
    console.warn("[brand-kit] save threw:", err);
  }
}

/* ============================================================
   Image dimensions probe (client-side, free)
   ============================================================ */

export function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({ width: 1200, height: 800 });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

/* ============================================================
   Photo metadata helper — turn an UploadedPhotoMeta + File into a Photo
   ============================================================ */

export function photoFromUpload(
  file: File,
  meta: UploadedPhotoMeta,
  dims: { width: number; height: number },
  order: number
): Photo {
  return {
    id: `photo-${crypto.randomUUID()}`,
    fileName: file.name,
    publicUrl: meta.publicUrl,
    durableUrl: meta.durableUrl,
    storagePath: meta.storagePath,
    bucket: meta.bucket,
    width: dims.width,
    height: dims.height,
    size: file.size,
    order,
    uploadedAt: new Date().toISOString()
  };
}
