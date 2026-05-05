// Supabase client + auth helpers + storage upload.
// Single source of truth for everything Supabase-related in the app.

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";
import type { Photo } from "./types";

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

export async function signUp(email: string, password: string) {
  const { data, error } = await supabase().auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  await supabase().auth.signOut();
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
