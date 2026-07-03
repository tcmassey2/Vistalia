// Vistalia — per-scene vision QC (v31.2 "verify-then-deliver").
//
// WHY: Veo is a stochastic generator. Prompt-level prohibitions provably do
// not eliminate hallucinations — the July 2 smoke test produced a floating
// "4%" text artifact WITH the strict no-text fidelity suffix in the prompt.
// The only architecture that ships is: generate → INSPECT → retry/downgrade.
//
// WHAT: after a Veo clip downloads, extract 3 frames (25/50/75%) and ask a
// cheap vision model to compare them against the source listing photo:
//   - text_artifacts:   any text/numbers/symbols/watermarks not in the photo
//   - object_artifacts: objects warped/floating/duplicated/sliding, or new
//                       objects that aren't in the photo
// Cost ≈ $0.01-0.02/scene (≈ $0.15/render). Latency ~2-4s/scene, parallel
// with nothing (runs inline post-download; acceptable at launch scale).
//
// POLICY (implemented in runway-job.mjs scene loop):
//   cinematic clip fails QC → regenerate CONSTRAINED → still fails → Ken
//   Burns floor for that scene. Detected garbage never ships; the floor is
//   static but artifact-free.
//
// FAIL-OPEN: any QC infrastructure error (no OPENAI_API_KEY on the worker,
// timeout, malformed response) passes the clip through and logs — QC must
// never make renders less reliable than they were without it.

import fs from "node:fs/promises";
import path from "node:path";
import { runFFmpeg } from "./ffmpeg-runner.mjs";

const QC_MODEL = process.env.VEO_QC_MODEL || "gpt-4o-mini";
const QC_TIMEOUT_MS = Number(process.env.VEO_QC_TIMEOUT_MS) || 25000;

export function qcEnabled() {
  if (String(process.env.VEO_QC_ENABLED || "").toLowerCase() === "false") return false;
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Inspect a generated clip against its source photo.
 * Returns { pass, reasons, checked } — checked=false means QC could not run
 * (fail-open) and pass is forced true.
 */
export async function qcVeoClip({ clipPath, sourceImageUrl, sceneIndex, roomType, tempDir }) {
  if (!qcEnabled()) return { pass: true, reasons: [], checked: false };
  try {
    const frames = await extractFrames(clipPath, tempDir, sceneIndex);
    const images = [];
    for (const p of frames) {
      const b64 = (await fs.readFile(p)).toString("base64");
      images.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "low" } });
    }

    const body = {
      model: QC_MODEL,
      response_format: { type: "json_object" },
      max_tokens: 200,
      messages: [
        {
          role: "system",
          content:
            "You are a strict quality inspector for AI-generated real-estate video. " +
            "You receive the ORIGINAL listing photo first, then 3 frames from a video " +
            "generated FROM that photo. The video may only move the camera — the scene " +
            "itself must match the photo. Respond with strict JSON: " +
            '{"text_artifacts": boolean, "object_artifacts": boolean, "notes": "≤20 words"}. ' +
            "text_artifacts=true if ANY text, numbers, symbols, captions, or watermark-like " +
            "shapes appear in frames that are not present in the original photo. " +
            "object_artifacts=true if any object is severely warped, floating, duplicated, " +
            "melted, or if a prominent new object appears that is not in the photo. " +
            "Small softness/blur/lighting shifts are NOT artifacts. Be tolerant of minor " +
            "differences; flag only clearly visible defects a home buyer would notice."
        },
        {
          role: "user",
          content: [
            { type: "text", text: `Room type: ${roomType || "unknown"}. First image = original photo. Next 3 = generated frames.` },
            { type: "image_url", image_url: { url: sourceImageUrl, detail: "low" } },
            ...images
          ]
        }
      ]
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QC_TIMEOUT_MS);
    let res;
    try {
      res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    for (const p of frames) fs.unlink(p).catch(() => {});

    if (!res.ok) {
      console.warn(`[qc] scene ${sceneIndex + 1}: OpenAI ${res.status} — fail-open.`);
      return { pass: true, reasons: [], checked: false };
    }
    const data = await res.json().catch(() => null);
    const raw = data?.choices?.[0]?.message?.content || "";
    let verdict;
    try { verdict = JSON.parse(raw); } catch {
      console.warn(`[qc] scene ${sceneIndex + 1}: unparseable verdict — fail-open.`);
      return { pass: true, reasons: [], checked: false };
    }

    const reasons = [];
    if (verdict.text_artifacts === true) reasons.push("text artifacts");
    if (verdict.object_artifacts === true) reasons.push("object artifacts");
    const pass = reasons.length === 0;
    console.info(
      `[qc] scene ${sceneIndex + 1} (${roomType || "?"}): ${pass ? "PASS" : `FAIL (${reasons.join(", ")})`}` +
      (verdict.notes ? ` — ${String(verdict.notes).slice(0, 80)}` : "")
    );
    return { pass, reasons, checked: true };
  } catch (err) {
    console.warn(`[qc] scene ${sceneIndex + 1}: QC error (${err.message}) — fail-open.`);
    return { pass: true, reasons: [], checked: false };
  }
}

async function extractFrames(clipPath, tempDir, sceneIndex) {
  // 3 frames at 25/50/75% of the clip. Probe duration cheaply via ffmpeg -i
  // is messy; use select over fps with known bucket lengths instead: sample
  // at 1s, mid, and late via percentage seek (-ss ratios need duration — use
  // the select filter with n-based picks at 30fps assuming ≥2.5s clips).
  const out = [];
  const { execFile } = await import("node:child_process");
  const dur = await new Promise((resolve) => {
    execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", clipPath],
      (e, stdout) => resolve(e ? 0 : Number(String(stdout).trim()) || 0));
  });
  const d = dur > 0 ? dur : 4;
  for (let i = 0; i < 3; i++) {
    const t = Math.max(0.2, d * [0.25, 0.5, 0.75][i]);
    const framePath = path.join(tempDir, `qc-${String(sceneIndex).padStart(3, "0")}-${i}.jpg`);
    await runFFmpeg(
      ["-y", "-ss", t.toFixed(2), "-i", clipPath, "-frames:v", "1", "-q:v", "5", "-vf", "scale=512:-2", framePath],
      { timeoutMs: 20000, label: `qc:frame-${sceneIndex}-${i}` }
    );
    out.push(framePath);
  }
  return out;
}
