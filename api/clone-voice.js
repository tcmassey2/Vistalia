// EstateMotion — Voice clone provisioning.
//
// Accepts a voice sample (audio file, mp3/m4a/wav, ~30-90 seconds) plus the
// agent's display name, calls ElevenLabs Instant Voice Clone, returns the
// voice_id for storage in the agent's brand kit.
//
// Why server-side: ELEVENLABS_API_KEY must never reach the browser. The
// frontend uploads the audio to this endpoint as a base64-encoded blob (or
// multipart, see below). We forward to ElevenLabs and pass the voice_id back.
//
// ElevenLabs IVC takes the sample as multipart/form-data on /v1/voices/add.
// Cost: free with paid plans, then ~$0 per clone (you pay per-character on
// synthesis, not per-clone).

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";
const MAX_SAMPLE_BYTES = 12 * 1024 * 1024; // 12 MB — ~10 minutes of compressed audio

export default async function handler(request, response) {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  if (request.method !== "POST") {
    response.status(405).json({ status: "failed", error: "Use POST /api/clone-voice with a JSON body." });
    return;
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    response.status(503).json({
      status: "failed",
      error: "Voice cloning is not configured. Set ELEVENLABS_API_KEY in Vercel env vars."
    });
    return;
  }

  try {
    const body = parseBody(request.body);
    const audioBase64 = String(body.audioBase64 || "").trim();
    const fileName = String(body.fileName || "voice-sample.mp3").replace(/[^a-zA-Z0-9._-]+/g, "-");
    const contentType = String(body.contentType || "audio/mpeg");
    const voiceLabel = String(body.voiceLabel || "Agent").trim().slice(0, 80);
    const description = String(body.description || `EstateMotion voice clone for ${voiceLabel}`).slice(0, 200);

    if (!audioBase64) {
      response.status(400).json({ status: "failed", error: "audioBase64 is required (base64-encoded audio sample)." });
      return;
    }

    const audioBuffer = Buffer.from(audioBase64, "base64");
    if (audioBuffer.length === 0) {
      response.status(400).json({ status: "failed", error: "Audio sample decoded to zero bytes." });
      return;
    }
    if (audioBuffer.length > MAX_SAMPLE_BYTES) {
      response.status(413).json({
        status: "failed",
        error: `Voice sample is ${Math.round(audioBuffer.length / 1024 / 1024)}MB — keep it under ${Math.round(MAX_SAMPLE_BYTES / 1024 / 1024)}MB.`
      });
      return;
    }

    // ElevenLabs voices/add expects multipart/form-data with fields:
    //   name, description, files[] (the audio sample), labels (JSON)
    const form = new FormData();
    form.append("name", voiceLabel);
    form.append("description", description);
    form.append("labels", JSON.stringify({ source: "estatemotion", role: "real_estate_agent" }));
    form.append(
      "files",
      new Blob([audioBuffer], { type: contentType }),
      fileName
    );

    const cloneResponse = await fetchWithTimeout(`${ELEVENLABS_BASE}/voices/add`, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY
        // Note: don't set Content-Type — fetch sets the multipart boundary itself
      },
      body: form
    }, 60000);

    if (!cloneResponse.ok) {
      const errBody = await cloneResponse.text().catch(() => "");
      const reason = parseElevenLabsError(errBody) || `ElevenLabs returned ${cloneResponse.status}.`;
      response.status(cloneResponse.status === 401 ? 401 : 502).json({
        status: "failed",
        error: `Voice clone failed: ${reason}`
      });
      return;
    }

    const result = await cloneResponse.json().catch(() => ({}));
    const voiceId = result.voice_id || result.voiceId || "";
    if (!voiceId) {
      response.status(502).json({
        status: "failed",
        error: "ElevenLabs response was missing voice_id."
      });
      return;
    }

    response.status(200).json({
      status: "ready",
      voiceId,
      voiceLabel,
      // Quick smoke-test URL the frontend can hit later to preview the clone
      previewUrl: `/api/synthesize-narration?voiceId=${encodeURIComponent(voiceId)}&text=${encodeURIComponent(`Hi, I'm ${voiceLabel}, and this is your EstateMotion voice clone test.`)}`
    });
  } catch (error) {
    response.status(500).json({
      status: "failed",
      error: error.message || "Voice clone request failed."
    });
  }
}

function parseElevenLabsError(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.detail?.message || parsed?.detail?.[0]?.msg || parsed?.message || "";
  } catch {
    return text.slice(0, 200);
  }
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
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

// Vercel serverless functions cap body size at 4.5MB by default. We're
// receiving base64 (1.33× expansion of binary), so a 90s mp3 at 128kbps
// (~1.4MB binary → ~1.9MB base64) fits well under the cap. Keep an eye on
// this if voice samples ever go higher quality.
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "8mb"
    }
  }
};
