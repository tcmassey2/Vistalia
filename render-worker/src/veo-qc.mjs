// Vistalia — per-scene vision QC (v31.2 "verify-then-deliver").
//
// WHY: Veo is a stochastic generator. Prompt-level prohibitions provably do
// not eliminate hallucinations — the July 2 smoke test produced a floating
// "4%" text artifact WITH the strict no-text fidelity suffix in the prompt.
// The only architecture that ships is: generate → INSPECT → retry/downgrade.
//
// WHAT: after a Veo clip downloads, extract 4 frames (12/40/66/92%) and ask a
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
// FAIL-OPEN: any QC infrastructure error (no provider key on the worker,
// timeout, malformed response) passes the clip through and logs — QC must
// never make renders less reliable than they were without it.
// v45.2: dual-provider — Gemini primary when GEMINI_API_KEY is set, OpenAI
// fallback (and vice versa). One provider's rate ceiling can no longer
// black out verification.

import fs from "node:fs/promises";
import path from "node:path";
import { runFFmpeg } from "./ffmpeg-runner.mjs";

const QC_MODEL = process.env.VEO_QC_MODEL || "gpt-4o-mini";
const QC_TIMEOUT_MS = Number(process.env.VEO_QC_TIMEOUT_MS) || 25000;

// v45.2 PROVIDER SPLIT (July 11 blackout): the entire verification layer
// hung off one OpenAI account, and one rate-limit ceiling turned QC + sweep
// completely dark for a whole render. QC now runs on Gemini when
// GEMINI_API_KEY is set (huge limits, cheap vision, and it moves the
// biggest token burn OFF the OpenAI account that the Motion Director
// needs) with automatic failover in BOTH directions on 429/5xx.
// QC_PROVIDER env: "gemini" | "openai" | "auto" (default: gemini if keyed).
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_QC_MODEL = process.env.GEMINI_QC_MODEL || "gemini-2.5-flash";
// v45.4: GEMINI_API_MODE=vertex routes Gemini calls through Vertex AI
// (aiplatform.googleapis.com, express-mode API key), which bills to the
// CLOUD billing account — where Troy's $300 trial credits live. The
// default "gemini" mode (generativelanguage.googleapis.com) bills from
// AI Studio PREPAY credits, a separate wallet that was empty ("Your
// prepayment credits are depleted", July 11). Same request/response
// shapes, same x-goog-api-key header; the key's API restriction decides
// which door is open (Agent Platform API = vertex, Gemini API = gemini).
const GEMINI_API_MODE = String(process.env.GEMINI_API_MODE || "gemini").toLowerCase();
const GEMINI_ENDPOINT = GEMINI_API_MODE === "vertex"
  ? `https://aiplatform.googleapis.com/v1/publishers/google/models/${GEMINI_QC_MODEL}:generateContent`
  : `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_QC_MODEL}:generateContent`;

function resolveQcProvider() {
  const p = String(process.env.QC_PROVIDER || "auto").toLowerCase();
  if (p === "gemini" && GEMINI_KEY) return "gemini";
  if (p === "openai" && process.env.OPENAI_API_KEY) return "openai";
  return GEMINI_KEY ? "gemini" : "openai";
}
function providerAvailable(name) {
  return name === "gemini" ? Boolean(GEMINI_KEY) : Boolean(process.env.OPENAI_API_KEY);
}

