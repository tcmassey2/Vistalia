// Vistalia — /api/voice-demo
//
// Landing-page voice-clone demo (Troy, launch eve): visitor records ~15s of
// their OWN voice in the browser (mic only — the page never offers a file
// picker), we clone it, speak ONE fixed listing line back in their voice,
// and delete the clone before responding. Nothing is stored.
//
// This is a PUBLIC endpoint wrapping the most abusable capability we have,
// so the guardrails are the feature:
//   - explicit consent flag required (UI shows a consent checkbox)
//   - 3 demos per IP per day (Supabase-backed rateLimit)
//   - honeypot field for dumb bots
//   - soft same-origin check (Origin/Referer must be ours)
//   - 4MB cap / 16KB floor on the sample
//   - the cloned voice lives for the duration of ONE request — created,
//     spoken once with a FIXED line (no caller-controlled text, so this
//     cannot be used as an impersonation TTS service), deleted in finally
//   - fixed demo line only: the response can never say anything we didn't
//     write ourselves

import { rateLimit, refundRateLimit } from "./_lib/rate-limit.js";

// Env-tunable while testing (Troy burned the 3/day cap in minutes on launch
// eve); default stays tight for the public.
const DEMO_MAX = Number(process.env.VOICE_DEMO_MAX) || 3;
const DEMO_WINDOW_MS = 24 * 60 * 60 * 1000;

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";
const MAX_SAMPLE_BYTES = 4 * 1024 * 1024;
const MIN_SAMPLE_BYTES = 16 * 1024;
const DEMO_LINE =
  "Welcome to 4821 East Solano Drive. Golden-hour views, a kitchen made for gathering, " +
  "and a backyard built for evenings outside. This is your listing — in your voice. " +
  "Schedule your private tour today.";

export default async function handler(request, response) {
  setCorsHeaders(response);
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "POST") return response.status(405).json({ error: "Use POST." });

  if (!process.env.ELEVENLABS_API_KEY) {
    return response.status(503).json({ error: "The voice demo is warming up — try again soon." });
  }

  // Soft same-origin: raises the bar for drive-by scripts without pretending
  // to be real auth. The hard limits below are what actually bound abuse.
  const origin = String(request.headers.origin || request.headers.referer || "");
  if (origin && !/vistalia\.ai|localhost|127\.0\.0\.1|vercel\.app/i.test(origin)) {
    return response.status(403).json({ error: "The demo only runs on vistalia.ai." });
  }

  // Validate EVERYTHING before touching the rate limit — a too-short
  // recording or missing consent must not burn one of the caller's three
  // daily tokens (Troy locked himself out testing exactly this way).
  const body = typeof request.body === "string" ? safeJson(request.body) : request.body || {};

  // Bot trap — silently succeed.
  if (String(body.website || "").trim()) return response.status(200).json({ status: "ok" });

  if (body.consent !== true) {
    return response.status(400).json({
      error: "Consent is required — the demo only clones your own voice, with your permission."
    });
  }

  const contentType = String(body.contentType || "audio/webm").toLowerCase();
  if (!contentType.startsWith("audio/")) {
    return response.status(400).json({ error: "That doesn't look like an audio recording." });
  }

  let audio;
  try {
    audio = Buffer.from(String(body.audioBase64 || ""), "base64");
  } catch {
    return response.status(400).json({ error: "The recording couldn't be decoded — try again." });
  }
  if (!audio || audio.length < MIN_SAMPLE_BYTES) {
    return response.status(400).json({ error: "That recording is too short — aim for about ten seconds." });
  }
  if (audio.length > MAX_SAMPLE_BYTES) {
    return response.status(413).json({ error: "That recording is too large — keep it under fifteen seconds." });
  }

  const limited = await rateLimit(request, response, {
    bucket: "voice-demo",
    max: DEMO_MAX,
    windowMs: DEMO_WINDOW_MS
  });
  if (limited) return;

  const headers = { "xi-api-key": process.env.ELEVENLABS_API_KEY };
  let voiceId = "";
  try {
    // 1. Ephemeral clone.
    // Mirror the proven in-app builder (clone-voice.js) exactly: File with
    // name+type, plus the labels field.
    const fileName = contentType.includes("webm") ? "demo.webm" : contentType.includes("mp4") ? "demo.m4a" : "demo.mp3";
    const audioPart = new Uint8Array(audio);
    const audioBlob = typeof File !== "undefined"
      ? new File([audioPart], fileName, { type: contentType })
      : new Blob([audioPart], { type: contentType });
    const form = new FormData();
    form.append("name", `landing-demo-${Date.now()}`);
    form.append("description", "Vistalia landing demo — ephemeral, deleted immediately after one line.");
    form.append("labels", JSON.stringify({ source: "vistalia-landing-demo", ephemeral: "true" }));
    form.append("files", audioBlob, fileName);
    const cloneRes = await fetchWithTimeout(`${ELEVENLABS_BASE}/voices/add`, { method: "POST", headers, body: form }, 25000);
    if (!cloneRes.ok) {
      const detail = await cloneRes.text().catch(() => "");
      console.warn("[voice-demo] clone failed", cloneRes.status, detail.slice(0, 300));
      await refundRateLimit(request, { bucket: "voice-demo", max: DEMO_MAX });
      // Customer copy stays generic; the ops signal is in the status.
      const tierProblem = cloneRes.status === 401 || cloneRes.status === 403;
      return response.status(502).json({
        error: tierProblem
          ? "The live demo is temporarily offline — sign up and your first video is free."
          : "Cloning hiccuped — give it one more try. (That attempt didn't count.)"
      });
    }
    voiceId = String((await cloneRes.json())?.voice_id || "");
    if (!voiceId) {
      await refundRateLimit(request, { bucket: "voice-demo", max: DEMO_MAX });
      return response.status(502).json({ error: "Cloning hiccuped — give it one more try. (That attempt didn't count.)" });
    }

    // 2. One fixed line, spoken in their voice.
    const ttsRes = await fetchWithTimeout(
      `${ELEVENLABS_BASE}/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: DEMO_LINE,
          model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5",
          voice_settings: { stability: 0.5, similarity_boost: 0.8 }
        })
      },
      30000
    );
    if (!ttsRes.ok) {
      const detail = await ttsRes.text().catch(() => "");
      console.warn("[voice-demo] tts failed", ttsRes.status, detail.slice(0, 200));
      await refundRateLimit(request, { bucket: "voice-demo", max: DEMO_MAX });
      return response.status(502).json({ error: "The narration step hiccuped — try once more. (That attempt didn't count.)" });
    }
    const mp3 = Buffer.from(await ttsRes.arrayBuffer());
    return response.status(200).json({ status: "ok", audioBase64: mp3.toString("base64"), mime: "audio/mpeg" });
  } catch (err) {
    console.warn("[voice-demo] error", err?.message || err);
    await refundRateLimit(request, { bucket: "voice-demo", max: DEMO_MAX });
    return response.status(502).json({ error: "Something hiccuped — give it one more try. (That attempt didn't count.)" });
  } finally {
    // 3. The clone never survives the request.
    if (voiceId) {
      fetchWithTimeout(`${ELEVENLABS_BASE}/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE", headers }, 10000)
        .then((r) => { if (!r.ok) console.warn("[voice-demo] voice delete returned", r.status, voiceId); })
        .catch((e) => console.warn("[voice-demo] voice delete failed", voiceId, e?.message));
    }
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "https://vistalia.ai");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export const config = {
  api: { bodyParser: { sizeLimit: "7mb" } },
  maxDuration: 60
};
