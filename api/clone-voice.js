// Vistalia — Voice clone provisioning.
//
// Two operations on this endpoint:
//   GET  /api/clone-voice?diagnose=1  → health check (verifies API key works,
//                                       reports plan tier + IVC availability,
//                                       no upload required)
//   POST /api/clone-voice              → ingest a voice sample → ElevenLabs
//                                        Instant Voice Clone → return voice_id
//
// IVC is gated by ElevenLabs plan tier:
//   Free / Starter ($5/mo)  → IVC NOT INCLUDED
//   Creator ($22/mo)         → IVC included (the minimum for our use case)
//   Pro / Scale / Business   → IVC + PVC + higher concurrency
//
// We surface this gating explicitly so users on a too-low tier get told
// to upgrade rather than seeing a generic "voice clone failed" error.

import { requireUser } from "./_lib/auth.js";
import { rateLimit } from "./_lib/rate-limit.js";

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";
const MAX_SAMPLE_BYTES = 12 * 1024 * 1024; // 12 MB cap
const ACCEPTED_MIME_PREFIXES = ["audio/"];

export default async function handler(request, response) {
  setCorsHeaders(response);
  if (request.method === "OPTIONS") { response.status(204).end(); return; }

  if (!process.env.ELEVENLABS_API_KEY) {
    response.status(503).json({
      status: "failed",
      error: "Voice cloning is not configured. Set ELEVENLABS_API_KEY in Vercel env vars."
    });
    return;
  }

  // v26: auth + rate limit. Voice cloning is both ElevenLabs spend AND an
  // impersonation-abuse vector — unauthenticated cloning of arbitrary audio
  // is exactly the thing we never want traced back to our API key. Auth
  // applies to the diagnostic too (it reveals plan/billing details).
  const auth = await requireUser(request, response);
  if (!auth.ok) return;
  const limited = await rateLimit(request, response, {
    bucket: "clone-voice",
    max: 5,
    windowMs: 60 * 60 * 1000
  });
  if (limited) return;

  // GET ?diagnose=1 — health check / plan inspector
  if (request.method === "GET") {
    await runDiagnostic(response);
    return;
  }
  if (request.method !== "POST") {
    response.status(405).json({ status: "failed", error: "Use POST /api/clone-voice (or GET ?diagnose=1)." });
    return;
  }

  try {
    const body = parseBody(request.body);
    const audioBase64 = String(body.audioBase64 || "").trim();
    const fileName = sanitizeFileName(body.fileName || "voice-sample.mp3");
    const contentType = String(body.contentType || "audio/mpeg").toLowerCase();
    const voiceLabel = String(body.voiceLabel || "Agent").trim().slice(0, 80) || "Agent";
    const description = String(body.description || `Vistalia voice clone for ${voiceLabel}`).slice(0, 200);

    // Validate inputs before we burn an ElevenLabs call.
    if (!audioBase64) {
      response.status(400).json({
        status: "failed",
        error: "No audio data received. The recording or file may have failed to encode — try again.",
        errorCategory: "no_audio"
      });
      return;
    }
    if (!ACCEPTED_MIME_PREFIXES.some((prefix) => contentType.startsWith(prefix))) {
      response.status(400).json({
        status: "failed",
        error: `Unsupported audio format "${contentType}". Use MP3, M4A, WAV, or WebM.`,
        errorCategory: "bad_format"
      });
      return;
    }

    let audioBuffer;
    try {
      audioBuffer = Buffer.from(audioBase64, "base64");
    } catch {
      response.status(400).json({
        status: "failed",
        error: "Audio data couldn't be decoded. Try recording again.",
        errorCategory: "decode_failed"
      });
      return;
    }
    if (!audioBuffer || audioBuffer.length === 0) {
      response.status(400).json({
        status: "failed",
        error: "Audio sample decoded to zero bytes.",
        errorCategory: "empty_audio"
      });
      return;
    }
    if (audioBuffer.length > MAX_SAMPLE_BYTES) {
      response.status(413).json({
        status: "failed",
        error: `Voice sample is ${Math.round(audioBuffer.length / 1024 / 1024)}MB — keep it under ${Math.round(MAX_SAMPLE_BYTES / 1024 / 1024)}MB.`,
        errorCategory: "too_large"
      });
      return;
    }
    // Reject implausibly small samples — ElevenLabs needs ~5+ seconds of audio.
    // 5 seconds of 64kbps audio ≈ 40KB; we'll require at least 16KB.
    if (audioBuffer.length < 16 * 1024) {
      response.status(400).json({
        status: "failed",
        error: `Recording is too short (${audioBuffer.length} bytes). Aim for at least 10 seconds of clear speech.`,
        errorCategory: "too_short"
      });
      return;
    }

    console.info("[clone-voice] uploading sample", {
      voiceLabel,
      fileName,
      contentType,
      sizeKB: Math.round(audioBuffer.length / 1024)
    });

    // Build multipart body for ElevenLabs. Use File (which extends Blob) for
    // a clean filename + type bundle. Node 20 has File as a global.
    const form = new FormData();
    form.append("name", voiceLabel);
    form.append("description", description);
    form.append("labels", JSON.stringify({ source: "estatemotion", role: "real_estate_agent" }));
    // Convert Buffer → Uint8Array → Blob. Direct Buffer-to-Blob works on Node 20
    // but Uint8Array is more portable across runtimes.
    const audioPart = new Uint8Array(audioBuffer);
    const audioBlob = typeof File !== "undefined"
      ? new File([audioPart], fileName, { type: contentType })
      : new Blob([audioPart], { type: contentType });
    form.append("files", audioBlob, fileName);

    const cloneResponse = await fetchWithTimeout(`${ELEVENLABS_BASE}/voices/add`, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY
        // DO NOT set Content-Type — undici sets multipart boundary automatically.
      },
      body: form
    }, 60000);

    const responseText = await cloneResponse.text().catch(() => "");
    console.info("[clone-voice] ElevenLabs response", {
      status: cloneResponse.status,
      bodySnippet: responseText.slice(0, 400)
    });

    if (!cloneResponse.ok) {
      const error = parseAndCategorizeError(cloneResponse.status, responseText);
      response.status(error.httpStatus).json({
        status: "failed",
        error: error.userMessage,
        errorCategory: error.category,
        ...(error.upgradeRequired ? { upgradeRequired: true } : {}),
        ...(error.requestId ? { requestId: error.requestId } : {})
      });
      return;
    }

    let result;
    try { result = JSON.parse(responseText); } catch { result = {}; }
    const voiceId = result.voice_id || result.voiceId || "";
    if (!voiceId) {
      response.status(502).json({
        status: "failed",
        error: "The voice service accepted the upload but didn't return a voice ID. Try again.",
        errorCategory: "missing_voice_id"
      });
      return;
    }

    response.status(200).json({
      status: "ready",
      voiceId,
      voiceLabel,
      previewUrl: `/api/synthesize-narration?voiceId=${encodeURIComponent(voiceId)}&text=${encodeURIComponent(`Hi, I'm ${voiceLabel}, and this is your Vistalia voice clone test.`)}`
    });
  } catch (error) {
    console.error("[clone-voice] uncaught error", error);
    response.status(500).json({
      status: "failed",
      error: error.message || "Voice clone request failed.",
      errorCategory: "server_exception"
    });
  }
}