// Source photos arrive as URLs; Gemini needs inline base64. Tiny cache —
// the same source image is inspected several times per render (QC attempts
// + sweep), no need to re-download it each call.
const srcB64Cache = new Map();
async function fetchSourceImageB64(url) {
  if (srcB64Cache.has(url)) return srcB64Cache.get(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`source image HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 15 * 1024 * 1024) throw new Error("source image over 15MB");
    const mime = buf[0] === 0x89 && buf[1] === 0x50 ? "image/png"
      : buf[0] === 0x52 && buf[1] === 0x49 ? "image/webp"
      : "image/jpeg";
    const entry = { data: buf.toString("base64"), mime };
    if (srcB64Cache.size > 30) srcB64Cache.clear();
    srcB64Cache.set(url, entry);
    return entry;
  } finally {
    clearTimeout(timer);
  }
}
function stripJsonFences(s) {
  return String(s || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
}

export function qcEnabled() {
  if (String(process.env.VEO_QC_ENABLED || "").toLowerCase() === "false") return false;
  return Boolean(process.env.OPENAI_API_KEY || GEMINI_KEY);
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
    return await runQcInspection({ frames, sourceImageUrl, sceneIndex, roomType, logTag: "qc" });
  } catch (err) {
    console.warn(`[qc] scene ${sceneIndex + 1}: QC error (${err.message}) — fail-open.`);
    return { pass: true, reasons: [], checked: false };
  }
}

/** Shared inspection core — used by the per-clip pass ("qc") and the
 *  final master sweep ("sweep"). v43. */
async function runQcInspection({ frames, sourceImageUrl, sceneIndex, roomType, logTag = "qc", extraContext = "" }) {
  try {
    // v45.2: frames as raw base64 once; each provider adapter formats them
    // its own way (OpenAI data-URLs at high detail — v41.5 finding, low-res
    // images can't inventory edge/through-glass inventions — vs Gemini
    // inline_data parts).
    const frameB64s = [];
    for (const p of frames) {
      frameB64s.push((await fs.readFile(p)).toString("base64"));
    }

    const systemText =
            "You are a strict quality inspector for AI-generated real-estate video. " +
            `You receive the ORIGINAL listing photo first, then ${frames.length} frames IN TIME ORDER ` +
            "from a video generated FROM that photo. The video may only move the camera — " +
            "the scene itself must match the photo and behave rigidly. Respond with strict JSON: " +
            '{"text_artifacts": boolean, "object_artifacts": boolean, "motion_artifacts": boolean, "occlusion_artifacts": boolean, "temporal_artifacts": boolean, "notes": "≤20 words"}. ' +
            "text_artifacts=true if ANY text, numbers, symbols, captions, or watermark-like " +
            "shapes appear in frames that are not present in the original photo. " +
            "CRITICAL — WATERMARKS ARE NEVER ARTIFACTS, IN EITHER DIRECTION: photographer " +
            "watermarks, MLS stamps, and logo overlays are IGNORED COMPLETELY. Present in " +
            "the photo but missing from frames? IGNORE (m25 burned a regen on exactly " +
            "this). Present in both? IGNORE. text_artifacts=true ONLY for text the video " +
            "INVENTED that is not in the photo and is not a watermark-like overlay. " +
            "object_artifacts=true if any object is severely warped, floating, duplicated, " +
            "melted, or if a prominent new object appears that is not in the photo — " +
            "INCLUDING new vegetation: compare the EDGES and CORNERS of the later frames " +
            "against the original photo; bushes, shrubs, trees, or planters that slide into " +
            "frame during the camera move but do not exist in the photo are invented, not " +
            "'revealed' — this is the most common defect on exterior scenes. " +
            "FOR EXTERIOR SCENES, do an explicit GROUND-PLANE INVENTORY (master-23 miss: " +
            "an invented sidewalk + bushes passed as 'consistent'): list mentally every " +
            "walkway, path, driveway, curb, rock border, bush, and planter visible in the " +
            "generated frames, and verify EACH ONE exists in the original photo. Any " +
            "ground-level feature present in the frames but absent from the photo means " +
            "object_artifacts=true — EVEN IF it looks natural and well-integrated. " +
            "FOR INTERIOR SCENES, do a STRUCTURAL INVENTORY (master-28 miss: a whole " +
            "entryway with wooden doors was invented): count the doorways, doors, " +
            "archways, openings, hallways, and staircases in the frames — the count and " +
            "placement must match the original photo exactly. A doorway or opening in " +
            "the frames that is not in the photo = object_artifacts=true, even if it " +
            "looks architecturally plausible. Also check large furniture SHAPE: a sofa " +
            "or sectional that stretches, extends, bends, or changes configuration " +
            "versus the photo = object_artifacts=true. " +
            "Also do a THROUGH-WINDOW INVENTORY (master-26 miss: a house " +
            "was invented outside a living-room window): check the view through every " +
            "window and glass door in the frames against the same window in the photo. " +
            "A building, structure, vehicle, or distinct landscape feature visible " +
            "through glass in the frames but not in the photo = object_artifacts=true. " +
            "A window view that is blurred or blown out in the photo must stay that way " +
            "— the video 'revealing' detail behind glass is invention, not clarity. " +
            "Plausible-looking additions are still inventions: the standard is presence " +
            "in the photo, not visual plausibility. " +
            `motion_artifacts=true if, comparing the ${frames.length} frames AS A SEQUENCE from one ` +
            "continuous camera move, any furniture or object moves RELATIVE TO THE ROOM: " +
            "it stays glued to the same frame position while walls/floor shift behind it, " +
            "it slides across the floor, or it drifts against the direction everything else " +
            "moves. Correct camera motion: ALL objects shift consistently with perspective " +
            "(near objects shift more than far ones) and keep their exact spot on the floor. " +
            "occlusion_artifacts=true if in ANY frame the camera has moved into or through " +
            "a foreground object — a large blurry surface (beam, wall, furniture, plant) " +
            "fills or wipes a major part of the frame, or the room becomes mostly blocked. " +
            "A well-framed shot keeps the space clearly visible in every frame. " +
            "temporal_artifacts=true for TEXTURE BOIL: compare each frame TO THE NEXT " +
            "FRAME (not to the photo — a boiling texture can match the photo in every " +
            "single frame while morphing between them; master-58 shipped chattering tree " +
            "branches this way). Look at tree branches, foliage clusters, leaves, grasses, " +
            "railings, brickwork, tile patterns, and any fine repeating texture: between " +
            "consecutive frames their INTERNAL STRUCTURE must stay the same structure, " +
            "merely shifted by the camera move. Needles or leaves that sprout, vanish, or " +
            "reorganize; branch layouts that redraw; patterns that crawl, rewrite, or " +
            "seethe; edges that ripple like liquid = temporal_artifacts=true. " +
            "LEGITIMATE MOTION IS NOT BOIL: fire and fireplace flames, water surfaces, " +
            "pool ripples, fountains, steam, clouds, swaying curtains, and TV/screen " +
            "content are EXPECTED to change between frames — never flag them. Gentle " +
            "uniform wind-sway of a whole branch is fine; the defect is structure " +
            "REWRITING itself, not structure MOVING. " +
            "SEVERITY BAR (v50.8 — a pine-heavy listing floored 5 of 9 scenes on " +
            "marginal flags): flag temporal_artifacts ONLY when the boil is PROMINENT — " +
            "a buyer watching casually would notice it without being told where to look. " +
            "Subtle shimmer on DISTANT foliage, small background trees, vegetation seen " +
            "THROUGH windows or glass, and fine texture noise in the far background are " +
            "normal generation noise, NOT artifacts. If you would need to look twice or " +
            "zoom in to see it, do not flag it. Foreground foliage that visibly redraws " +
            "its structure = flag; background trees that faintly seethe = ignore. " +
            "Small softness/blur/lighting shifts are NOT artifacts. Be tolerant of minor " +
            "differences; flag only clearly visible defects a home buyer would notice.";
    const userText =
      `Room type: ${roomType || "unknown"}. First image = original photo. Next ${frames.length} = generated frames.` +
      (extraContext ? ` ${extraContext}` : "");

    // Shared retry loop: 429/5xx retried with backoff (v42.2 finding —
    // rate limits are transient by definition), everything else breaks.
    const withRetries = async (label, attempts, doFetch) => {
      let res;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), QC_TIMEOUT_MS);
        try {
          res = await doFetch(controller.signal);
        } finally {
          clearTimeout(timer);
        }
        if (res.status !== 429 && res.status < 500) break;
        if (attempt < attempts - 1) {
          const waitMs = (attempt + 1) * 8000 + Math.floor(Math.random() * 2000);
          console.warn(`[${logTag}] scene ${sceneIndex + 1}: ${label} ${res.status} — retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 2}/${attempts}).`);
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
      return res;
    };

    const callOpenAI = async (attempts) => {
      const body = {
        model: QC_MODEL,
        response_format: { type: "json_object" },
        max_tokens: 200,
        messages: [
          { role: "system", content: systemText },
          {
            role: "user",
            content: [
              { type: "text", text: userText },
              { type: "image_url", image_url: { url: sourceImageUrl, detail: "high" } },
              ...frameB64s.map((b64) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "high" } }))
            ]
          }
        ]
      };
      const res = await withRetries("OpenAI", attempts, (signal) => fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal
      }));
      if (!res.ok) return { ok: false, status: res.status };
      const data = await res.json().catch(() => null);
      return { ok: true, rawText: data?.choices?.[0]?.message?.content || "" };
    };

    const callGemini = async (attempts) => {
      const src = await fetchSourceImageB64(sourceImageUrl);
      const body = {
        systemInstruction: { parts: [{ text: systemText }] },
        contents: [{
          role: "user",
          parts: [
            { text: userText },
            { inline_data: { mime_type: src.mime, data: src.data } },
            ...frameB64s.map((b64) => ({ inline_data: { mime_type: "image/jpeg", data: b64 } }))
          ]
        }],
        // v45.5 (July 11 "unparseable verdict" on every call): gemini-2.5
        // models THINK by default and thinking tokens count against
        // maxOutputTokens — a 200-token cap was consumed entirely by
        // thinking, returning an empty text part. Disable thinking for
        // this simple structured task and leave generous headroom.
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 1024,
          temperature: 0,
          thinkingConfig: { thinkingBudget: 0 }
        }
      };
      const res = await withRetries(GEMINI_API_MODE === "vertex" ? "Gemini(Vertex)" : "Gemini", attempts, (signal) => fetch(
        GEMINI_ENDPOINT,
        {
          method: "POST",
          headers: { "x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal
        }
      ));
      if (!res.ok) return { ok: false, status: res.status };
      const data = await res.json().catch(() => null);
      const rawText = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
      // v45.5 diagnostics: when the model answers 200 but the verdict can't
      // be parsed, the finishReason is the tell (MAX_TOKENS = thinking ate
      // the budget; SAFETY = blocked). Surface it instead of a blind
      // "unparseable".
      return { ok: true, rawText, finishReason: data?.candidates?.[0]?.finishReason || "" };
    };

    const primary = resolveQcProvider();
    const secondary = primary === "gemini" ? "openai" : "gemini";
    let out = await (primary === "gemini" ? callGemini(3) : callOpenAI(3)).catch((e) => ({ ok: false, status: e.message }));
    if (!out.ok && providerAvailable(secondary)) {
      console.warn(`[${logTag}] scene ${sceneIndex + 1}: ${primary} unavailable (${out.status}) — failing over to ${secondary}.`);
      out = await (secondary === "gemini" ? callGemini(2) : callOpenAI(2)).catch((e) => ({ ok: false, status: e.message }));
    }
    for (const p of frames) fs.unlink(p).catch(() => {});

    if (!out.ok) {
      console.warn(`[${logTag}] scene ${sceneIndex + 1}: all providers unavailable (${out.status}) — fail-open.`);
      return { pass: true, reasons: [], checked: false };
    }
    let verdict;
    try { verdict = JSON.parse(stripJsonFences(out.rawText)); } catch {
      console.warn(
        `[${logTag}] scene ${sceneIndex + 1}: unparseable verdict — fail-open.` +
        (out.finishReason ? ` finishReason=${out.finishReason}.` : "") +
        ` raw="${String(out.rawText || "").slice(0, 120)}"`
      );
      return { pass: true, reasons: [], checked: false };
    }

    const reasons = [];
    if (verdict.text_artifacts === true) reasons.push("text artifacts");
    if (verdict.object_artifacts === true) reasons.push("object artifacts");
    if (verdict.motion_artifacts === true) reasons.push("motion artifacts (object moves with camera)");
    if (verdict.occlusion_artifacts === true) reasons.push("occlusion (camera collides with foreground)");
    if (verdict.temporal_artifacts === true) {
      // v50.7 (m64 refresh: the sweep floored a fire pit for "boiling and
      // changing shape" — which is what fire does): the prompt's carve-out
      // for legitimately-moving elements is applied inconsistently by the
      // model, so enforce it in code. If the model's own note names a
      // flame/water/steam element as the moving subject AND no rigid
      // subject (foliage, branches, patterns, shadows) is mentioned, the
      // flag is a false positive — log and ignore.
      const notes = String(verdict.notes || "");
      const flameSubject = /(fire|flame|water|ripple|fountain|steam|smoke|candle)[^.]{0,50}\b(boil|chang|shift|flicker|mov|shimmer|danc)/i.test(notes);
      const rigidSubject = /foliage|tree|branch|grass|plant|shadow|pattern|tile|brick|text|railing|gravel|wall|roof/i.test(notes);
      if (flameSubject && !rigidSubject) {
        console.info(`[${logTag}] scene ${sceneIndex + 1}: temporal flag on a legitimately-moving element ("${notes.slice(0, 70)}") — carve-out enforced, not an artifact.`);
      } else {
        reasons.push("temporal instability (texture boil between frames)");
      }
    }
    const pass = reasons.length === 0;
    console.info(
      `[${logTag}] scene ${sceneIndex + 1} (${roomType || "?"}): ${pass ? "PASS" : `FAIL (${reasons.join(", ")})`}` +
      (verdict.notes ? ` — ${String(verdict.notes).slice(0, 80)}` : "")
    );
    return { pass, reasons, checked: true };
  } catch (err) {
    console.warn(`[${logTag}] scene ${sceneIndex + 1}: inspection error (${err.message}) — fail-open.`);
    return { pass: true, reasons: [], checked: false };
  }
}

/**
 * v43 FINAL SWEEP — re-verify one scene as it appears in the STITCHED
 * master. Extracts 2 frames from the master inside the scene's visible
 * window and runs the same inspector against the source photo. This is
 * the net under the net: it catches scenes the per-scene pass skipped
 * (429 fail-open), transients at different timestamps, and anything the
 * first verdict got wrong. The master legitimately carries branding at
 * this stage — the prompt tells the inspector to ignore it.
 */
export async function qcMasterSceneCheck({ masterPath, startSec, endSec, sourceImageUrl, sceneIndex, roomType, tempDir, highScrutiny = false }) {
  if (!qcEnabled()) return { pass: true, reasons: [], checked: false };
  try {
    const span = Math.max(0.6, endSec - startSec);
    // v43.2: scenes whose per-clip QC never completed (429 fail-open) get
    // THREE frames and a sharper brief — the sweep is their ONLY inspection.
    // m28/m29-s2/m30-s7: three renders running, the defect scene was the
    // unchecked scene every time. m30-s7's invented window sliver sat at the
    // frame edge early in the scene; 30%/75% sampling read past it.
    const times = highScrutiny
      ? [startSec + span * 0.18, startSec + span * 0.5, startSec + span * 0.85]
      : [startSec + span * 0.3, startSec + span * 0.75];
    const frames = [];
    for (let i = 0; i < times.length; i++) {
      const framePath = path.join(tempDir, `sweep-${String(sceneIndex).padStart(3, "0")}-${i}.jpg`);
      await runFFmpeg(
        ["-y", "-ss", times[i].toFixed(2), "-i", masterPath, "-frames:v", "1", "-q:v", "5", "-vf", "scale=512:-2", framePath],
        { timeoutMs: 20000, label: `sweep:frame-${sceneIndex}-${i}` }
      );
      frames.push(framePath);
    }
    return await runQcInspection({
      frames,
      sourceImageUrl,
      sceneIndex,
      roomType,
      logTag: "sweep",
      extraContext:
        "These frames come from the FINAL assembled video, which legitimately contains " +
        "small branded elements: a circular logo in a top corner, a small text watermark " +
        "near a bottom corner, and sometimes a lower-third label chip. IGNORE all of " +
        "those — they are intentional graphics, not artifacts. Judge only the scene itself." +
        (highScrutiny
          ? " CRITICAL: this scene's earlier per-clip verification never completed, so " +
            "THIS is its only inspection before delivery. Be maximally vigilant. Count " +
            "every window and doorway against the source photo — an extra window, even a " +
            "small sliver at a frame edge, is object_artifacts=true. Inspect the frame " +
            "edges specifically for architecture, openings, or objects the photo does not show."
          : "")
    });
  } catch (err) {
    console.warn(`[sweep] scene ${sceneIndex + 1}: sweep error (${err.message}) — fail-open.`);
    return { pass: true, reasons: [], checked: false };
  }
}

async function extractFrames(clipPath, tempDir, sceneIndex) {
  // 4 frames across the clip. Probe duration cheaply via ffmpeg -i
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
  // v42.2 (m27): 4 frames at 12/40/66/92% — a transient invented window
  // flashed "for a slight second" INSIDE a scene that passed 3-frame QC.
  // A fourth sample tightens the largest blind window from ~35% to ~26%
  // of the clip; transients that dodge four frames remain review-gate
  // territory (and are, honestly, sub-second blips).
  const SAMPLE_POINTS = [0.12, 0.4, 0.66, 0.92];
  for (let i = 0; i < SAMPLE_POINTS.length; i++) {
    const t = Math.max(0.2, d * SAMPLE_POINTS[i]);
    const framePath = path.join(tempDir, `qc-${String(sceneIndex).padStart(3, "0")}-${i}.jpg`);
    await runFFmpeg(
      ["-y", "-ss", t.toFixed(2), "-i", clipPath, "-frames:v", "1", "-q:v", "5", "-vf", "scale=512:-2", framePath],
      { timeoutMs: 20000, label: `qc:frame-${sceneIndex}-${i}` }
    );
    out.push(framePath);
  }
  return out;
}