/* ============================================================
   Diagnostic — verify ElevenLabs reachability + plan tier
   ============================================================ */
async function runDiagnostic(response) {
  try {
    const userRes = await fetchWithTimeout(`${ELEVENLABS_BASE}/user`, {
      method: "GET",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY }
    }, 10000);
    const userText = await userRes.text().catch(() => "");
    if (!userRes.ok) {
      const error = parseAndCategorizeError(userRes.status, userText);
      response.status(200).json({
        status: "diagnostic",
        ok: false,
        keyValid: false,
        message: error.userMessage,
        errorCategory: error.category
      });
      return;
    }
    let user;
    try { user = JSON.parse(userText); } catch { user = {}; }
    const subscription = user.subscription || {};
    const tier = String(subscription.tier || "unknown").toLowerCase();
    const charactersUsed = subscription.character_count;
    const characterLimit = subscription.character_limit;
    const canCloneVoice = subscription.can_use_instant_voice_cloning === true;

    response.status(200).json({
      status: "diagnostic",
      ok: true,
      keyValid: true,
      tier,
      tierDisplay: tier.charAt(0).toUpperCase() + tier.slice(1),
      canCloneVoice,
      charactersUsed,
      characterLimit,
      message: canCloneVoice
        ? `Connected to ElevenLabs (${tier}). Voice cloning is available.`
        : `Connected to ElevenLabs (${tier}), but voice cloning is NOT available on your current plan. Upgrade to Creator ($22/mo) or higher to enable Instant Voice Clone.`
    });
  } catch (error) {
    response.status(500).json({
      status: "diagnostic",
      ok: false,
      keyValid: false,
      message: error.message || "Diagnostic failed."
    });
  }
}

/* ============================================================
   ElevenLabs error categorization — converts raw HTTP errors into
   actionable user-facing messages with proper upgrade prompts.
   ============================================================ */
function parseAndCategorizeError(httpStatus, rawBody) {
  let parsed = null;
  try { parsed = JSON.parse(rawBody); } catch { /* not JSON */ }
  const detail = parsed?.detail;
  const detailMessage = typeof detail === "string"
    ? detail
    : (detail?.message || detail?.[0]?.msg || parsed?.message || "");
  const detailStatus = typeof detail === "object" ? (detail?.status || "") : "";
  const haystack = `${detailStatus} ${detailMessage} ${rawBody}`.toLowerCase();
  const requestId = parsed?.request_id || parsed?.requestId || "";

  // Plan-tier gating — ElevenLabs returns this with a 401 typically
  if (
    haystack.includes("voice_limit_reached") ||
    haystack.includes("can_not_use_instant_voice_cloning") ||
    haystack.includes("voice cloning") && haystack.includes("not available") ||
    haystack.includes("can_not_use_instant_voice") ||
    detailStatus === "voice_limit_reached"
  ) {
    return {
      httpStatus: 402,
      category: "plan_upgrade_required",
      upgradeRequired: true,
      requestId,
      userMessage: "Your ElevenLabs plan doesn't include voice cloning. Upgrade to the Creator plan ($22/mo) or higher at elevenlabs.io to enable it. Once upgraded, click 'Start recording' again."
    };
  }

  // Invalid API key
  if (httpStatus === 401 && (haystack.includes("invalid") || haystack.includes("unauthor"))) {
    return {
      httpStatus: 401,
      category: "invalid_api_key",
      requestId,
      userMessage: "ElevenLabs rejected the API key. Check ELEVENLABS_API_KEY in your Vercel env vars and make sure it matches an active key."
    };
  }

  // Audio quality / duration validation
  if (
    haystack.includes("audio") && (haystack.includes("too short") || haystack.includes("duration") || haystack.includes("invalid"))
  ) {
    return {
      httpStatus: 400,
      category: "bad_audio",
      requestId,
      userMessage: "ElevenLabs couldn't process the audio. Try a longer recording (60+ seconds) of clear speech in a quiet room."
    };
  }
  if (haystack.includes("file") && (haystack.includes("format") || haystack.includes("type"))) {
    return {
      httpStatus: 400,
      category: "bad_format",
      requestId,
      userMessage: "ElevenLabs didn't recognize the audio format. Try recording in the browser instead of uploading a file."
    };
  }

  // Rate limit
  if (httpStatus === 429) {
    return {
      httpStatus: 429,
      category: "rate_limit",
      requestId,
      userMessage: "Too many ElevenLabs requests. Wait a minute and try again."
    };
  }

  // Validation error (422)
  if (httpStatus === 422) {
    return {
      httpStatus: 422,
      category: "validation",
      requestId,
      userMessage: detailMessage
        ? `ElevenLabs rejected the upload: ${detailMessage}`
        : "ElevenLabs rejected the upload as invalid. Try a different recording."
    };
  }

  // 5xx — ElevenLabs side
  if (httpStatus >= 500) {
    return {
      httpStatus: 502,
      category: "elevenlabs_server",
      requestId,
      userMessage: `ElevenLabs is having issues right now (${httpStatus}). Try again in a minute.`
    };
  }

  // Fallback — surface whatever they sent
  return {
    httpStatus: httpStatus === 401 ? 401 : 502,
    category: "unknown",
    requestId,
    userMessage: detailMessage
      ? `Voice service error: ${detailMessage}`
      : `ElevenLabs returned ${httpStatus}. ${rawBody.slice(0, 160)}`
  };
}

/* ============================================================
   Helpers
   ============================================================ */
function sanitizeFileName(name) {
  return String(name || "voice-sample").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "voice-sample";
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  try { return JSON.parse(body); } catch { return {}; }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// Vercel serverless body-size config. Default is 4.5MB; raise to 8MB so a
// 90-second 96kbps recording (≈1.5MB binary, ≈2MB base64) has plenty of
// headroom even with future bitrate bumps.
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "8mb"
    }
  }
};
