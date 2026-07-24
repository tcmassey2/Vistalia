// Vistalia — Runway Gen-3 Turbo image-to-video render engine.
// Selected when manifest.engine === "runway". Generates one Runway clip per
// photo scene (parallelized), downloads them, stitches with FFmpeg into the
// final MP4, then uploads to Supabase Storage.
//
// Cost guardrails (Runway Gen-3 Turbo, image_to_video, ~$0.05/sec billed):
//   12 scenes * 5s = 60s of generated video = ~$3.00 per render
// v31 economics: scenes generate at 720p in 4s/6s/8s fal buckets
// ($0.60/$0.90/$1.20). Plans cap at MAX_PLAN_SCENES=18 upstream; this
// worker-side MAX_SCENES=30 is the belt against a hand-crafted manifest —
// absolute worst case 30 × $1.20 = $36 per job.

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
// v35: deriveAspectVariants retired — square is recomposed from source clips
// (see the variants block below); wide is retired until per-aspect generation
// ships. aspect-variants.mjs stays in tree for the future Formats pack.
import { applyVoiceNarration, probeAudioDuration, levelMusicOnlyMaster } from "./voice-mixer.mjs";
import { writeRenderAudit } from "./audit-log.mjs";
import { renderHomographyDrift } from "./homography-drift.mjs";
import { CAPTIONS_FONTS_DIR } from "./captions.mjs";
import { runFFmpeg, timed } from "./ffmpeg-runner.mjs";
import { stitchWithCrossfades, stitchWithSimpleConcat } from "./stitch.mjs";
import { qcVeoClip, qcEnabled, qcMasterSceneCheck } from "./veo-qc.mjs";

const RUNWAY_API_BASE = process.env.RUNWAY_API_BASE || "https://api.dev.runwayml.com/v1";
const RUNWAY_API_VERSION = process.env.RUNWAY_API_VERSION || "2024-11-06";
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per clip
const DEFAULT_CONCURRENCY = 4;
const MAX_SCENES = 30;
const NON_PHOTO_TYPES = new Set(["intro", "outro", "stat", "card", "title", "stats"]);

/* =================================================================
   Encode quality knobs — v19 (clarity + memory safety)
   =================================================================
   v18 jumped from preset=ultrafast → veryfast + crf=21 → 19 for visibly
   sharper renders. On Render Standard's 2GB ceiling that pushed peak
   ffmpeg memory past the OOM-killer threshold (x264's veryfast preset
   keeps ~3-5 reference frames + a 25-frame lookahead window in flight,
   easily 150-250 MB per encoder). v19 dials back to `superfast` (still
   sharper than v17's ultrafast but ~40% less encoder RAM) AND adds
   explicit x264 buffer caps so even worst-case CPUs can't blow the
   memory ceiling.

   Stays at crf=19 — that's where the visible sharpness gain came from,
   and CRF doesn't materially change memory footprint.

   X264_PARAMS — explicit limits on the parameters that drive encoder
                 memory: ref frames, lookahead window, b-frame chain
                 depth, GOP size. Without these x264 picks profile-
                 default values that can be 4-8× larger than we need
                 for short cinematic clips.
   BUFSIZE_MB — bitrate buffer cap. ffmpeg defaults to unbounded which
                under high-detail-frame stress can grow indefinitely.
   COLOR_GRADE — unchanged from v18.
*/
// Temp-dir hygiene (launch audit). Prefix matches the mkdtemp below; keep in
// sync with regenerate-job.mjs if its prefix ever changes.
const TEMP_DIR_PREFIX = "estatemotion-";
const TEMP_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h
function sweepStaleTempDirs() {
  const base = os.tmpdir();
  fs.readdir(base)
    .then(async (entries) => {
      const cutoff = Date.now() - TEMP_MAX_AGE_MS;
      for (const name of entries) {
        // estatemotion-runway- / estatemotion-regen- / estatemotion- (render-job)
        // plus the /test/veo smoke-test dirs.
        if (!name.startsWith(TEMP_DIR_PREFIX) && !name.startsWith("veo-smoke-")) continue;
        const p = path.join(base, name);
        const st = await fs.stat(p).catch(() => null);
        if (st && st.mtimeMs < cutoff) {
          await fs.rm(p, { recursive: true, force: true }).catch(() => {});
        }
      }
    })
    .catch(() => {}); // best-effort — never block or fail a render
}

const ENCODE_PRESET = "superfast";
const ENCODE_CRF_MASTER = "19";
const ENCODE_CRF_DERIVED = "20";
const X264_PARAMS = "rc-lookahead=10:ref=2:bframes=2:keyint=60:scenecut=0";
const BUFSIZE = "2M";
// v31 (720p pivot): Veo now generates 720p and the normalize pass upscales to
// the 1080x1920 master. The grade is split around the scale so it behaves:
//   PRE_SCALE_DENOISE — hqdn3d BEFORE the upscale. Denoising at native 720p is
//     cheaper AND prevents lanczos from magnifying Veo's temporal shimmer into
//     1080p-sized grain (the old upscale path denoised after, which is partly
//     why it read "grainy"). Temporal terms (6/6) do the heavy lifting.
//   COLOR_GRADE — post-scale: same eq/colorbalance as v30.1, unsharp nudged
//     0.15→0.28 luma / 0.08→0.12 chroma to recover the mild softness the
//     upscale adds. THIS is the tunable knob if the phone test reads soft
//     (raise toward 0.35) or grainy/crispy (drop toward 0.15). The old
//     "resolution looks poor" era used 0.4+ on an un-denoised upscale — do
//     not go back there.
const PRE_SCALE_DENOISE = "hqdn3d=2.2:1.6:6:6";
const COLOR_GRADE =
  "eq=contrast=1.05:saturation=0.96:gamma=1.02,colorbalance=rs=0.05:bs=-0.025,unsharp=5:5:0.28:3:3:0.12";

// =================================================================
// v50 FINISHING PASS — "polish lives in finishing, not pixels"
// =================================================================
// Six levers, all per-clip (the v19/v20 OOM lesson: never a second
// full-master encode), all fail-open, all behind env kills:
//   FINISH_PASS=0       — master switch: byte-identical v49 chains
//   FINISH_DEFLICKER=0  — temporal luma smoothing pre-denoise (kills the
//                         faint Veo luma pulse the eye reads as "AI")
//   FINISH_MATCH=0      — scene-to-scene tone leveling: every clip's
//                         luma/saturation nudged toward the render's
//                         median so cuts don't jump in exposure. Clamped
//                         to ±0.045 brightness / ±6% saturation; probe
//                         failure → zero correction.
//   FINISH_GRADE=0      — per-style parametric grade (falls back to the
//                         legacy COLOR_GRADE). MLS keeps COLOR_GRADE
//                         always: compliance-neutral look.
//   FINISH_FILM=0       — film finish: vignette + halation bloom on lit
//                         highlights (luxury only) + fine grain. Never on
//                         MLS.
//   FINISH_TITLE=0      — serif two-line title reveal (falls back to the
//                         v48 single-line chip).
//   DUCK_RAMP=0         — (voice-mixer) smooth attack/release music
//                         ducking → legacy step ducking.
// preNormalized clips (regen path) skip conditioning/grade/film entirely —
// they were graded when first rendered; re-grading compounded contrast on
// every regen before v50.
const FINISH_PASS = process.env.FINISH_PASS !== "0";
const FINISH_DEFLICKER = FINISH_PASS && process.env.FINISH_DEFLICKER !== "0";
const FINISH_MATCH = FINISH_PASS && process.env.FINISH_MATCH !== "0";
const FINISH_GRADE = FINISH_PASS && process.env.FINISH_GRADE !== "0";
const FINISH_FILM = FINISH_PASS && process.env.FINISH_FILM !== "0";
const FINISH_TITLE = FINISH_PASS && process.env.FINISH_TITLE !== "0";

// One-shot ffmpeg filter capability probe. cas/deflicker exist in every
// ffmpeg ≥4.3, but "don't leave room for error": if the binary lacks a
// filter we substitute (cas→unsharp) or skip (deflicker) instead of
// handing ffmpeg a chain it will reject.
let _ffFilterSetPromise = null;
function ffFilterSet() {
  if (_ffFilterSetPromise) return _ffFilterSetPromise;
  _ffFilterSetPromise = new Promise((resolve) => {
    try {
      const proc = spawn("ffmpeg", ["-hide_banner", "-filters"], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      proc.stdout.on("data", (d) => { out += d; });
      const done = () => {
        const set = new Set();
        for (const line of out.split("\n")) {
          const m = line.match(/^\s*[TSC.]{3}\s+([a-z0-9_]+)\s/i);
          if (m) set.add(m[1]);
        }
        resolve(set);
      };
      proc.on("close", done);
      proc.on("error", () => resolve(new Set()));
      setTimeout(() => { try { proc.kill(); } catch {} resolve(new Set()); }, 5000);
    } catch {
      resolve(new Set());
    }
  });
  return _ffFilterSetPromise;
}

// v60.5: mean inter-frame luma delta (signalstats YDIF) of a clip — the
// slideshow guard's yardstick. ~0.7 = deterministic floor / near-still,
// ≈2.2 = healthy Veo-era motion. Downscaled to 270x480 first so a 2.8s
// clip costs well under a second. Resolves NaN on any failure; callers
// treat this as telemetry, never as a gate that can kill a render.
function measureClipMotion(file, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    try {
      const proc = spawn("ffprobe", [
        "-v", "error",
        "-f", "lavfi", "-i", `movie=${file},scale=270:480,signalstats`,
        "-show_entries", "frame_tags=lavfi.signalstats.YDIF",
        "-of", "csv=p=0"
      ], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      proc.stdout.on("data", (d) => { out += d; });
      const finish = () => {
        const xs = out.trim().split("\n").map(Number).filter(Number.isFinite);
        resolve(xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
      };
      proc.on("close", finish);
      proc.on("error", () => resolve(NaN));
      setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    } catch {
      resolve(NaN);
    }
  });
}

// Map the customer-facing style name onto a finishing personality.
function resolveFinishStyle(manifest) {
  if (manifest?.runwayConfig?.complianceMode) return "mls";
  const s = String(manifest?.selectedStyle || "").toLowerCase();
  if (s.includes("mls")) return "mls";
  if (s.includes("social")) return "social";
  if (s.includes("invest")) return "investor";
  if (s.includes("lux") || s.includes("cinematic")) return "luxury";
  return "neutral";
}

// Per-style parametric grade. Same eq/colorbalance family as COLOR_GRADE so
// the character shift is a tune, not a re-look; sharpening moves from
// unsharp to contrast-adaptive (cas) when available — cleaner texture on
// marble/wood, no halo on window frames.
function buildStyleGrade(styleKey, caps) {
  const sharpen = caps.has("cas") ? "cas=0.30" : "unsharp=5:5:0.28:3:3:0.12";
  switch (styleKey) {
    case "mls":
      return COLOR_GRADE; // compliance-neutral: the exact pre-v50 look
    case "luxury":
      return (
        "eq=contrast=1.06:saturation=0.97:gamma=1.02," +
        "colorbalance=rs=0.06:gs=0.005:bs=-0.045," +
        "curves=all='0/0.015 0.5/0.5 1/0.985'," + // gentle filmic S: lifted blacks, protected highlights
        sharpen
      );
    case "social":
      return (
        "eq=contrast=1.07:saturation=1.05:gamma=1.01," +
        "colorbalance=rs=0.02:bs=-0.012," +
        sharpen
      );
    case "investor":
    case "neutral":
    default:
      return (
        "eq=contrast=1.05:saturation=0.96:gamma=1.02," +
        "colorbalance=rs=0.05:bs=-0.025," +
        sharpen
      );
  }
}

// v50.6: the grade for blue-hour/cool scenes.
// v50.7 (Troy, after m64: "still super purple"): neutral wasn't enough —
// twilight listing photos often arrive ALREADY violet from the
// photographer's own grade, so faithful preservation still reads purple.
// Blue-hour now actively DE-PURPLES: pull red out of shadows/mids
// (rs −0.05 / rm −0.02 kills the magenta while leaving blue sky) and ease
// saturation to 0.92. Calibrated on Michelle's actual opener: 'medium'
// strength returns the stucco to cream while the sky stays twilight and
// interior lamps stay golden; 'strong' flattened the dusk entirely.
function buildBlueHourGrade(caps) {
  const sharpen = caps.has("cas") ? "cas=0.30" : "unsharp=5:5:0.28:3:3:0.12";
  return "eq=contrast=1.05:saturation=0.92:gamma=1.01,colorbalance=rs=-0.05:rm=-0.02," + sharpen;
}

// Film finish: vignette + grain as -vf chain pieces, halation as a small
// filter_complex sub-graph (split → threshold → cheap quarter-res boxblur
// bloom → screen blend). Halation is luxury-only — it's the "lit windows
// glow at dusk" look; grain is style-scaled; MLS gets none of it.
function buildFilmFinish(styleKey, caps, dimensions) {
  if (!FINISH_FILM || styleKey === "mls") return { vignette: "", grain: "", halation: false };
  const grainStrength = styleKey === "luxury" ? 5 : 4;
  return {
    vignette: caps.has("vignette") ? "vignette=angle=PI/4.8" : "",
    grain: caps.has("noise") ? `noise=alls=${grainStrength}:allf=t` : "",
    halation: styleKey === "luxury" && caps.has("blend"),
    halationGraph: (inL, outL) => {
      const qw = Math.max(2, Math.round(dimensions.width / 4 / 2) * 2);
      const qh = Math.max(2, Math.round(dimensions.height / 4 / 2) * 2);
      return (
        // v53.2 (m67 "awful" + Michelle's "purple cast" — SAME BUG): all_mode
        // applied screen to the CHROMA planes too. The lutyuv gate only zeroes
        // luma, so U/V rode into the blend at full value, and screen() on
        // neutral chroma is pure poison: screen(128,128)=192, so at 0.22
        // opacity every neutral pixel shifted 128 → ~142 on BOTH chroma
        // planes = a uniform magenta wash on every luxury render since v50
        // (m67 measured U137/V144; math predicts 142). Halation is a LUMA
        // bloom: screen Y only, take base chroma untouched.
        `[${inL}]split=2[hbase][hsrc];` +
        `[hsrc]scale=${qw}:${qh},lutyuv=y='if(gt(val,190),val,0)',boxblur=10:2,` +
        `scale=${dimensions.width}:${dimensions.height}[hglow];` +
        `[hbase][hglow]blend=c0_mode=screen:c0_opacity=0.22:c1_mode=normal:c1_opacity=1:c2_mode=normal:c2_opacity=1[${outL}]`
      );
    }
  };
}

// Scene-to-scene tone leveling. Probes mean luma (YAVG) + saturation
// (SATAVG) on ~8 sampled frames per clip, computes the render's median as
// reference, and returns a per-scene clamped eq correction. Any probe or
// parse failure → empty map → zero corrections (fail-open).
// v50.6: probing and correction-building split — the caller needs the raw
// per-scene tones too (chroma drives blue-hour grade protection), and a
// shared mutable cache would race under RENDER_CONCURRENCY=2.
async function probeSceneTones(clipResults) {
  const stats = new Map();
  for (const clip of clipResults) {
    if (!clip?.clipPath || clip.preNormalized) continue;
    try {
      const s = await probeClipTone(clip.clipPath);
      if (s) stats.set(clip.sceneIndex, s);
    } catch { /* fail-open per clip */ }
  }
  return stats;
}

function buildSceneMatchCorrections(stats) {
  if (!stats || stats.size < 3) return new Map();
  const med = (arr) => {
    const a = [...arr].sort((x, y) => x - y);
    return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
  };
  const refY = med([...stats.values()].map((s) => s.y));
  const refSat = med([...stats.values()].map((s) => s.sat));
  const out = new Map();
  for (const [idx, s] of stats) {
    const bRaw = ((refY - s.y) / 255) * 0.9;
    const b = Math.max(-0.045, Math.min(0.045, bRaw));
    const satRaw = s.sat > 1 ? refSat / s.sat : 1;
    const satF = Math.max(0.94, Math.min(1.06, satRaw));
    const bStr = Math.abs(b) >= 0.008 ? b.toFixed(4) : null;
    const satStr = Math.abs(satF - 1) >= 0.02 ? satF.toFixed(3) : null;
    if (!bStr && !satStr) continue;
    const parts = [];
    if (bStr) parts.push(`brightness=${bStr}`);
    if (satStr) parts.push(`saturation=${satStr}`);
    out.set(idx, `eq=${parts.join(":")}`);
  }
  return out;
}

async function probeClipTone(clipPath) {
  return await new Promise((resolve) => {
    try {
      const proc = spawn("ffmpeg", [
        "-hide_banner", "-v", "error",
        "-i", clipPath,
        "-vf", "select='not(mod(n,12))',signalstats,metadata=print:file=-",
        "-frames:v", "8",
        "-f", "null", "-"
      ], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      proc.stdout.on("data", (d) => { out += d; });
      const finish = () => {
        const ys = [...out.matchAll(/YAVG=([0-9.]+)/g)].map((m) => Number(m[1]));
        const sats = [...out.matchAll(/SATAVG=([0-9.]+)/g)].map((m) => Number(m[1]));
        const us = [...out.matchAll(/UAVG=([0-9.]+)/g)].map((m) => Number(m[1]));
        const vs = [...out.matchAll(/VAVG=([0-9.]+)/g)].map((m) => Number(m[1]));
        if (!ys.length) return resolve(null);
        const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
        resolve({
          y: avg(ys),
          sat: sats.length ? avg(sats) : 0,
          u: us.length ? avg(us) : 128,
          v: vs.length ? avg(vs) : 128
        });
      };
      proc.on("close", finish);
      proc.on("error", () => resolve(null));
      setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, 15000);
    } catch {
      resolve(null);
    }
  });
}

export async function renderRunwayJob(body, options = {}) {
  const { manifest, requestedFormat } = body || {};
  validateRunwayManifest(manifest);

  // v26.3 (Phase 2): this orchestrator is now engine-agnostic. engine "veo"
  // generates per-scene clips via Veo 3.1 Fast on fal.ai; everything else
  // (stitch, voice, variants, uploads) is unchanged. Runway path preserved
  // for rollback via VEO_PRODUCTION=false on the dispatcher.
  const isVeo = String(manifest?.engine || "runway").toLowerCase() === "veo";

  if (isVeo && !process.env.FAL_KEY) {
    throw new Error("FAL_KEY is required for Veo rendering. Set it on the render-worker host.");
  }
  if (!isVeo && !process.env.RUNWAY_API_KEY) {
    throw new Error("RUNWAY_API_KEY is required for Runway rendering. Set it on the render-worker host.");
  }

  const jobId = options.jobId || createJobId(manifest);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "estatemotion-runway-"));
  // Launch-audit fix: reap temp dirs from crashed/failed/zombie jobs. Each
  // job writes 100-500MB under os.tmpdir() and (pre-fix) NOTHING ever
  // deleted it — the worker disk filled until renders started failing.
  // Success-path dirs are removed explicitly below; this sweeper catches
  // every other exit (throw, timeout, worker restart mid-job). 2h cutoff
  // comfortably exceeds the 18-min render hard cap, and leaves
  // storageSkipped fallback files downloadable for 2h.
  sweepStaleTempDirs();
  const photoScenes = manifest.scenes
    .filter((scene) => !NON_PHOTO_TYPES.has(String(scene.type || "photo").toLowerCase()))
    .slice(0, MAX_SCENES);

  if (photoScenes.length === 0) {
    throw new Error("Runway render manifest has no photo scenes.");
  }

  options.onProgress?.({ phase: "Submitting Runway clips", progress: 6, scenesTotal: photoScenes.length });

  const concurrency = Math.min(
    Number(process.env.RUNWAY_CONCURRENCY || DEFAULT_CONCURRENCY),
    photoScenes.length
  );

  // Compliance Mode: every scene uses Ken Burns instead of Runway.
  // Zero hallucination risk, no Runway credits used.
  const complianceMode = Boolean(manifest?.complianceMode);
  if (complianceMode) {
    console.info(`[runway] complianceMode=true — bypassing Runway, using Ken Burns for all ${photoScenes.length} scenes.`);
  }

  // Hallucination Guard — content-aware protection that goes beyond simple
  // roomType matching. Three levels:
  //   "off"      — pure Runway, no protection (legacy behavior)
  //   "balanced" — default. Kitchens + bathrooms + any scene with a risk
  //                score above 60 get Ken Burns. Everything else: Runway.
  //   "strict"   — All kitchens. Plus risk > 35 forces Ken Burns. Use this
  //                for MLS-grade reliability when AI hallucinations would
  //                be a liability (legally or commercially).
  // Backwards compat: legacy manifest.protectHighRiskRooms=true maps to
  // "balanced"; protectHighRiskRooms=false maps to "off".
  const guardLevel = resolveGuardLevel(manifest);
  if (guardLevel !== "off" && !complianceMode) {
    console.info(`[runway] hallucinationGuard=${guardLevel} — content-aware protection active.`);
    // v40: style provenance in the worker log — settles "which style did
    // this render actually carry" without touching the browser console.
    console.info(`[runway] manifest style="${manifest?.selectedStyle || ""}" musicMood="${manifest?.musicMood || ""}"`);
  }

  let scenesCompleted = 0;
  let fallbackCount = 0;
  let qcRetryCount = 0;      // v31.2: clips regenerated constrained after QC fail
  let qcThirdTryCount = 0;   // v34: clips that needed the third (pull_out) attempt
  let qcFloorCount = 0;      // v36: clips shipped on the premium photo-motion floor
  let qcFailOpenCount = 0;   // v45.1: clips that shipped with NO completed verdict (rate-limit blackout telemetry)
  let guardForcedCount = 0;
  // v49 stall circuit breaker. 2026-07-16 fal outage: all 8 scenes stalled
  // the full 360s TWICE each — ~23 min of dead waiting blew the job timeout
  // with the video otherwise complete. 3+ stalls in one job = provider-wide
  // outage; once open, remaining scenes skip Veo and go straight to the
  // deterministic floor, so an outage render completes in ~10 min.
  let falStallCount = 0;
  const FAL_STALL_BREAKER = 3;
  // v49: provider content-policy flags (Veo refuses image-to-video on photos
  // with people — common in real estate: agents in kitchens, sellers,
  // mirror reflections). Retrying the same photo can never pass the checker,
  // so these skip all remaining Veo attempts and floor immediately.
  const isContentPolicyError = (err) =>
    /content_policy_violation|content checker|flagged by a content/i.test(String(err?.message || err || ""));
  // v34.6 DROP-SCENE TERMINAL: scenes that fail every attempt are dropped
  // from the render instead of killing it. Each entry: { sceneIndex,
  // photoId, reason }. The floor after the pMap aborts + refunds if drops
  // exceed tolerance (systemic failure looks like MANY drops, not one).
  const droppedScenes = [];
  // Per-scene failure recovery: when Runway fails on a single scene we
  // generate a Ken-Burns–style fallback clip from the same photo using
  // ffmpeg locally. The render completes with mixed Cinematic AI and
  // Ken-Burns scenes rather than dying with one bad apple. Daily-cap
  // errors still propagate up — those need user action, not a fallback.
  // v45.14 watchdog: backstop for anything the per-attempt deadline can't
  // see. If the generation phase makes zero scene progress for WATCHDOG_MS,
  // the process is wedged in an await no guard covers — exit loudly. Render
  // restarts the service in ~1-2 min and the pull-queue re-claims the job:
  // a 25-minute heartbeat-expiry stall becomes ~3 minutes, automatically.
  const WATCHDOG_MS = Number(process.env.JOB_WATCHDOG_MS) || 12 * 60 * 1000;
  let lastSceneEventAt = Date.now();
  const touchWatchdog = () => { lastSceneEventAt = Date.now(); };
  const generationWatchdog = setInterval(() => {
    const silentMs = Date.now() - lastSceneEventAt;
    if (silentMs > WATCHDOG_MS) {
      console.error(
        `[watchdog] zero scene progress for ${Math.round(silentMs / 1000)}s — ` +
        `process presumed wedged in an unguarded await; exiting for pull-queue requeue.`
      );
      process.exit(1);
    }
  }, 60000);

  let rawClipResults;
  try {
  rawClipResults = await pMap(
    photoScenes,
    async (scene, index) => {
      touchWatchdog();
      let result;
      // The Hallucination Guard decision is logged with reasoning so we can
      // tune thresholds based on real-world data.
      const guardDecision = decideUseKenBurns(scene, guardLevel);
      // v49 audit instrumentation: how many generation attempts this scene
      // consumed. Persisted to render_audit_log.scenes so floor-rate tuning
      // runs on data instead of guesses (and feeds the MLS-Safe Certificate).
      let attemptsUsed = 1;

      if (isVeo) {
        // v26.3: NO Ken Burns on the Veo path — ever. The guard's risk
        // scoring is repurposed: risky scenes (kitchens, baths, laundry,
        // pools, signage) get a CONSTRAINED locked-tripod prompt instead of
        // a different engine. Validated June 9 bake-off: constrained
        // prompts eliminated hallucination on the failure scenes across
        // Veo 3/3.1, Kling, and Seedance. complianceMode = constrained
        // for every scene.
        const constrained = complianceMode || guardDecision.useKenBurns;
        if (constrained && !complianceMode) {
          guardForcedCount++;
          console.info(
            `[veo] guard:${guardLevel} scene ${index + 1} (${scene.roomType || "unknown"}) ` +
            `→ constrained prompt. risk=${guardDecision.risk}/100, reason="${guardDecision.reason}"`
          );
        }
        let usedConstrained = constrained;
        // Circuit open → don't even ask fal; straight to the floor.
        if (falStallCount >= FAL_STALL_BREAKER) {
          try {
            console.warn(`[veo] scene ${index + 1}: stall circuit OPEN (${falStallCount} fal stalls this job) — straight to PREMIUM PHOTO MOTION floor.`);
            const floor = await generateKenBurnsFallback(scene, manifest, tempDir, index, {
              durationSec: Number(scene.duration) > 0 ? Number(scene.duration) + 0.5 : undefined
            });
            qcFloorCount++;
            scenesCompleted++;
            touchWatchdog();
            return { ...floor, usedPhotoMotionFloor: true, attemptsUsed: 0, floorReason: "circuit_open" };
          } catch (floorErr) {
            console.warn(`[veo] scene ${index + 1} floor failed under open circuit (${floorErr.message}) — DROPPING this scene.`);
            droppedScenes.push({ sceneIndex: index, photoId: scene.photoId, reason: `stall circuit open; floor failed: ${floorErr.message}` });
            return null;
          }
        }
        try {
          result = await generateVeoSceneClip(scene, manifest, tempDir, index, { constrained });
          touchWatchdog();
        } catch (error) {
          touchWatchdog();
          if (error?.code === "FAL_TIMEOUT") falStallCount++;
          // Auto-retry ONCE, always constrained (a failed cinematic attempt
          // most often means the motion asked too much of the source photo).
          // Exception: if this stall just opened the circuit, the retry would
          // stall another 6 minutes too — skip straight to the floor.
          console.warn(`[veo] scene ${index + 1} failed (${error.message}). Retrying once, constrained.`);
          try {
            if (error?.code === "FAL_TIMEOUT" && falStallCount >= FAL_STALL_BREAKER) {
              const skip = new Error(`stall circuit open (${falStallCount} fal stalls) — skipping Veo retry`);
              skip.code = "FAL_CIRCUIT_OPEN";
              throw skip;
            }
            if (isContentPolicyError(error)) {
              const skip = new Error("provider content checker flagged this photo (person in frame?) — Veo retries can't pass, flooring");
              skip.code = "FAL_CONTENT_POLICY";
              throw skip;
            }
            attemptsUsed = 2;
            result = await generateVeoSceneClip(scene, manifest, tempDir, index, { constrained: true });
            touchWatchdog();
            usedConstrained = true;
            fallbackCount++; // counted as "retried", surfaces in phase text
          } catch (retryError) {
            if (retryError?.code === "FAL_TIMEOUT") falStallCount++;
            touchWatchdog();
            // v36: two straight generation failures (fal rejection, hostile
            // photo, outage) → premium photo-motion floor. Deterministic, so
            // it works even when fal is DOWN — an entire render can complete
            // on the floor during an outage instead of aborting.
            try {
              console.warn(`[veo] scene ${index + 1} failed twice (${retryError.message}) — PREMIUM PHOTO MOTION floor.`);
              const floor = await generateKenBurnsFallback(scene, manifest, tempDir, index, {
                durationSec: Number(scene.duration) > 0 ? Number(scene.duration) + 0.5 : undefined
              });
              qcFloorCount++;
              scenesCompleted++;
              return {
                ...floor,
                usedPhotoMotionFloor: true,
                attemptsUsed,
                floorReason: retryError?.code === "FAL_CONTENT_POLICY"
                  ? "content_policy"
                  : retryError?.code === "FAL_CIRCUIT_OPEN"
                    ? "circuit_open"
                    : `generation_failed:${String(retryError?.message || "").slice(0, 60)}`
              };
            } catch (floorErr) {
              console.warn(`[veo] scene ${index + 1} photo-motion floor ALSO failed (${floorErr.message}) — DROPPING this scene.`);
              droppedScenes.push({ sceneIndex: index, photoId: scene.photoId, reason: `generation failed twice (${retryError.message}); floor failed: ${floorErr.message}` });
              return null;
            }
          }
        }

        // v31.2 VERIFY-THEN-DELIVER: prompts alone provably don't stop Veo
        // hallucinations (July 2 smoke test drew a "4%" over a couch WITH the
        // strict no-text suffix in the prompt). Inspect every generated clip
        // against its source photo with a cheap vision check; ladder on
        // failure: cinematic → constrained regen → Ken Burns floor. Detected
        // garbage never ships. QC fails OPEN on infrastructure errors, so
        // renders are never less reliable than they were without it.
        if (qcEnabled() && result) {
          const qcPhoto = (manifest.orderedPhotos || []).find((p) => p.id === scene.photoId);
          const qcSrcUrl = pickImageUrl(scene, qcPhoto);
          let verdict = await qcVeoClip({
            clipPath: result.clipPath, sourceImageUrl: qcSrcUrl,
            sceneIndex: index, roomType: scene.roomType, tempDir
          });
          touchWatchdog();
          // v43.2: track whether the clip that SHIPS carried a completed
          // verdict. Fail-open (429) scenes are the defect carriers — m28,
          // m29 scene 2, m30 scene 7: three renders, the hallucination was
          // on the unchecked scene every time. The final sweep gives these
          // scenes a 3-frame high-scrutiny inspection instead of 2.
          let shipChecked = verdict.checked;
          if (verdict.checked && !verdict.pass && !usedConstrained) {
            console.warn(`[qc] scene ${index + 1} failed QC (${verdict.reasons.join(", ")}) — regenerating constrained.`);
            qcRetryCount++;
            try {
              // v40: retries escalate to the STRICT static prompt (kitchens'
              // first constrained attempt uses the gentle-motion variant).
              attemptsUsed++;
              const retry = await generateVeoSceneClip(scene, manifest, tempDir, index, { constrained: true, strictConstrained: true });
              const verdict2 = await qcVeoClip({
                clipPath: retry.clipPath, sourceImageUrl: qcSrcUrl,
                sceneIndex: index, roomType: scene.roomType, tempDir
              });
              if (verdict2.checked && !verdict2.pass) {
                verdict = verdict2; // fall through to KB floor below
              } else {
                result = retry;
                verdict = verdict2;
                shipChecked = verdict2.checked;
              }
            } catch (qcRetryErr) {
              console.warn(`[qc] scene ${index + 1} constrained regen failed (${qcRetryErr.message}) — Ken Burns floor.`);
              verdict = { checked: true, pass: false, reasons: ["regen failed"] };
            }
          }
          if (verdict.checked && !verdict.pass) {
            // v33.4 policy: motion is the lowest-precision signal (VLM
            // false-positives on legitimate parallax) — motion-only flags
            // ship the constrained clip; Edit Studio regen is the human
            // remedy for true escapees.
            const hardReasons = verdict.reasons.filter((r) => !r.startsWith("motion"));
            if (hardReasons.length === 0) {
              console.warn(
                `[qc] scene ${index + 1}: motion-only flag on the constrained clip — ` +
                `shipping it (likely VLM false positive; Edit Studio regen is the remedy if real).`
              );
            } else {
              // v46 (m50, LAUNCH DAY): the pull_out third attempt is RETIRED.
              // Troy: "the camera should not be panning out." m50 scene 1
              // (exterior) shipped a third-attempt pull-out that INVENTED a
              // sidewalk and a brick street at the reveal edge — and QC
              // passed it, because reveals manufacture plausible content the
              // photo has no data to falsify (the exact v41.2 residual). The
              // ladder was the one path that still violated the exteriors-
              // push-in-only invariant.
              //   Exteriors: no third roll at all — reveals are structurally
              //   unverifiable there. Straight to the deterministic floor.
              //   Interiors: third attempt = STRICT STATIC RE-ROLL. Veo is
              //   stochastic, so a fresh seed on the most conservative
              //   prompt still rescues scenes — it just can't pan out.
              const room3 = String(scene.roomType || "").toLowerCase();
              const isExterior3 = /exterior|backyard|outdoor|front|yard|patio|pool|garden|landscap|deck|amenity/.test(room3);
              let third = null;
              let verdict3 = { checked: true, pass: false, reasons: hardReasons };
              if (isExterior3) {
                console.warn(`[qc] scene ${index + 1} still failing (${hardReasons.join(", ")}) — exterior: no reveal roll, PREMIUM PHOTO MOTION floor.`);
              } else {
                console.warn(`[qc] scene ${index + 1} still failing (${hardReasons.join(", ")}) — third attempt: strict static re-roll.`);
                qcThirdTryCount++;
                // v49: WRAPPED. This was the one unguarded generation call in
                // the ladder — fal threw content_policy_violation here
                // (customer photo with a person in it) and the naked throw
                // killed the ENTIRE render at 6.7 min instead of flooring one
                // scene. Any third-attempt throw now falls through to the
                // floor block below (third stays null).
                try {
                  attemptsUsed++;
                  third = await generateVeoSceneClip(scene, manifest, tempDir, index, { constrained: true, strictConstrained: true });
                  verdict3 = await qcVeoClip({
                    clipPath: third.clipPath, sourceImageUrl: qcSrcUrl,
                    sceneIndex: index, roomType: scene.roomType, tempDir
                  });
                } catch (thirdErr) {
                  console.warn(`[qc] scene ${index + 1} third attempt threw (${String(thirdErr.message || thirdErr).slice(0, 140)}) — PREMIUM PHOTO MOTION floor.`);
                  third = null;
                  verdict3 = { checked: true, pass: false, reasons: hardReasons };
                }
              }
              const hard3 = verdict3.checked ? verdict3.reasons.filter((r) => !r.startsWith("motion")) : [];
              if (!third || (verdict3.checked && hard3.length > 0)) {
                // v36 PREMIUM PHOTO MOTION FLOOR (Troy: "what if our fallback
                // was as good as Reel-E's actual product"). Three genuinely
                // different generations all produced hard artifacts — this
                // PHOTO is hostile to AI motion (baked-in text, mirrors,
                // unusual geometry). Those are EXACTLY the photos where
                // deterministic motion shines: it cannot hallucinate, needs
                // no QC, costs nothing, and at v36 quality (supersampled,
                // eased, room-aware) it matches the slideshow competitors'
                // best output — inside an otherwise-cinematic video. The
                // seller keeps their kitchen; nobody gets a refund email.
                // Drop-scene survives only as the floor-of-the-floor.
                try {
                  console.warn(`[qc] scene ${index + 1} hard-failed all three attempts (${hard3.join(", ")}) — PREMIUM PHOTO MOTION floor (deterministic, cannot hallucinate).`);
                  const floor = await generateKenBurnsFallback(scene, manifest, tempDir, index, {
                    durationSec: Number(scene.duration) > 0 ? Number(scene.duration) + 0.5 : undefined
                  });
                  qcFloorCount++;
                  scenesCompleted++;
                  return { ...floor, usedPhotoMotionFloor: true, attemptsUsed, floorReason: `qc_exhausted:${hard3.join("|").slice(0, 80)}` };
                } catch (floorErr) {
                  console.warn(`[qc] scene ${index + 1} photo-motion floor ALSO failed (${floorErr.message}) — DROPPING this scene.`);
                  droppedScenes.push({ sceneIndex: index, photoId: scene.photoId, reason: `${hard3.join(", ")}; floor failed: ${floorErr.message}` });
                  return null;
                }
              }
              result = third;
              shipChecked = verdict3.checked;
            }
          }
          if (result) {
            result.qcEverChecked = shipChecked;
            if (!shipChecked) {
              qcFailOpenCount += 1;
              console.warn(`[qc] scene ${index + 1} ships UNVERIFIED (inspection incomplete — fail-open) — final sweep will inspect it with high scrutiny.`);
            }
          }
        }
      } else if (complianceMode || guardDecision.useKenBurns) {
        if (!complianceMode && guardDecision.useKenBurns) {
          guardForcedCount++;
          console.info(
            `[runway] guard:${guardLevel} scene ${index + 1} (${scene.roomType || "unknown"}) ` +
            `→ Ken Burns. risk=${guardDecision.risk}/100, reason="${guardDecision.reason}"`
          );
        }
        // Legacy Runway path only: skip Runway for this scene.
        result = await generateKenBurnsFallback(scene, manifest, tempDir, index);
      } else {
        try {
          result = await generateClip(scene, manifest, tempDir, index);
        } catch (error) {
          if (error.code === "RUNWAY_DAILY_CAP") throw error; // surface to user
          console.warn(`[runway] scene ${index + 1} failed (${error.message}). Falling back to Ken Burns.`);
          result = await generateKenBurnsFallback(scene, manifest, tempDir, index);
          fallbackCount++;
        }
      }
      // v49 audit instrumentation: attach attempt count to whatever ships.
      // (Floor paths return earlier with their own attemptsUsed + floorReason.)
      if (result && typeof result === "object" && result.attemptsUsed == null) {
        result.attemptsUsed = attemptsUsed;
      }
      scenesCompleted++;
      const phaseText = complianceMode
        ? `MLS-safe render: scene ${scenesCompleted}/${photoScenes.length}`
        : fallbackCount > 0
          ? `Rendering scene ${scenesCompleted}/${photoScenes.length} (${fallbackCount} fallback${fallbackCount > 1 ? "s" : ""})`
          : `Rendering scene ${scenesCompleted}/${photoScenes.length}`;
      options.onProgress?.({
        // Reserve 78–100% for stitch + derive + shorts + upload, so the
        // Runway phase tops out at ~74% rather than overrunning the bar.
        phase: phaseText,
        progress: 10 + Math.floor((scenesCompleted / photoScenes.length) * 64),
        scenesCompleted,
        scenesTotal: photoScenes.length
      });
      return result;
    },
    { concurrency }
  );
  } finally {
    clearInterval(generationWatchdog);
  }

  // v34.6 drop floor: a couple of drops = hostile photos, curate them out
  // and ship. More than that = something systemic (fal outage, bad photo
  // set) — abort + refund exactly like v34's single-failure behavior.
  const droppedCount = droppedScenes.length;
  const clipResults = rawClipResults.filter(Boolean);
  if (droppedCount > 0) {
    const MAX_DROPS = 2;
    const MIN_KEPT = 4;
    if (droppedCount > MAX_DROPS || clipResults.length < MIN_KEPT) {
      const err = new Error(
        `${droppedCount} scene${droppedCount === 1 ? "" : "s"} failed every generation attempt ` +
        `(${droppedScenes.map((d) => `scene ${d.sceneIndex + 1}: ${d.reason}`).join("; ")}). ` +
        `Render aborted — your credit will be refunded. Some photos may have baked-in text or unusual geometry; try replacing them.`
      );
      err.code = "VEO_SCENE_FAILED";
      throw err;
    }
    // Filter the manifest's scene list so everything downstream — stitch
    // order, narration lines and windows, per-scene durations, duck
    // timing — agrees with the clips that actually exist. The aligned
    // voice path derives all timing from the scene list it receives, so
    // this one filter keeps picture and voice locked.
    const droppedIds = new Set(droppedScenes.map((d) => d.photoId));
    manifest.scenes = (manifest.scenes || []).filter((s) => !droppedIds.has(s.photoId));
    console.warn(
      `[qc] DROPPED ${droppedCount} scene${droppedCount === 1 ? "" : "s"} — ` +
      droppedScenes.map((d) => `#${d.sceneIndex + 1} (${d.reason})`).join(" | ") +
      ` — shipping ${clipResults.length}/${photoScenes.length} scenes. No artifacts ship; the tour is ${droppedCount} scene${droppedCount === 1 ? "" : "s"} shorter.`
    );
  }

  if (!complianceMode && guardLevel !== "off") {
    // v31: name the actual mechanism per engine — on Veo, guard-forced scenes
    // get the constrained prompt (same engine), NOT Ken Burns. The old wording
    // sent a smoke-test debugging session down the wrong path.
    console.info(
      `[runway] Hallucination Guard summary — guard=${guardLevel}, ` +
      `${guardForcedCount}/${photoScenes.length} scene${photoScenes.length === 1 ? "" : "s"} ${isVeo ? "forced to CONSTRAINED Veo prompts" : "locked to Ken Burns"} by risk score, ` +
      `${fallbackCount} additional scene${fallbackCount === 1 ? "" : "s"} ${isVeo ? "retried constrained after a failure" : "fell back due to Runway errors"}.`
    );
  }
  if (isVeo && qcEnabled()) {
    console.info(
      `[qc] Verify-then-deliver summary — ${qcRetryCount} scene${qcRetryCount === 1 ? "" : "s"} regenerated constrained after QC fail, ` +
      `${qcThirdTryCount} needed the third (static re-roll) attempt, ${qcFloorCount} shipped on the PREMIUM PHOTO MOTION floor (v36, deterministic), ` +
      `${droppedCount} dropped (floor-of-the-floor). Detected artifacts shipped: 0 by construction.`
    );
    // v45.1 blackout telemetry (m32b: EVERY inspection 429'd and the render
    // shipped fully unverified without a single loud line saying so).
    if (qcFailOpenCount > 0) {
      const total = clipResults.length;
      const level = qcFailOpenCount >= Math.ceil(total / 2) ? "ALERT" : "notice";
      console.warn(
        `[qc] ${level}: ${qcFailOpenCount}/${total} scenes shipped with NO completed inspection (provider errors — see per-scene lines above). ` +
        (qcFailOpenCount >= Math.ceil(total / 2)
          ? `Verification was effectively DARK for this render — check the QC provider (Gemini/OpenAI) status before rendering again.`
          : `The final sweep re-inspects these with high scrutiny.`)
      );
    }
  } else if (isVeo) {
    console.warn(`[qc] Verify-then-deliver DISABLED — set GEMINI_API_KEY (preferred) or OPENAI_API_KEY on the worker to enable per-scene artifact QC.`);
  }

  options.onProgress?.({ phase: "Stitching final video", progress: 76 });
  const finalMp4 = path.join(tempDir, `${jobId}.mp4`);
  const thumbnailPath = path.join(tempDir, `${jobId}.png`);

  let { normalizedClips } = await stitchClipsAndOverlays(clipResults, manifest, finalMp4, thumbnailPath, options);

  // ── v43 FINAL SWEEP ─────────────────────────────────────────────────
  // The net under the net (Troy, m28: "build a final vision pass to catch
  // any stragglers — agent re-rendering is an extremely last-case plan C").
  // Re-verify every photo scene as it appears in the ASSEMBLED master —
  // fresh timestamps, fresh verdicts — catching scenes the per-clip pass
  // skipped (429 fail-open), transients, and first-verdict mistakes.
  // Any flagged scene is replaced with the DETERMINISTIC floor (it already
  // fooled QC once; no more generative rolls) and the master re-stitches.
  // Runs BEFORE voice/captions so a fix never forces re-narration.
  // Kill switch: FINAL_SWEEP_ENABLED=false.
  if (qcEnabled() && String(process.env.FINAL_SWEEP_ENABLED || "").toLowerCase() !== "false") {
    try {
      options.onProgress?.({ phase: "Final inspection", progress: 78 });
      const useCrossfades = manifest?.runwayConfig?.useCrossfades !== false;
      const overlap = useCrossfades ? 0.5 : 0;
      const sweepFlagged = [];
      let sweepFailOpen = 0; // v45.1 blackout telemetry
      let cursor = 0;
      for (let i = 0; i < clipResults.length; i++) {
        const clip = clipResults[i];
        // Mirror voice-mixer timeline math exactly (visible = d − overlap
        // for EVERY clip — the last photo scene crossfades into the outro).
        const visible = Math.max(0.8, (Number(clip.duration) || 4) - overlap);
        const scene = (manifest.scenes || []).find((s) => s.photoId === clip.photoId) || {};
        const photo = (manifest.orderedPhotos || []).find((p) => p.id === clip.photoId);
        const srcUrl = pickImageUrl(scene, photo);
        // Floor clips are deterministic — nothing to inspect. Skip them.
        if (srcUrl && !clip.fallback && !clip.usedPhotoMotionFloor) {
          // v43.2: a scene that shipped without a completed per-clip verdict
          // gets the 3-frame high-scrutiny inspection — the sweep is its
          // ONLY check (unchecked scenes carried the defect in m28/m29/m30).
          const highScrutiny = clip.qcEverChecked === false;
          if (highScrutiny) {
            console.info(`[sweep] scene ${(clip.sceneIndex ?? i) + 1} shipped unverified per-clip — high-scrutiny sweep (3 frames).`);
          }
          const verdict = await qcMasterSceneCheck({
            masterPath: finalMp4,
            startSec: cursor,
            endSec: cursor + visible,
            sourceImageUrl: srcUrl,
            sceneIndex: clip.sceneIndex ?? i,
            roomType: scene.roomType || "",
            tempDir,
            highScrutiny
          });
          // v43.1: at the FINAL gate, every flag is hard — motion included.
          // m29 proved the exemption wrong here: the sweep FAILed scenes 2
          // ("object moves with camera" = invented landscaping on an
          // unchecked pull-out) and 8 (chair gliding with the pan), both
          // real, both shipped because motion-* was presumed a VLM false
          // positive. That presumption belongs to the per-clip ladder,
          // where a false positive burns a $0.90 regen. Here the remedy is
          // the deterministic floor — cheap, clean, and exactly what Troy
          // blessed ("even if we have to KB a scene that is fine"). The
          // asymmetry flips: a floored good scene is acceptable; a shipped
          // hallucination is not. MAX_SWEEP_REPLACEMENTS still caps blast
          // radius if the VLM has a bad day.
          let hard = verdict.checked ? verdict.reasons : [];
          if (!verdict.checked) sweepFailOpen += 1;
          // v60.7: the v50d address title card is burned into the FIRST
          // scene by design. The sweep flagged its text as an artifact on
          // three straight canaries ("Text overlay '1000 CANARY COURT…' is
          // not in the original photo" — correct observation, wrong
          // verdict) and floored a healthy opener each time. When the
          // title intro is active, text flags on scene 1 are expected;
          // object/motion flags stay hard.
          if (
            (clip.sceneIndex ?? i) === 0 &&
            manifest?.disableAddressCard !== true &&
            String(process.env.FINISH_TITLE || "1") !== "0" &&
            hard.length > 0
          ) {
            const kept = hard.filter((r) => !/text/i.test(String(r)));
            if (kept.length !== hard.length) {
              console.info(`[sweep] scene ${(clip.sceneIndex ?? i) + 1}: text flag ignored — address title card is intentional (${hard.length - kept.length} reason${hard.length - kept.length === 1 ? "" : "s"} dropped).`);
            }
            hard = kept;
          }
          if (hard.length > 0) sweepFlagged.push({ index: i, clip, scene, reasons: hard });
          // Gentle pacing — sequential + spaced keeps us clear of rate
          // limits. v43.1: 250→600ms; m29's sweep hit 429 on most scenes
          // (all recovered via backoff, but each retry costs 8-16s).
          await new Promise((r) => setTimeout(r, 600));
        }
        cursor += visible;
      }

      if (sweepFlagged.length > 0) {
        const MAX_SWEEP_REPLACEMENTS = 4;
        const toReplace = sweepFlagged.slice(0, MAX_SWEEP_REPLACEMENTS);
        if (sweepFlagged.length > MAX_SWEEP_REPLACEMENTS) {
          console.warn(`[sweep] ${sweepFlagged.length} scenes flagged — capping replacements at ${MAX_SWEEP_REPLACEMENTS}; check this photoset.`);
        }
        for (const f of toReplace) {
          console.warn(`[sweep] scene ${f.clip.sceneIndex + 1} (${f.scene.roomType || "?"}) flagged on final inspection (${f.reasons.join(", ")}) — replacing with deterministic floor.`);
          const floor = await generateKenBurnsFallback(f.scene, manifest, tempDir, f.clip.sceneIndex, {
            durationSec: Number(f.clip.duration) > 0 ? Number(f.clip.duration) : undefined
          });
          clipResults[f.index] = { ...floor, usedPhotoMotionFloor: true, sweepReplaced: true, floorReason: `sweep_replaced:${f.reasons.join("|").slice(0, 80)}` };
        }
        console.info(`[sweep] re-stitching master with ${toReplace.length} floor replacement${toReplace.length === 1 ? "" : "s"}.`);
        options.onProgress?.({ phase: "Finalizing video", progress: 79 });
        ({ normalizedClips } = await stitchClipsAndOverlays(clipResults, manifest, finalMp4, thumbnailPath, options));
      }
      console.info(`[sweep] Final inspection summary — ${clipResults.length} scenes swept, ${sweepFlagged.length} flagged, ${Math.min(sweepFlagged.length, 4)} replaced with the deterministic floor${sweepFailOpen > 0 ? `, ${sweepFailOpen} UNINSPECTED (fail-open)` : ""}.`);
      if (sweepFailOpen >= Math.ceil(clipResults.length / 2)) {
        console.warn(`[sweep] ALERT: the final sweep was effectively DARK (${sweepFailOpen}/${clipResults.length} inspections failed open). This render shipped with reduced verification — check the QC provider (Gemini/OpenAI) status before rendering again.`);
      }
    } catch (sweepErr) {
      // Fail-open, always: the sweep must never make a render less reliable.
      console.warn(`[sweep] final inspection errored (${sweepErr.message}) — shipping the stitched master as-is.`);
    }
  }

  // Voice narration — synthesize per-scene narration via ElevenLabs and mix
  // it into the master with music ducking. Wrapped in fail-soft try/catch
  // with a 2-minute time budget: if ElevenLabs is slow / errored / the
  // ffmpeg mix gets stuck, we fall back to the silent master and ship the
  // render with music-only audio. The render completing trumps the
  // narration. Bypassable entirely via manifest.skipNarration: true.
  options.onProgress?.({ phase: "Adding voice narration", progress: 80 });
  let narration = { narrationApplied: false, reason: "skipped" };
  if (manifest?.skipNarration) {
    console.info("[runway] skipNarration=true on manifest — skipping voice step.");
  } else {
    const NARRATION_TIME_BUDGET_MS = 120 * 1000; // 2 minutes hard cap
    try {
      // v26.9 reliability: pass the ACTUAL per-scene clip durations (keyed by
      // photoId) so narration timing tracks the real video, not the plan's
      // stated durations. Eliminates the drift that made voice desync /
      // "stop after 5 seconds" when manifest duration != rendered clip length.
      const actualDurationsByPhoto = {};
      for (const c of clipResults) {
        if (c && c.photoId) actualDurationsByPhoto[c.photoId] = Number(c.duration) || 0;
      }
      narration = await Promise.race([
        applyVoiceNarration({
          masterMp4: finalMp4,
          scenes: manifest.scenes,
          // v38: word-synced captions toggle (webapp Audio panel; default on)
          captionsEnabled: manifest?.captionsEnabled !== false,
          // v38.2: caption skin by video style. v43.4: test the UNION of
          // musicMood and selectedStyle — the old `musicMood || style`
          // short-circuited on mood, so a Modern Social render with a
          // hand-picked non-social track (m32) silently shipped the luxury
          // serif skin instead of the gold-box karaoke. The customer's
          // STYLE choice owns the caption look; an upbeat mood can still
          // opt a non-social style into bold.
          captionsVariant: /social|upbeat|modern|viral/i.test(
            `${manifest?.musicMood || ""} ${manifest?.selectedStyle || ""}`
          ) ? "bold" : "luxury",
          sceneDurationsByPhoto: actualDurationsByPhoto,
          // v31 pipeline-audit fix: with crossfades on, every join consumes
          // 0.5s of clip, so a scene's VISIBLE window is (clipDuration - 0.5)
          // and scene k starts at Σ(visible) — not Σ(clipDuration). The mixer
          // summed raw clip durations, so line k started (k-1)*0.5s late vs
          // picture: ~2s worst-case at v30's 5 scenes (masked by short
          // lines), fatal at v31's 8-17 scenes where late lines get chopped
          // by their own scene-window caps.
          crossfadeOverlapSec: manifest?.runwayConfig?.useCrossfades !== false ? 0.5 : 0,
          // v32: one continuous script for the whole tour (single TTS pass).
          narrationScript: manifest?.narrationScript || "",
          brandKit: manifest.brandKit || {},
          tempDir,
          jobId,
          onProgress: (info) => {
            options.onProgress?.({ phase: info.phase, progress: 80 + Math.floor((info.fraction || 0) * 4) });
          }
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Narration step exceeded 2-minute time budget — shipping music-only audio.")), NARRATION_TIME_BUDGET_MS)
        )
      ]);
    } catch (err) {
      console.warn(`[runway] narration step failed (${err.message}). Continuing with music-only audio.`);
      narration = { narrationApplied: false, reason: err.message || "narration_failed" };
    }
  }
  // v34.1 fingerprint: which voice path ACTUALLY ran — the aligned path
  // silently failing into a fallback cost multiple smoke tests to detect.
  console.info(
    `[voice] PATH USED: ${
      narration.aligned ? "ALIGNED (sentence↔scene locked)" :
      narration.continuous ? "WHOLE-SCRIPT (should be impossible post-v34.1)" :
      narration.narrationApplied ? "PER-LINE (scene-locked fallback)" :
      `NONE (${narration.reason || "unknown"})`
    }`
  );
  // If narration was applied, the mixed file replaces our master going
  // forward. Otherwise the original (silent or music-only) master is used.
  let masterForVariants = narration.narrationApplied ? narration.masterMp4 : finalMp4;
  // v58.3: music-only masters shipped at raw bed level (m75 −24.0, m76
  // −22.9 LUFS — 8-9dB quiet vs platform norm). The narrated path's stem
  // makeup gain never runs when narration is skipped/failed, so level here.
  if (!narration.narrationApplied) {
    masterForVariants = await levelMusicOnlyMaster(masterForVariants, tempDir, jobId);
  }

  // v55: THE $39 INSTANT UNLOCK. Jeff + Lisa both reached a $39 Stripe
  // checkout and abandoned — because nothing promised the purchase applied
  // to the video they already had (the mark was baked in, credits only
  // covered FUTURE renders). Architecture flip: the master above is now
  // CLEAN (per-clip mark removed in v55); trial renders get the vistalia.ai
  // mark in ONE extra encode here. Both files upload; purchase flips the
  // library to the clean URL instantly — no re-render, no wait, no artifact
  // lottery, zero fal cost. Fail-open direction is deliberate: if the mark
  // pass fails, the trial user gets a clean video (a generous one-off),
  // never a failed render.
  let masterCleanPath = "";
  if (manifest.freeRenderWatermark) {
    try {
      const markedPath = path.join(tempDir, `${jobId}-marked.mp4`);
      await runFFmpeg([
        "-y", "-threads", "1",
        "-i", masterForVariants,
        "-vf", buildFreeRenderWatermark({ width: 1080, height: 1920 }),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-preset", ENCODE_PRESET, "-crf", ENCODE_CRF_MASTER,
        "-c:a", "copy",
        markedPath
      ], { timeoutMs: 240000, label: "v55:trial-mark" });
      masterCleanPath = masterForVariants;
      masterForVariants = markedPath;
      console.info("[v55] trial mark applied in final pass — clean master retained for instant unlock.");
    } catch (err) {
      console.warn(`[v55] trial-mark pass failed (${err.message}) — shipping the clean master unmarked rather than failing the render.`);
      masterCleanPath = "";
    }
  }

  // ONE-MASTER simplification: previously this step produced 9:16 +
  // 16:9 + 1:1 variants + a 4K upscale + 3 social shorts (~8 files).
  // Troy's call to simplify: ship a single vertical 9:16 master per
  // render. Saves 30-90s of compute, cuts upload bandwidth, removes
  // a long tail of per-variant failure modes. Users who want a
  // different aspect can re-render with exportFormat changed.
  // deriveAspectVariants + buildSocialShorts modules retained in
  // tree for the future-tier 'Pro Pack' SKU, but no longer called.
  options.onProgress?.({ phase: "Building square format", progress: 86 });
  // v35 TRUE SQUARE (test-16): the derived 1:1 was a center crop of the
  // BAKED 9:16 master — it beheaded the corner badge, clipped card text,
  // and threw away 44% of every composition ("looks a little bit
  // terrible"). Real square = the SAME pipeline run at 1080×1080 from the
  // source clips: square-positioned watermark + headshot + outro card,
  // upward-biased room crop, identical xfade timeline — then the narrated
  // master's finished audio muxed straight on (timelines match to the
  // millisecond, stream copy, no re-mix). Runs in its own temp subdir so
  // no intermediate filename can collide with the vertical pass.
  //
  // WIDE (16:9) IS RETIRED: from a vertical master it can only ever be a
  // pillarboxed 9:16 ("just a framed 9 by 16"). A real wide needs
  // per-aspect Veo generations — the post-launch Formats pack.
  let variants = {
    vertical: { format: "vertical", path: masterForVariants, dimensions: { w: 1080, h: 1920 } }
  };
  // v55: the clean master uploads alongside the marked deliverable (the
  // uploader names it clean.mp4 in the same job folder). Not referenced by
  // the job row — only the audit row carries it, and the library serves it
  // exclusively after purchase unlock.
  if (masterCleanPath) {
    variants.clean = { format: "clean", path: masterCleanPath, dimensions: { w: 1080, h: 1920 } };
  }
  // v35.1: square is OPT-IN (manifest.includeSquare from the webapp Formats
  // toggle). Default renders ship vertical-only and skip the ~2 min pass.
  try {
    if (manifest?.includeSquare !== true) throw { skipSquare: true };
    const squareDir = path.join(tempDir, "square");
    await fs.mkdir(squareDir, { recursive: true });
    const squareSilent = path.join(squareDir, `${jobId}-square-silent.mp4`);
    const squareThumb = path.join(squareDir, `${jobId}-square-thumb.png`);
    await stitchClipsAndOverlays(
      clipResults,
      // skipMusic: the square's audio comes from the narrated master below —
      // mixing the music bed here would just be discarded work.
      { ...manifest, skipMusic: true },
      squareSilent,
      squareThumb,
      {
        ...options,
        dimensionsOverride: { width: 1080, height: 1080 },
        onProgress: (info) =>
          options.onProgress?.({
            phase: "Building square format",
            progress: 86 + Math.max(0, Math.min(6, Math.floor((((info?.progress ?? 76) - 76) / 24) * 6)))
          })
      }
    );
    const squareFinal = path.join(squareDir, `${jobId}-square.mp4`);
    // v38: burn the square-geometry caption track (timelines are identical
    // by construction, only the canvas differs).
    const sqAss = narration?.captionsSquareAssPath;
    const sqArgs = sqAss
      ? ["-vf", `subtitles='${sqAss.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'")}':fontsdir='${CAPTIONS_FONTS_DIR.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'")}'`,
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "superfast", "-crf", "19", "-c:a", "copy"]
      : ["-c", "copy"];
    await runFFmpeg([
      "-y", "-threads", "1",
      "-i", squareSilent,
      "-i", masterForVariants,
      "-map", "0:v:0", "-map", "1:a:0?",
      ...sqArgs,
      "-shortest",
      squareFinal
    ], { timeoutMs: sqAss ? 240000 : 60000, label: "variants:square-mux" });
    // v55: square inherits clean clips now — trial renders re-apply the
    // mark here (the vertical unlock covers the master; square stays the
    // marked social cut on trial, a deliberate v1 simplification).
    let squareDeliverable = squareFinal;
    if (manifest.freeRenderWatermark) {
      try {
        const squareMarked = path.join(squareDir, `${jobId}-square-marked.mp4`);
        await runFFmpeg([
          "-y", "-threads", "1",
          "-i", squareFinal,
          "-vf", buildFreeRenderWatermark({ width: 1080, height: 1080 }),
          "-c:v", "libx264", "-pix_fmt", "yuv420p",
          "-preset", ENCODE_PRESET, "-crf", ENCODE_CRF_MASTER,
          "-c:a", "copy",
          squareMarked
        ], { timeoutMs: 180000, label: "v55:square-trial-mark" });
        squareDeliverable = squareMarked;
      } catch (err) {
        console.warn(`[v55] square trial-mark failed (${err.message}) — shipping square unmarked.`);
      }
    }
    variants.square = { format: "square", path: squareDeliverable, dimensions: { w: 1080, h: 1080 } };
    await fs.unlink(squareSilent).catch(() => {});
    console.info("[variants] TRUE 1:1 square composed from source clips (square-positioned branding, master audio muxed).");
  } catch (err) {
    if (err && err.skipSquare) {
      console.info("[variants] square not requested — shipping vertical only.");
    } else {
      console.warn(`[variants] square recomposition failed (${err.message}) — shipping vertical only.`);
    }
  }
  const shorts = [];

  options.onProgress?.({ phase: "Uploading deliverables", progress: 94 });
  // Per-file upload progress so the bar moves through 94 → 99 as each
  // file actually finishes uploading. Without this, the bar sits at ~99%
  // (soft-creep maxed out) for 30-90 seconds during multi-file Supabase
  // uploads — and the user reasonably interprets that as "stuck at 100%".
  const upload = await uploadRunwayAssets({
    manifest,
    jobId,
    variants,
    shorts,
    thumbnailPath,
    onProgress: (info) => {
      options.onProgress?.({
        phase: info.phase || `Uploading ${info.fileLabel || "deliverables"}`,
        progress: 94 + Math.floor((info.fraction || 0) * 5)
      });
    }
  });

  // Upload per-scene clips for regenerate-scene support. Each clip is
  // 2-5 MB; 24 of them = ~50-120 MB extra upload. Worth it because
  // single-scene regen is the production-grade fix. Each clip gets a
  // predictable URL inside the same Supabase folder as master/variants.
  const scenesMeta = await uploadPerSceneClips({
    manifest,
    jobId,
    normalizedClips,
    clipResults,
    pathPrefix: "runway"
  });

  // Cleanup per-scene local files now that they're uploaded.
  for (const clip of normalizedClips) {
    await fs.unlink(clip.clipPath).catch(() => {});
  }

  options.onProgress?.({ phase: "Ready to download", progress: 100 });

  // Audit log — TRULY fire-and-forget (no await). A slow Supabase REST
  // call here must never block the render from being marked complete.
  // The helper has its own try/catch so this can't throw on the floor.
  writeRenderAudit({
    manifest,
    jobId,
    // v26.9: record the engine actually used (was hardcoded "runway", which
    // mislabeled every Veo render in the library + audit log).
    // v60: the fal path can now run non-Veo models via FAL_VIDEO_MODEL —
    // derive the family from the model id actually used so certificate
    // provenance stays truthful (kling renders must not claim "veo").
    // v60.4: the scene-result field is `veoModel` (set at the generate call
    // site, line ~1491) — v60 read `.model`, which is undefined, so the
    // label said "veo" unconditionally and masked the engine identity all
    // night. Scan a few clips (floors lack the field).
    engine: isVeo
      ? ((clipResults || []).some((c) => String(c?.veoModel || c?.model || "").includes("kling")) ? "kling" : "veo")
      : "runway",
    upload,
    narration,
    scenes: scenesMeta
  }).catch(() => {});

  // Launch-audit fix: deliverables are in Supabase Storage — free this
  // job's temp dir (master, per-scene sources, variants; 100-500MB).
  // storageSkipped keeps files on disk because they're served locally as
  // the fallback; the stale sweeper reclaims those after 2h.
  if (!upload.storageSkipped) {
    fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    status: "complete",
    mock: false,
    engine: "runway",
    jobId,
    // Primary deliverable (vertical) — kept at top level for backward compat.
    mp4Url: upload.formats.vertical?.mp4Url || "",
    thumbnailUrl: upload.thumbnailUrl,
    storagePath: upload.formats.vertical?.storagePath,
    thumbnailPath: upload.thumbnailStoragePath,
    localMp4Path: upload.storageSkipped ? finalMp4 : "",
    localThumbnailPath: upload.storageSkipped ? thumbnailPath : "",
    storageSkipped: upload.storageSkipped,
    storageWarning: upload.storageWarning || "",
    formats: upload.formats,
    socialShorts: upload.socialShorts,
    narration: narration.narrationApplied
      ? { applied: true, voiceId: narration.voiceId, lineCount: narration.narrationLineCount }
      : { applied: false, reason: narration.reason },
    scenesGenerated: clipResults.length,
    sceneClips: clipResults.map((c) => ({
      photoId: c.photoId,
      durationSec: c.duration,
      runwayTaskId: c.runwayTaskId
    })),
    // v27 Edit Studio: surface the full per-scene metadata (durable clip URL,
    // photo URL, room, prompt, storage path) to the frontend so the Edit Studio
    // can list each scene and target a single one for re-render. Previously
    // this rich array only went to the audit log.
    scenes: scenesMeta
  };
}

/* =================================================================
   Per-scene Runway generation
   ================================================================= */

export async function generateClip(scene, manifest, tempDir, sceneIndex) {
  const photo = (manifest.orderedPhotos || []).find((p) => p.id === scene.photoId);
  const imageUrl = pickImageUrl(scene, photo);
  if (!imageUrl) throw new Error(`Scene ${sceneIndex + 1} (${scene.photoId}) missing durable image URL.`);
  const prompt = scene.runwayPrompt || scene.runway_prompt;
  if (!prompt) throw new Error(`Scene ${sceneIndex + 1} missing runwayPrompt. Regenerate edit plan with engine=runway.`);

  const config = manifest.runwayConfig || {};
  // Default Gen-4 Turbo for new renders. Better shape preservation, fewer
  // morphed surfaces. The ratio resolver picks the right pixel-pair based
  // on which model we're hitting (Gen-4 uses 1280:720, Gen-3 uses 1280:768).
  const model = config.model || process.env.RUNWAY_MODEL || "gen4_turbo";
  const ratio = ratioForRunway(config.ratio, model);
  const duration = clamp(Number(scene.duration || 5) > 5.5 ? 10 : 5, 5, 10);

  // Submit task — with 429 / 5xx resilience.
  // Runway's task-submit endpoint hits us with three failure modes worth
  // distinguishing:
  //   1. 429 "rate limit" — short-window throttle. Backoff + retry.
  //   2. 429 "daily task limit reached" — terminal until tomorrow or
  //      until the user upgrades. No point retrying. Surface a clear
  //      error so the frontend can prompt for an upgrade.
  //   3. 5xx — transient Runway side. Retry with backoff.
  const submitResponse = await submitRunwayTaskWithRetry({
    body: {
      model,
      promptImage: imageUrl,
      promptText: prompt,
      ratio,
      duration,
      watermark: false,
      ...(config.seed != null ? { seed: Number(config.seed) } : {})
    },
    sceneIndex,
    maxAttempts: 5
  });

  if (!submitResponse.ok) {
    const errBody = await safeText(submitResponse);
    const isDailyCap = /daily.*(task|limit|cap|quota)/i.test(errBody);
    const message = isDailyCap
      ? `Cinematic AI is at its daily render cap. Upgrade your Runway plan to Unlimited ($95/mo) to remove the cap, or wait until tomorrow.`
      : `Runway submit failed for scene ${sceneIndex + 1} (HTTP ${submitResponse.status}): ${errBody.slice(0, 240)}`;
    const error = new Error(message);
    error.code = isDailyCap ? "RUNWAY_DAILY_CAP" : "RUNWAY_SUBMIT_FAILED";
    error.httpStatus = submitResponse.status;
    throw error;
  }

  const submitData = await submitResponse.json();
  const taskId = submitData.id;
  if (!taskId) throw new Error(`Runway submit returned no task id for scene ${sceneIndex + 1}.`);

  // Poll until completion
  const outputUrl = await pollRunwayTask(taskId, sceneIndex);

  // Download clip
  const clipPath = path.join(tempDir, `clip-${String(sceneIndex).padStart(3, "0")}.mp4`);
  await downloadFile(outputUrl, clipPath);

  return {
    sceneIndex,
    photoId: scene.photoId,
    clipPath,
    duration,
    transition: scene.transition || "crossfade",
    overlay: scene.overlay || null,
    runwayTaskId: taskId
  };
}

/* =================================================================
   v26.3 — Veo 3.1 Fast per-scene clip (Phase 2 production path)
   ================================================================= */

// Room types whose constrained prompt needs special handling beyond the
// generic locked-tripod language. Pools get a water-shimmer allowance
// (a fully frozen pool looks like a photo, defeating the point).
// v27 hallucination fix: the opening used to read "Locked tripod shot" — Veo
// 3.1 rendered the word "tripod" as a literal object (a tripod, and an operator
// to use it) into the room. Describe the camera STATE only, never equipment.
const CONSTRAINED_PROMPTS = {
  generic:
    "Completely static, locked-off camera. Extremely slow forward push of about 4% only, " +
    "with no other movement and no drift. " +
    "Preserve every surface, fixture, appliance, label, and object exactly as photographed. " +
    "Nothing in the scene moves.",
  // v40 (Troy, master-20): kitchens get one REAL-motion attempt before the
  // static treatment — "I would like to at least try rendering them since we
  // have the countermeasures in place." Super conservative camera, kitchen-
  // specific rigidity locks; QC still gates, and retries drop to the static
  // generic prompt (see buildConstrainedVeoPrompt strict flag).
  kitchen:
    "The camera glides slowly and smoothly straight forward, ending about 8% closer, " +
    "with gentle easing — no panning, no tilting, no drift, no shake. " +
    "The kitchen stays exactly as photographed: every appliance keeps its exact shape, " +
    "size, door count, handles, controls, and finish; countertop and backsplash patterns " +
    "stay identical; cabinet fronts stay rigid with the same hardware; nothing reflective " +
    "changes; no new objects appear. Nothing in the scene moves — only the camera.",
  // v46 (m50, launch day): CONSTRAINED_PROMPTS.pullOut DELETED. The v41
  // "conservative reveal with edge ownership" still invented a sidewalk and
  // brick street on m50 scene 1 — edge-ownership prose can't beat the fact
  // that the photo has no data at the reveal edge. No prompt in this table
  // may move the camera backward.
  pool:
    "Completely static, locked-off camera. Extremely slow forward push of about 4% only, " +
    "with no other movement and no drift. " +
    "Water surface may shimmer gently, but pool shape, tile, coping, deck, and all " +
    "surroundings stay exactly as photographed. Nothing else moves.",
  exterior:
    "Completely static, locked-off camera. Extremely slow forward push of about 4% only, " +
    "with no other movement and no drift. " +
    "Trees, foliage, leaves, and branches stay completely still and hold their exact shape — " +
    "no swaying, morphing, rippling, or regenerating. The structure, roofline, windows, and " +
    "all hardscape stay exactly as photographed."
};

function buildConstrainedVeoPrompt(scene, { strict = false } = {}) {
  const room = String(scene.roomType || "").toLowerCase();
  if (/pool|spa/.test(room)) return CONSTRAINED_PROMPTS.pool;
  if (/exterior|backyard|outdoor|front|yard|patio/.test(room)) return CONSTRAINED_PROMPTS.exterior;
  // Kitchens: gentle real motion on the first (guard-routed) attempt;
  // QC-fail retries pass strict=true and fall to the static generic.
  if (!strict && /kitchen/.test(room)) return CONSTRAINED_PROMPTS.kitchen;
  return CONSTRAINED_PROMPTS.generic;
}

// MLS-compliance suffix appended to EVERY Veo prompt, cinematic or
// constrained. Listing videos legally must not misrepresent the property —
// this is the per-scene guardrail, independent of the edit plan.
const VEO_FIDELITY_SUFFIX =
  " Photorealistic. Do not add, remove, or alter any object, surface, fixture, or " +
  "architectural feature. No people, no animals. Absolutely NO text, captions, words, " +
  "letters, numbers, signage, watermarks, on-screen UI, or graphic overlays of any kind " +
  "anywhere in the frame. Every piece of furniture and every object is bolted in place " +
  "in world space: nothing slides, drifts, follows, or travels with the camera — only " +
  "the camera moves, with correct perspective parallax, through a completely static " +
  "scene. The view through every window and glass door stays exactly as photographed: " +
  "no new buildings, structures, vehicles, or landscape elements may appear, sharpen, " +
  "or resolve behind glass — blurred or bright window views stay blurred or bright. " +
  "The scene must remain exactly as photographed apart from the camera motion " +
  "described.";

// Per-scene Veo generation, mapped to the same clipResults shape that
// generateClip / generateKenBurnsFallback return so the stitch pipeline
// downstream is untouched.
export async function generateVeoSceneClip(scene, manifest, tempDir, sceneIndex, { constrained = false, strictConstrained = false } = {}) {
  const photo = (manifest.orderedPhotos || []).find((p) => p.id === scene.photoId);
  const imageUrl = pickImageUrl(scene, photo);
  if (!imageUrl) throw new Error(`Scene ${sceneIndex + 1} (${scene.photoId}) missing durable image URL.`);

  // Prompt priority: explicit veoPrompt from a v26 edit plan → legacy
  // runwayPrompt (older plans; plain text, works on Veo) → constrained.
  // v61.2 (Troy: "Make the 2nd prompt more constrained but not as far as
  // the veo one was. The 3rd a harsher constrain... great drone footage,
  // avoid ken burns fallbacks"): on Kling, retries KEEP the planned scene
  // description — the Veo constrained templates encode near-static language
  // ("about 6% total travel") that Kling obeys literally, which made rung 2
  // as dead as the slideshow bug. The ladder now de-escalates through the
  // MOTION SUFFIX alone (bold drone glide -> steady push -> minimal push,
  // see veo-job KLING_MOTION_*), so every rung stays a real moving shot
  // and the floor is reserved for true failures. Veo keeps its templates.
  const klingLadder = String(process.env.FAL_VIDEO_MODEL || "").toLowerCase().includes("kling");
  const plannedPrompt = scene.veoPrompt || scene.veo_prompt || scene.runwayPrompt || scene.runway_prompt || buildConstrainedVeoPrompt(scene);
  const basePrompt = constrained && !klingLadder
    ? buildConstrainedVeoPrompt(scene, { strict: strictConstrained })
    : plannedPrompt;
  // v28: exteriors are where Veo morphs worst — it "animates" foliage under any
  // camera move (leaves rippling, branches growing/regenerating). For outdoor
  // scenes, append an explicit foliage lock + minimal-motion bias on top of the
  // universal fidelity suffix. Applies to ALL four modes.
  const roomStr = String(scene.roomType || "").toLowerCase();
  const isExteriorScene = /exterior|backyard|outdoor|front|yard|patio|pool|garden|landscap|deck/.test(roomStr);
  // v34.9 (test-15): the v28 lock stopped IN-FRAME foliage morphing, but Veo
  // treats the frame EDGE as a creative writing prompt — camera moves on
  // exteriors invented whole bushes/trees sliding into the corners ("revealed"
  // content). The lock now explicitly owns the reveal: new edge area must be
  // plain hardscape/sky, never new vegetation.
  const foliageLock = isExteriorScene
    ? " Trees, plants, hedges, leaves, and branches must hold their exact shape, count, and position — foliage must NOT morph, ripple, shimmer, multiply, grow, or regenerate. NOTHING NEW ENTERS THE FRAME: as the camera moves, any newly revealed area at the frame edges contains only plain pavement, ground, wall, or sky consistent with the photo — never new plants, bushes, trees, rocks, or furniture sliding into view. The plant count in the final frame equals the plant count in the photo. Keep camera movement minimal and shallow so foliage stays perfectly stable."
    : "";
  // v42.3 (m28: Veo invented a whole ENTRYWAY with wooden doors and warped
  // the sectional): the interior twin of the v34.9 exterior edge lock.
  // Troy's rule, encoded: when the model must fill space the photo doesn't
  // show, it must default to BORING — plain wall continuation — never
  // structure. An invented blank wall is survivable; an invented doorway
  // misrepresents the floor plan.
  const interiorLock = !isExteriorScene
    ? " STRUCTURAL LOCK: the room's architecture is fixed exactly as photographed — the number of doorways, doors, archways, openings, hallways, windows, and stairs in every frame equals the number in the photo. As the camera moves, any newly visible area at the frame edges continues the existing plain walls, floor, and ceiling — where the photo gives no information, show plain undecorated wall, NEVER a new doorway, opening, room, or piece of furniture. Large furniture keeps its exact shape and size: sofas and sectionals must not stretch, extend, bend, or grow new cushions."
    : "";
  const prompt = basePrompt + foliageLock + interiorLock + VEO_FIDELITY_SUFFIX;

  const config = manifest.runwayConfig || {};
  const ratio = config.ratio === "16:9" || config.ratio === "wide" ? "16:9" : "9:16";
  // v31 COGS pivot: generate at 720p in the smallest 4s/6s/8s bucket that
  // covers the scene, then upscale in the normalize pass (lanczos scale to the
  // 1080x1920 master + tuned grade). Rationale: the product ships to phone
  // screens where upscaled 720p is indistinguishable from native 1080p; native
  // 1080p forced a full 8s generation per scene ($1.20) regardless of shown
  // length. A 3.5s scene now costs $0.60 (4s @ $0.15/sec) instead of $1.20 —
  // this is what makes 8-10 scenes per 30s video affordable. The earlier
  // "resolution looks poor" complaint was over-sharpening on the OLD upscale
  // grade, not 720p itself — see COLOR_GRADE notes.
  // Rollback: set FAL_RESOLUTION=1080p on the worker → forces 8s buckets
  // (fal only emits 1080p at 8s), restoring v28 behavior without a deploy.
  //
  // v30 beat-sync: HONOR the plan's beat-snapped scene.duration. The old
  // `> 6.5 ? 8 : 6` quantization pinned every scene to 6/8s and DISCARDED the
  // snap — which is exactly why beat-timed transitions weren't visible. Now the
  // trim length = the beat-aligned duration create-edit-plan computed.
  //
  // Crossfade compensation: when xfade is on, stitch.mjs eats `f`=0.5s of
  // overlap per transition (offset += prevDur - f), which drags every cut
  // earlier and off the beat. We add that 0.5s back per clip so the snapped
  // boundaries survive the crossfade and still land on the grid. Hard-cut
  // renders (useCrossfades:false) need no compensation.
  const XFADE_COMP_SEC = 0.5;
  const useXfade = manifest?.runwayConfig?.useCrossfades !== false;
  const snappedDur = Number(scene.duration) > 0 ? Number(scene.duration) : 6;
  const targetDuration = clamp(useXfade ? snappedDur + XFADE_COMP_SEC : snappedDur, 1.6, 8);
  const resolution = process.env.FAL_RESOLUTION || "720p";
  // Smallest fal duration bucket that covers what we'll actually keep.
  // 1080p only exists at 8s on fal — pin the bucket there on rollback.
  const bucketSec = resolution === "1080p" ? 8
    : targetDuration <= 4 ? 4
    : targetDuration <= 6 ? 6
    : 8;

  const { generateVeoClip } = await import("./veo-job.mjs");
  // v45.14 ("freeze at 15%" — third strike): a hard wall-clock ceiling on the
  // ENTIRE generate+download primitive. The inner guards (6-min subscribe,
  // 2-min download) each cover one await, but the 03:25 MLS job proved a
  // path can still hang without tripping any of them. A hung attempt now
  // BECOMES a thrown error after 8.5 min → the caller's existing
  // retry-once-then-floor ladder handles it with visible log lines. The
  // orphaned background attempt is abandoned; its temp file is never read.
  const ATTEMPT_DEADLINE_MS = Number(process.env.VEO_ATTEMPT_DEADLINE_MS) || 510000;
  let attemptDeadline;
  const result = await Promise.race([
    generateVeoClip({
      imageUrl,
      prompt,
      aspectRatio: ratio,
      duration: `${bucketSec}s`,
      resolution,
      sceneIndex,
      photoId: scene.photoId,
      tempDir,
      // v61: attempt 1 runs the lively bold camera language; constrained
      // retries (the ladder's 2nd attempt) drop to the steady suffix so
      // de-escalation is real. Troy: "the first one can be more lively."
      motionStyle: strictConstrained ? "strict" : constrained ? "steady" : "bold"
    }),
    new Promise((_, reject) => {
      attemptDeadline = setTimeout(() => {
        const e = new Error(`scene ${sceneIndex + 1} generation exceeded ${Math.round(ATTEMPT_DEADLINE_MS / 1000)}s hard deadline`);
        e.code = "ATTEMPT_DEADLINE";
        reject(e);
      }, ATTEMPT_DEADLINE_MS);
    })
  ]).finally(() => clearTimeout(attemptDeadline));

  return {
    sceneIndex,
    photoId: scene.photoId,
    clipPath: result.clipPath,
    duration: targetDuration,
    transition: scene.transition || "crossfade",
    overlay: scene.overlay || null,
    runwayTaskId: null,
    veoRequestId: result.requestId || "",
    veoModel: result.model || "",
    constrained
  };
}

// Per-scene safety net: when Runway fails, generate a Ken-Burns–style
// 5-second clip from the same photo using ffmpeg's zoompan filter. The
// motion direction is selected from the original scene's cameraMotion so
// the visual intent matches what the AI was supposed to do. Visually less
// dramatic than Runway image-to-video but indistinguishable to a casual
// viewer, and crucially, the render completes.
export async function generateKenBurnsFallback(scene, manifest, tempDir, sceneIndex, options = {}) {
  const photo = (manifest.orderedPhotos || []).find((p) => p.id === scene.photoId);
  const imageUrl = pickImageUrl(scene, photo);
  if (!imageUrl) throw new Error(`Fallback impossible — scene ${sceneIndex + 1} has no image URL.`);

  const config = manifest.runwayConfig || {};
  const ratio = config.ratio || "9:16";
  const dimensions = ratio === "16:9" || ratio === "wide" ? { width: 1920, height: 1080 }
                  : ratio === "1:1" || ratio === "square" ? { width: 1080, height: 1080 }
                  : { width: 1080, height: 1920 };
  // v33.4: durationSec override — the QC floor needs the motion arc designed
  // for the scene's EXACT beat-snapped length. The legacy 5/10s quantization
  // (Quick Reel era) meant floors got trimmed mid-arc: slow half-finished
  // zooms that read as broken next to real camera motion.
  const duration = Number(options.durationSec) > 0
    ? clamp(Number(options.durationSec), 1.6, 10)
    : clamp(Number(scene.duration || 5) > 5.5 ? 10 : 5, 5, 10);
  const totalFrames = Math.round(duration * 30);

  // v36: never hand ffmpeg a raw URL (the SVG-headshot lesson) — download,
  // magic-byte-validate, and re-sign through the same hardened path every
  // other image consumer uses.
  const localPhoto = path.join(tempDir, `floor-src-${String(sceneIndex).padStart(3, "0")}.img`);
  await downloadImageValidated(imageUrl, localPhoto, `photo-motion floor scene ${sceneIndex + 1}`);

  const clipPath = path.join(tempDir, `fallback-${String(sceneIndex).padStart(3, "0")}.mp4`);
  const motion = String(scene.cameraMotion || "push_in").toLowerCase();

  // v39 PRIMARY FLOOR: homography drift (see homography-drift.mjs). The
  // deterministic terminal rung — camera rotation + gentle dolly composed
  // as a single 3×3 homography, so straight architecture stays straight BY
  // CONSTRUCTION (grid-proven ≤0.5px vs v37's ~10px snaking) and every
  // pixel provably comes from the customer's photo. No depth model, no
  // downloads, ~4s of CPU, $0. This rung's contract is "cannot be wrong":
  // after Veo has hallucinated on a photo three times, we ship honest
  // geometry, not a fourth lottery ticket. Falls through to the v36
  // supersampled zoompan only if onnxruntime itself is unavailable.
  try {
    await renderHomographyDrift({
      photoPath: localPhoto,
      outPath: clipPath,
      durationSec: duration,
      width: 720,
      height: 1280,
      roomType: scene.roomType,
      sceneIndex,
      cameraMotion: motion
    });
    console.info(`[floor] scene ${sceneIndex + 1}: HOMOGRAPHY-DRIFT floor rendered (${duration}s).`);
    return {
      sceneIndex,
      photoId: scene.photoId,
      clipPath,
      duration,
      transition: scene.transition || "crossfade",
      overlay: scene.overlay || null,
      runwayTaskId: null,
      fallback: true,
      floorEngine: "homography-drift"
    };
  } catch (hgErr) {
    console.warn(`[floor] scene ${sceneIndex + 1}: homography-drift unavailable (${hgErr.message}) — v36 zoompan floor.`);
  }

  // v36 fallback: room-aware supersampled eased zoompan.
  const zoompanExpr = buildZoompanExpr(motion, totalFrames, dimensions, {
    roomType: scene.roomType,
    sceneIndex
  });
  await runFFmpeg([
    "-y",
    "-threads", "1",
    "-loop", "1",
    "-i", localPhoto,
    "-t", String(duration),
    "-vf", zoompanExpr,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-preset", ENCODE_PRESET,
    "-crf", ENCODE_CRF_MASTER,
    "-x264-params", X264_PARAMS,
    "-bufsize", BUFSIZE,
    "-r", "30",
    clipPath
  ], { timeoutMs: 120000, label: `runway:fallback-scene-${sceneIndex + 1}` });

  return {
    sceneIndex,
    photoId: scene.photoId,
    clipPath,
    duration,
    transition: scene.transition || "crossfade",
    overlay: scene.overlay || null,
    runwayTaskId: null,
    fallback: true
  };
}

function buildZoompanExpr(motion, totalFrames, dim, opts = {}) {
  // v24.2 cinematic upgrade for Ken Burns scenes.
  //
  // What changed vs the linear version:
  //   1. SMOOTHSTEP EASING. Old version used linear `1.0+0.0008*on` —
  //      mechanical look (motion starts/stops abruptly). New version
  //      uses `s*s*(3-2*s)` where s=on/N — slow start, full speed in
  //      the middle, slow end. Standard cinematography easing curve.
  //   2. BIGGER ZOOM RANGE. Max zoom bumped 1.12 → 1.20. More
  //      perceptible motion without exposing edges (1.5× pre-scale
  //      gives the headroom).
  //   3. COMBINED ZOOM+PAN. Every motion type now drifts framing
  //      slightly alongside the zoom — that's what makes real
  //      cinematography feel like motion-through-space instead of
  //      just zoom-in-place.
  //   4. PRE-SCALE 1.3× → 1.5×. Better Lanczos resampling, sharper
  //      output. Per-frame buffer goes from ~14 MB to ~19 MB —
  //      comfortable on Pro 4 GB.
  // v36 PREMIUM PHOTO MOTION (the QC ladder's terminal — Troy: "what if
  // our fallback was as good as Reel-E's actual product"). Three upgrades
  // over v24.2:
  //   1. SUPERSAMPLED RENDER. zoompan quantizes x/y to INPUT pixels — at
  //      1.5× pre-scale that's visible micro-stutter, the #1 thing that
  //      reads "slideshow". Now: pre-scale 2.5×, run zoompan AT the
  //      supersampled size, lanczos-downscale to target. Each output
  //      pixel-step becomes 0.4 output pixels → glassy-smooth motion.
  //   2. ROOM-AWARE FRAMING (from the v35.2 square-crop findings):
  //      exteriors bias the frame center DOWN (the house lives low, sky
  //      high); interiors bias UP (hold the ceiling line). The motion
  //      travels through the part of the photo that matters.
  //   3. DIRECTION PARITY. Lateral motions alternate direction by scene
  //      index so consecutive floor scenes never pan the same way.
  const { roomType = "", sceneIndex = 0 } = opts;
  const fps = 30;
  const SS = 2.5;
  const SS_W = 2 * Math.round((dim.width * SS) / 2);
  const SS_H = 2 * Math.round((dim.height * SS) / 2);
  const PRE = `scale=${SS_W}:${SS_H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${SS_W}:${SS_H}`;
  const POST = `scale=${dim.width}:${dim.height}:flags=lanczos`;
  const sOut = `${SS_W}x${SS_H}`;

  // Smoothstep easing: t = on/N, ease = t*t*(3-2*t)
  const N = totalFrames;
  const t = `(on/${N})`;
  const smoothT = `(${t}*${t}*(3-2*${t}))`;

  // Room-aware vertical center (fraction of ih): exteriors hold the lower
  // frame, interiors hold the ceiling line, details stay centered.
  const room = String(roomType || "").toLowerCase();
  const yBias = /exterior|outdoor|backyard|front|yard|patio|pool|garden|deck/.test(room)
    ? 0.56
    : room === "detail" || room === "amenity"
    ? 0.5
    : 0.45;
  const dir = sceneIndex % 2 === 0 ? 1 : -1; // alternate lateral direction

  const cx = `iw/2-(iw/zoom/2)`;
  const cyB = `ih*${yBias}-(ih/zoom/2)`;
  const wrap = (zoom, x, y) =>
    `${PRE},zoompan=z='${zoom}':d=${N}:s=${sOut}:fps=${fps}:x='${x}':y='${y}',${POST}`;

  if (motion === "pull_out") {
    // v46: pull-out RETIRED everywhere (m50 — "the camera should not be
    // panning out"). Legacy plans / audit-row regens may still carry the
    // motion tag; render it as the push-in ramp instead.
    return wrap(`1.0+0.18*${smoothT}`, cx, `${cyB}+ih*0.01*${smoothT}`);
  }
  if (motion === "lateral_pan") {
    // Gimbal-track sweep, ±9% of width, direction alternates per scene.
    const xPan = `iw/2-(iw/zoom/2)+(${dir})*(iw*0.09)*(${smoothT}*2-1)`;
    return wrap(`1.10`, xPan, cyB);
  }
  if (motion === "vertical_reveal") {
    // Tilt-up reveal toward the biased center.
    return wrap(`1.10`, cx, `ih*0.62-(ih*(0.62-${yBias}))*${smoothT}-(ih/zoom/2)`);
  }
  if (motion === "parallax_zoom") {
    // Zoom 1.0 → 1.18 with eased diagonal drift (strongest faux-parallax).
    const xDrift = `iw/2-(iw/zoom/2)+(${dir})*iw*0.012*${smoothT}`;
    return wrap(`1.0+0.18*${smoothT}`, xDrift, `${cyB}-ih*0.008*${smoothT}`);
  }
  if (motion === "detail_sweep") {
    const xSweep = `iw/2-(iw/zoom/2)+(${dir})*(iw*0.07)*(${smoothT}*2-1)`;
    return wrap(`1.15`, xSweep, cyB);
  }
  // Default push_in: 1.0 → 1.18 dolly-in toward the room-biased center.
  return wrap(`1.0+0.18*${smoothT}`, cx, `${cyB}+ih*0.012*${smoothT}`);
}

async function pollRunwayTask(taskId, sceneIndex) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    const pollResponse = await fetch(`${RUNWAY_API_BASE}/tasks/${encodeURIComponent(taskId)}`, {
      headers: runwayHeaders()
    });
    if (!pollResponse.ok) {
      const errText = await safeText(pollResponse);
      // 404 right after submit can happen for ~1s; retry a few times before giving up.
      if (pollResponse.status === 404) continue;
      throw new Error(`Runway poll failed for scene ${sceneIndex + 1}: HTTP ${pollResponse.status} ${errText.slice(0, 200)}`);
    }
    const data = await pollResponse.json();
    const status = String(data.status || "").toUpperCase();
    if (status === "SUCCEEDED") {
      const output = Array.isArray(data.output) ? data.output[0] : data.output;
      if (!output) throw new Error(`Runway task ${taskId} succeeded but returned no output URL.`);
      return output;
    }
    if (status === "FAILED" || status === "CANCELLED") {
      const reason = data.failure || data.failureCode || "unknown";
      throw new Error(`Runway task ${taskId} ${status}: ${reason}`);
    }
    // Still PENDING / RUNNING / THROTTLED — keep polling.
  }
  throw new Error(`Runway task ${taskId} timed out after ${POLL_TIMEOUT_MS / 1000}s.`);
}

/* =================================================================
   FFmpeg stitching
   ================================================================= */

export async function stitchClipsAndOverlays(clipResults, manifest, outputPath, thumbnailPath, options = {}) {
  clipResults.sort((a, b) => a.sceneIndex - b.sceneIndex);
  const tempDir = path.dirname(outputPath);
  // v35: dimensionsOverride lets the SAME pipeline compose a second aspect
  // (square) from the source clips — watermark, corner headshot, outro card,
  // and scale/crop are all already parameterized by `dimensions`.
  const dimensions = options.dimensionsOverride || runwayDimensions(manifest);
  const brand = normalizeBrandKitForFFmpeg(manifest.brandKit || {});

  // Step 1: normalize each clip to a uniform codec / framerate / resolution,
  // bake in the persistent brand watermark + color grade + corner headshot.
  //
  // v20 OOM fix: corner headshot is baked HERE per-clip instead of in a
  // separate post-stitch pass. The post-stitch approach (v19) ran a single
  // big ffmpeg overlay over ~120s of stitched video — peak memory was
  // ~250MB just for that step on top of the existing pipeline, which
  // tipped Render Standard's 2GB ceiling. Per-clip overlay is ~50MB peak
  // and runs serially, never accumulating.
  const watermarkFilter = buildWatermarkDrawtext(brand, dimensions);
  // v46 (Troy): free/trial renders carry a persistent vistalia.ai mark.
  // v55: the mark MOVED OUT of this per-clip chain to a single final pass
  // over the finished master (see the dual-master block in the main flow).
  // Why it was per-clip: v46-era Render Standard had 2GB and a full-master
  // overlay peaked ~250MB. We run Pro Plus (8GB) now, and the final-pass
  // architecture is what makes the $39 instant-unlock possible: the master
  // renders CLEAN once, the marked deliverable is one cheap extra encode,
  // and purchase flips a URL instead of re-rendering.
  // v50: resolve the finishing recipe ONCE per stitch. With FINISH_PASS=0
  // every value below collapses to the pre-v50 constants and the per-clip
  // chain is byte-identical to v49.
  const finishStyle = resolveFinishStyle(manifest);
  const filterCaps = await ffFilterSet();
  const colorGrade = FINISH_GRADE ? buildStyleGrade(finishStyle, filterCaps) : COLOR_GRADE;
  const film = buildFilmFinish(finishStyle, filterCaps, dimensions);
  const deflickerFilter = FINISH_DEFLICKER && filterCaps.has("deflicker") ? "deflicker=mode=pm:size=5" : "";
  let toneMatchMap = new Map();
  let sceneTones = new Map();
  if (FINISH_MATCH) {
    try {
      sceneTones = await probeSceneTones(clipResults);
      toneMatchMap = buildSceneMatchCorrections(sceneTones);
      if (toneMatchMap.size > 0) {
        console.info(`[finish] tone-leveling ${toneMatchMap.size}/${clipResults.length} scenes toward the render median (style=${finishStyle}).`);
      }
    } catch { toneMatchMap = new Map(); sceneTones = new Map(); }
  }
  // v50.6 BLUE-HOUR PROTECTION (Michelle, m58: "odd purple cast on the
  // opening photo"): the luxury grade warms shadows (+red), and red poured
  // into a blue-hour photo reads MAGENTA — lavender stucco, violet gravel.
  // Chroma tells the two worlds apart cleanly (measured: dusk U−V ≈ +32,
  // warm interiors ≈ −13 to −31). Scenes with U−V > 8 keep their natural
  // blue hour: neutral contrast + sharpen, no warm colorbalance, no curve
  // lift. Never applied to MLS (its legacy grade is untouched by v50) and
  // never without probe data (fail-open to the style grade).
  const blueHourGrade = FINISH_GRADE ? buildBlueHourGrade(filterCaps) : COLOR_GRADE;
  // v50.7: customer-facing toggle — manifest.finishOptions.blueHourCorrection
  // (default ON; webapp exposes it as "Twilight correction"). Env kill
  // FINISH_BLUEHOUR=0 remains for ops.
  const blueHourUserEnabled = manifest?.finishOptions?.blueHourCorrection !== false;
  const blueHourEligible =
    FINISH_GRADE &&
    finishStyle !== "mls" &&
    blueHourUserEnabled &&
    process.env.FINISH_BLUEHOUR !== "0";
  const isBlueHourScene = (sceneIndex) => {
    if (!blueHourEligible) return false;
    const t = sceneTones.get(sceneIndex);
    return Boolean(t && (t.u - t.v) > 8);
  };
  // Pre-render the small corner headshot ONCE. Reused as a 2nd input on
  // every normalize call below. Falls back to null if the user has no
  // headshot URL or the pre-render fails — in that case we use -vf and
  // skip the overlay entirely.
  const cornerHeadshotSize = Math.round(dimensions.width * 0.12);
  const cornerHeadshotPath = brand.headshotUrl
    ? await buildHeadshotCircle(brand.headshotUrl, cornerHeadshotSize, tempDir).catch(() => null)
    : null;
  const cornerOverlayX = dimensions.width - cornerHeadshotSize - 24;
  const cornerOverlayY = 24;

  const normalizedClips = [];
  // v60.5 slideshow guard: motion energy per raw engine clip, measured and
  // logged. The first Kling canary shipped near-still clips and PASSED every
  // gate — QC and the sweep score fidelity, and stillness is maximally
  // faithful. Motion is now a first-class, numbered log line per render.
  const motionStats = [];
  // Per-clip granular progress so the bar visibly moves through this step
  // instead of sitting at 76%. We split the 76→80 range across the clips.
  const NORMALIZE_PROGRESS_START = 76;
  const NORMALIZE_PROGRESS_RANGE = 4;
  for (let i = 0; i < clipResults.length; i++) {
    const clip = clipResults[i];
    // Measure the RAW engine output (pre-grade, pre-title-card) so the
    // number reflects what the model generated, not our filters. Fail-open.
    try {
      const ydif = await measureClipMotion(clip.clipPath);
      if (Number.isFinite(ydif)) motionStats.push({ scene: clip.sceneIndex + 1, ydif, engine: clip.engineUsed || "" });
    } catch { /* motion telemetry must never block a render */ }
    // v60.9 KLING GIMBAL PASS (Troy: "the camera bounces as if someone is
    // walking with it"). Kling ships a handheld tremor — a sawtooth ripple
    // in slit-scans of every canary scene. The worker's libvidstab removes
    // it cleanly (verified on canary-35d8305c scene-003; the sandbox build
    // has a broken trf serializer, this one does not). Two passes on the
    // RAW clip before the normalize chain; optzoom's small adaptive zoom
    // hides compensation borders and the 9:16 cover-crop swallows the
    // rest. smoothing=35 kills walk-frequency wobble but passes the slow
    // intentional dolly. Floors/regen clips skip; KLING_STABILIZE=0 kills;
    // any failure ships the unstabilized clip (fail-open).
    const klingClip = String(process.env.FAL_VIDEO_MODEL || "").toLowerCase().includes("kling");
    // v61.4: the post-sweep re-stitch runs this loop AGAIN on clips whose
    // clipPath was already swapped to the stabilized file — ffmpeg then
    // refuses input==output ("cannot edit in-place") and logs 9 scary-but-
    // harmless errors per re-stitch. Already-stabilized clips skip.
    const alreadyStabilized = /\bstab-\d{3}\.mp4$/.test(String(clip.clipPath || ""));
    if (klingClip && !alreadyStabilized && !clip.fallback && !clip.usedPhotoMotionFloor && !clip.preNormalized && String(process.env.KLING_STABILIZE || "1") !== "0") {
      const trfPath = path.join(tempDir, `stab-${String(clip.sceneIndex).padStart(3, "0")}.trf`);
      const stabPath = path.join(tempDir, `stab-${String(clip.sceneIndex).padStart(3, "0")}.mp4`);
      try {
        await runFFmpeg(
          ["-y", "-threads", "1", "-i", clip.clipPath, "-vf", `vidstabdetect=shakiness=8:accuracy=15:result=${trfPath}`, "-f", "null", "-"],
          { timeoutMs: 120000, label: `stab:detect-${clip.sceneIndex}` }
        );
        await runFFmpeg(
          ["-y", "-threads", "1", "-i", clip.clipPath, "-vf", `vidstabtransform=input=${trfPath}:smoothing=35:optzoom=1:interpol=bicubic`, "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-an", stabPath],
          { timeoutMs: 180000, label: `stab:transform-${clip.sceneIndex}` }
        );
        const st = await fs.stat(stabPath);
        if (st.size > 50000) {
          clip.clipPath = stabPath;
          console.log(`[stab] scene ${clip.sceneIndex + 1}: gimbal pass applied (vidstab smoothing=35).`);
        }
      } catch (stabErr) {
        console.warn(`[stab] scene ${clip.sceneIndex + 1} stabilization failed (${stabErr.message}) — shipping unstabilized.`);
      } finally {
        await fs.unlink(trfPath).catch(() => {});
      }
    }
    const normalized = path.join(tempDir, `norm-${String(clip.sceneIndex).padStart(3, "0")}.mp4`);
    // v28: trim the 8s native-1080p Veo clip back to its intended length here —
    // free, since this normalize pass already re-encodes. Guarded so a missing
    // duration can never produce an empty (-t 0) clip.
    const trimArgs = Number(clip.duration) > 0 ? ["-t", String(clip.duration)] : [];
    // v48: address chip rides ONLY the opening scene (clipResults is sorted,
    // so i===0 is the tour's first clip even if the original scene 1 was
    // dropped). Empty string = filter chain identical to v47.
    // v50: upgraded to the serif title reveal; falls back to the v48 chip
    // (FINISH_TITLE=0) or "" — both preserve the fail-open contract.
    const addressIntroFilter = i === 0 ? buildTitleIntro(manifest, dimensions, clip.duration, finishStyle) : "";
    // v50: regen-path clips arrive preNormalized — already graded, sharpened
    // and watermarked on their first render. They skip conditioning/grade/
    // film so nothing compounds (pre-v50, regen re-applied the full grade).
    const isPre = Boolean(clip.preNormalized);
    const matchEqFilter = !isPre ? (toneMatchMap.get(clip.sceneIndex) || "") : "";
    // v50.6: cool/blue-hour scenes swap the warm style grade for the
    // neutral blue-hour grade — red-into-blue makes purple.
    const clipGrade = !isPre && isBlueHourScene(clip.sceneIndex) ? blueHourGrade : colorGrade;
    if (!isPre && clipGrade === blueHourGrade && blueHourGrade !== colorGrade) {
      const t = sceneTones.get(clip.sceneIndex);
      console.info(`[finish] scene ${clip.sceneIndex + 1}: blue-hour protected (U−V=+${(t.u - t.v).toFixed(0)}) — neutral grade, natural dusk kept.`);
    }
    const preHalation = [
      `fps=30`,
      // v50: deflicker BEFORE denoise — temporal luma pulse is easiest to
      // remove at native resolution, and hqdn3d then has less to chase.
      ...(!isPre && deflickerFilter ? [deflickerFilter] : []),
      // v31: denoise at the clip's NATIVE resolution (720p for Veo) before the
      // lanczos upscale to master size — see PRE_SCALE_DENOISE notes up top.
      ...(!isPre ? [PRE_SCALE_DENOISE] : []),
      `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=increase:flags=lanczos`,
      // v35.2 (test-17): square crop bias is PER-ROOM — a uniform upward
      // bias beheaded exteriors, because vertical listing photos put sky
      // in the top third; the house lives LOW in frame. Exterior/outdoor
      // scenes favor the lower frame (58% from top), interiors keep the
      // ceiling line (40%), details stay centered. Non-square targets
      // keep the centered crop.
      dimensions.width === dimensions.height
        ? (() => {
            const room = String(
              (manifest.scenes || []).find((s) => s.photoId === clip.photoId)?.roomType || ""
            ).toLowerCase();
            const bias = /exterior|outdoor|backyard|front|yard|patio|pool|garden|deck/.test(room)
              ? 0.58
              : room === "detail" || room === "amenity"
              ? 0.5
              : 0.4;
            return `crop=${dimensions.width}:${dimensions.height}:(in_w-${dimensions.width})/2:(in_h-${dimensions.height})*${bias}`;
          })()
        : `crop=${dimensions.width}:${dimensions.height}`,
      ...(!isPre ? [clipGrade] : []),
      ...(matchEqFilter ? [matchEqFilter] : []),
      ...(!isPre && film.vignette ? [film.vignette] : [])
    ].join(",");
    // Grain sits ON TOP of the halation bloom; text overlays draw after
    // grain so typography stays crisp.
    const postHalation = [
      ...(!isPre && film.grain ? [film.grain] : []),
      ...(watermarkFilter ? [watermarkFilter] : []),
      // v55: freeRenderWatermark no longer applied here — see the
      // dual-master final pass in the main flow.
      ...(addressIntroFilter ? [addressIntroFilter] : [])
    ].join(",");
    const useHalation = !isPre && film.halation;
    const encodeArgs = [
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", ENCODE_PRESET,
      "-crf", ENCODE_CRF_MASTER,
      "-x264-params", X264_PARAMS,
      "-bufsize", BUFSIZE,
      ...trimArgs,
      "-an",
      normalized
    ];

    if (useHalation) {
      // Halation needs a split/blend sub-graph → filter_complex always.
      const graph =
        `[0:v]${preHalation}[fbase];` +
        film.halationGraph("fbase", "fglow") + ";" +
        `[fglow]${postHalation || "null"}[vout]` +
        (cornerHeadshotPath ? `;[vout][1:v]overlay=${cornerOverlayX}:${cornerOverlayY}[vfinal]` : "");
      await runFFmpeg([
        "-y",
        "-threads", "1",
        "-i", clip.clipPath,
        ...(cornerHeadshotPath ? ["-i", cornerHeadshotPath] : []),
        "-filter_complex", graph,
        "-map", cornerHeadshotPath ? "[vfinal]" : "[vout]",
        ...encodeArgs
      ], { timeoutMs: 180000, label: `runway:normalize-${clip.sceneIndex}` });
    } else {
      const baseFilters = [preHalation, postHalation].filter(Boolean).join(",");
      if (cornerHeadshotPath) {
        // Two-input filter_complex: base video → grade + watermark → overlay headshot.
        const filterComplex =
          `[0:v]${baseFilters}[bg];` +
          `[bg][1:v]overlay=${cornerOverlayX}:${cornerOverlayY}[vout]`;
        await runFFmpeg([
          "-y",
          "-threads", "1",
          "-i", clip.clipPath,
          "-i", cornerHeadshotPath,
          "-filter_complex", filterComplex,
          "-map", "[vout]",
          ...encodeArgs
        ], { timeoutMs: 180000, label: `runway:normalize-${clip.sceneIndex}` });
      } else {
        // No headshot — simpler single-input -vf chain.
        await runFFmpeg([
          "-y",
          "-threads", "1",
          "-i", clip.clipPath,
          "-vf", baseFilters,
          ...encodeArgs
        ], { timeoutMs: 180000, label: `runway:normalize-${clip.sceneIndex}` });
      }
    }

    normalizedClips.push({ ...clip, clipPath: normalized });
    options.onProgress?.({
      phase: `Polishing scene ${i + 1}/${clipResults.length}`,
      progress: NORMALIZE_PROGRESS_START + Math.floor(((i + 1) / clipResults.length) * NORMALIZE_PROGRESS_RANGE)
    });
  }
  // v60.5 slideshow guard report — the canary gate reads these lines.
  // Reference points: healthy Veo-era master ≈2.2, deterministic floor
  // ≈0.7, the "absolutely terrible" Kling canary ran 0.70-1.13.
  if (motionStats.length) {
    for (const m of motionStats) {
      console.log(`[motion] scene ${m.scene} YDIF=${m.ydif.toFixed(2)}${m.engine && m.engine !== "veo" ? ` (${m.engine})` : ""}`);
    }
    const sorted = motionStats.map((m) => m.ydif).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const dead = motionStats.filter((m) => m.ydif < 1.0).length;
    // v60.7: label which pass this is. The stitch runs once pre-sweep and
    // again after floor replacements — only the SECOND pass measures what
    // the customer receives. The fdc8e72 canary logged a proud 2.38
    // pre-sweep while the shipped master (3 floors + damped constrained
    // scenes) sat near the ALERT line; never let the first number stand
    // alone again.
    const postSweep = clipResults.some((c) => c.sweepReplaced);
    const passLabel = postSweep ? "SHIPPED (post-sweep re-stitch)" : "pre-sweep";
    console.log(`[motion] summary [${passLabel}] — median YDIF ${median.toFixed(2)}, scenes<1.0: ${dead}/${motionStats.length} (≈2.2 healthy, ≈0.7 floor, <1.0 slideshow-suspect)`);
    if (median < 1.3) {
      console.warn(`[motion] ALERT: median ${median.toFixed(2)} < 1.3 — this ${postSweep ? "SHIPPED master" : "render"} will read as a photo slideshow. Check engine duration/prompt wiring (v60.5) and the sweep floor count before shipping.`);
    }
  }

  // Clean up the corner headshot asset — every normalize call already
  // consumed it. Keeping it around just hogs disk.
  if (cornerHeadshotPath) await fs.unlink(cornerHeadshotPath).catch(() => {});

  // Step 2: prepare brand assets (headshot circle + brokerage logo) for the
  // outro card. These ffmpeg calls are tiny — fractions of a second each.
  // The outro is the final-impression real-estate card; this is where the
  // composited headshot + logo + license + Equal Housing footer earns the
  // "MLS-compliant" claim.
  options.onProgress?.({ phase: "Building outro card", progress: 80 });
  const headshotSize = Math.round(dimensions.width * 0.32);
  const logoMaxHeight = Math.round(dimensions.height * 0.07);
  // v53.3 (m68 Cheryl/KW): the logo's horizontal budget depends on layout.
  // Beside a headshot it gets the right half minus margins (overlay x is
  // W/2+30 in buildBrandOutroClip — keep in sync); centered alone it gets
  // the frame minus side padding. Without this cap, wide wordmark logos
  // scaled past the frame edge and clipped ("NJ METRO G—").
  const logoMaxWidth = brand.headshotUrl
    ? dimensions.width - (Math.round(dimensions.width / 2) + 30) - Math.round(dimensions.width * 0.05)
    : dimensions.width - 2 * Math.round(dimensions.width * 0.08);
  const [headshotCirclePath, logoAssetPath] = await Promise.all([
    buildHeadshotCircle(brand.headshotUrl, headshotSize, tempDir),
    buildLogoAsset(brand.brokerageLogoUrl, logoMaxHeight, tempDir, logoMaxWidth)
  ]);
  const outroClip = await buildBrandOutroClip(brand, dimensions, tempDir, {
    headshotCirclePath,
    logoAssetPath,
    headshotSize,
    logoMaxHeight
  });

  // Step 3: stitch.
  // ============================================================================
  // CRITICAL DESIGN DECISION: simple concat is the DEFAULT, not the fallback.
  // ============================================================================
  // The previous default (xfade with 0.5s crossfades) was a single ffmpeg
  // call that re-encoded all 24+ clips through a long filter_complex graph.
  // On Render Standard's 2GB plan that ate 3-8 minutes of CPU and routinely
  // OOM-killed the worker mid-stitch. The user sees this as "stuck at 80%".
  //
  // Simple concat with -c copy is a 1-2 second demuxer pass — no re-encode,
  // no filter graph, no RAM pressure. Hard cuts between scenes instead of
  // crossfades, but the render reliably ships.
  //
  // xfade is now opt-in via manifest.runwayConfig.useCrossfades. We can
  // re-enable it as the default once the worker has more RAM (Render
  // Standard Plus, 4GB) or once we batch the stitch into smaller groups.
  // ============================================================================
  const stitched = path.join(tempDir, "stitched.mp4");
  options.onProgress?.({ phase: "Stitching final video", progress: 81 });
  // Crossfades are the product. Default ON unless the manifest explicitly
  // opts out (e.g. some MLS regions reject any blended frames). If the
  // batched xfade pipeline throws, we still fall through to simple concat
  // below — so the render always ships, just with hard cuts.
  const useCrossfades = manifest?.runwayConfig?.useCrossfades !== false;
  if (useCrossfades) {
    try {
      await stitchWithCrossfades({
        clips: normalizedClips,
        outroClip,
        output: stitched,
        crossfadeDurationSec: 0.5
      });
    } catch (err) {
      console.warn(`[runway] xfade stitch failed (${err.message}). Falling back to simple concat.`);
      await stitchWithSimpleConcat({
        clips: normalizedClips,
        outroClip,
        output: stitched,
        tempDir
      });
    }
  } else {
    await stitchWithSimpleConcat({
      clips: normalizedClips,
      outroClip,
      output: stitched,
      tempDir
    });
  }

  // v20: corner headshot is baked into each clip during normalize above —
  // no separate post-stitch ffmpeg pass needed. The v19 approach OOM'd
  // Render Standard 2GB. Per-clip overlay distributes the work and never
  // accumulates more than one ffmpeg process worth of memory at a time.

  // Step 4: optional audio mix from manifest.musicMood mapping. We honor a
  // RUNWAY_MUSIC_<MOOD>_URL env var pointing to a remote MP3. If no music
  // configured, the final video has no audio (acceptable for v1).
  // v24.1: dropped music bed from 0.35 to 0.22 (~ -13 dB) because the
  // first real render had music dominating voice. Lower bed means:
  //   - music alone (narration missing/skipped): -13 dB — quiet background
  //   - music under voice: 0.22 × 0.30 = 0.066 → ~ -24 dB, voice
  //     clearly cuts through at +3 dB (VOICE_WEIGHT 1.4 in voice-mixer)
  // Trade-off: when there's no narration the video feels quieter. But
  // it's much better than music drowning a working narration. Bump back
  // up via env MUSIC_BED_LEVEL or manifest.musicBedLevel if needed.
  const musicBedLevel = Number(
    manifest?.musicBedLevel ?? process.env.MUSIC_BED_LEVEL ?? 0.22
  );
  // v24.2: respect manifest.skipMusic (set by webapp Audio panel toggle).
  // Even when a track is bundled, skip the mix step entirely so the
  // master ships with only voice (or silence).
  const musicUrl = manifest?.skipMusic ? null : pickMusicUrl(manifest);
  if (musicUrl) {
    // v45.11: end fade on the bed here too — this attach is the FINAL audio
    // for no-narration music renders (voiced renders re-fade in voice-mixer).
    const stitchedDur = await probeAudioDuration(stitched).catch(() => 0);
    const fadeSec = Number(process.env.MUSIC_END_FADE_SEC ?? 1.8);
    const fade = stitchedDur > fadeSec ? `,afade=t=out:st=${(stitchedDur - fadeSec).toFixed(2)}:d=${fadeSec.toFixed(2)}` : "";
    await runFFmpeg([
      "-y",
      "-threads", "1",
      "-i", stitched,
      // v45.11b (m41): tracks SHORTER than the video ended the bed early —
      // amix duration=first + -shortest then truncated the ENTIRE audio
      // stream (m41 shipped 4.2s of dead silence over its final scenes).
      // Loop the bed; -shortest still caps output at the video's length.
      "-stream_loop", "-1",
      "-i", musicUrl,
      "-filter_complex", `[1:a]volume=${musicBedLevel.toFixed(3)}${fade}[mus]`,
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      "-map", "0:v:0",
      "-map", "[mus]",
      outputPath
    ], { timeoutMs: 120000, label: "runway:music-mix" });
  } else {
    await fs.copyFile(stitched, outputPath);
  }

  // Free the stitched intermediate (already concatenated into outputPath).
  if (outroClip) await fs.unlink(outroClip).catch(() => {});
  await fs.unlink(stitched).catch(() => {});

  // NOTE: We do NOT delete the per-scene normalized clips here anymore.
  // The caller needs them for the per-scene regenerate flow — each clip
  // is uploaded to Supabase Storage so a single bad scene can be swapped
  // without re-rendering the entire video. Caller deletes them after upload.

  // Step 5: extract a thumbnail from ~10% in.
  await runFFmpeg([
    "-y",
    "-threads", "1",
    "-i", outputPath,
    "-ss", "1.5",
    "-vframes", "1",
    "-q:v", "3",
    thumbnailPath
  ], { timeoutMs: 30000, label: "runway:thumbnail" });

  // Return the normalized clips so the caller can upload them for regen support.
  return { normalizedClips };
}

// stitchWithCrossfades / stitchWithSimpleConcat were extracted into
// ./stitch.mjs so the floor engine and the runway engine can share
// the exact same crossfade/concat logic. See that file for the v22
// batched-xfade rationale and tuning constants.
//
// Local helpers below are runway-specific things that don't need to
// be shared (brand outro, etc.).

/* =================================================================
   Brand outro + persistent watermark
   ================================================================= */

const FFMPEG_FONT = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf";
const FFMPEG_FONT_REGULAR = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf";

function normalizeBrandKitForFFmpeg(brandKit = {}) {
  return {
    name: ffEscape(brandKit.fullName || brandKit.name || ""),
    brokerage: ffEscape(brandKit.brokerage || ""),
    phone: ffEscape(brandKit.phone || ""),
    email: ffEscape(brandKit.email || ""),
    licenseNumber: ffEscape(brandKit.licenseNumber || ""),
    cta: ffEscape(brandKit.ctaText || "Schedule a private tour"),
    // Raw URLs preserved (not ff-escaped) for ffmpeg image inputs.
    headshotUrl: brandKit.headshotUrl || "",
    brokerageLogoUrl: brandKit.brokerageLogoUrl || ""
  };
}

// Pre-render the agent's headshot as a circular alpha-masked PNG for use
// in ffmpeg overlay calls (watermark + outro). Generated once per render
// at the chosen pixel size, then reused across compositions. Returns null
// if no headshot URL is configured.
async function buildHeadshotCircle(headshotUrl, sizePx, tempDir) {
  if (!headshotUrl) return null;
  try {
    const sourcePath = path.join(tempDir, "headshot-source.jpg");
    await downloadImageValidated(headshotUrl, sourcePath, "headshot");
    const circlePath = path.join(tempDir, `headshot-circle-${sizePx}.png`);
    const radius = sizePx / 2;
    const radiusInner = radius - 1;
    // geq=...a='if(gt(distance,radius),0,255)' produces a hard-edged
    // circular alpha mask. Combined with format=yuva420p so we have an
    // alpha channel to mask against.
    await runFFmpeg([
      "-y", "-threads", "1",
      "-i", sourcePath,
      "-vf",
      `scale=${sizePx}:${sizePx}:force_original_aspect_ratio=increase,crop=${sizePx}:${sizePx},format=yuva420p,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(pow(X-${radius},2)+pow(Y-${radius},2),pow(${radiusInner},2)),0,255)'`,
      "-frames:v", "1",
      circlePath
    ], { timeoutMs: 30000, label: "runway:headshot-circle" });
    await fs.unlink(sourcePath).catch(() => {});
    return circlePath;
  } catch (err) {
    console.warn(`[runway] headshot circle failed (${err.message}). Outro will fall back to text-only.`);
    return null;
  }
}

// Pre-render the brokerage logo scaled to fit a target height (preserving
// aspect ratio and transparent background). Returns null on failure.
async function buildLogoAsset(logoUrl, maxHeightPx, tempDir, maxWidthPx = 0) {
  if (!logoUrl) return null;
  try {
    const sourcePath = path.join(tempDir, "logo-source");
    await downloadImageValidated(logoUrl, sourcePath, "logo");
    const outPath = path.join(tempDir, `logo-${maxHeightPx}.png`);
    // v53.3 (m68 Cheryl/KW outro): height-only scaling let wide wordmark
    // logos overflow the frame — "NJ METRO GROUP" rendered as "NJ METRO G"
    // clipped at the right edge. Fit BOTH boxes: height cap as before, and
    // when a width cap is given, force-fit inside it (decrease only).
    const fit = maxWidthPx > 0
      ? `scale=w='min(${maxWidthPx},iw*${maxHeightPx}/ih)':h=-1:flags=lanczos`
      : `scale=-1:${maxHeightPx}:flags=lanczos`;
    await runFFmpeg([
      "-y", "-threads", "1",
      "-i", sourcePath,
      // Scale to fit, preserve aspect, keep alpha if present.
      "-vf", `${fit},format=rgba`,
      "-frames:v", "1",
      outPath
    ], { timeoutMs: 30000, label: "runway:logo-asset" });
    await fs.unlink(sourcePath).catch(() => {});
    return outPath;
  } catch (err) {
    console.warn(`[runway] logo asset prep failed (${err.message}). Outro will skip logo.`);
    return null;
  }
}

// drawtext expects backslash-escaped colons and percent signs.
// v48 dry-run finding: the old \' apostrophe escape TERMINATES ffmpeg's
// '-quoted text value mid-string, and everything after it (e.g. a comma)
// leaks into the filterchain parser — "O'Brien Ln, Gilbert" split the -vf
// chain with "No such filter". The safe fix is substitution: a typographic
// right single quote (U+2019) renders identically in LiberationSans and
// has zero meaning to the parser. No behavior change for any string
// without an apostrophe — which is every string this has ever processed.
function ffEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "’")
    .replace(/%/g, "\\%");
}

function runwayDimensions(manifest) {
  const ratio = String(manifest?.runwayConfig?.ratio || manifest?.exportFormat || "vertical").toLowerCase();
  if (ratio === "16:9" || ratio === "wide") return { width: 1920, height: 1080 };
  if (ratio === "1:1" || ratio === "square") return { width: 1080, height: 1080 };
  return { width: 1080, height: 1920 };
}

// v46 (Troy, launch day): FREE-render watermark — a small persistent
// "vistalia.ai" pill, top-left (bottom-left holds the agent identity badge,
// top-right the corner headshot, captions live at ~70% height). Visible
// enough to nudge the upgrade and credit the brand if the video gets
// posted; subtle enough that posting it is still tempting. Static text
// only — no user input reaches this filter.
function buildFreeRenderWatermark(dimensions) {
  // v46.1 (Troy): ~20% larger than the launch size (/36 → /30). The mark is
  // the upgrade nudge — Reel-E closed Troy himself on exactly this feeling.
  const fontSize = Math.max(24, Math.round(dimensions.width / 30));
  return (
    `drawtext=fontfile='${FFMPEG_FONT}'` +
    `:text='vistalia.ai'` +
    `:fontcolor=white@0.92:fontsize=${fontSize}` +
    `:x=36:y=40` +
    `:box=1:boxcolor=black@0.40:boxborderw=16`
  );
}

// v48: scene-one address chip — a listing video should say WHERE. Reads
// manifest.project.address/.city, which every manifest has carried since
// launch (the worker just never used them). FAIL-OPEN BY DESIGN: missing
// address, a too-short opening clip, an oversized string, or any exception
// returns "" and the filter chain is byte-identical to v47. Text passes
// through ffEscape like every other user-adjacent drawtext string; the
// chip fades in ~0.7s and is gone by ~5s, top-center, below the top-left
// pill row and clear of the top-right headshot.
function buildAddressIntro(manifest, dimensions, clipDuration) {
  try {
    // Whitelist sanitizer — addresses only ever need these characters, and
    // nothing that survives it means anything to ffmpeg's chain parser.
    // Apostrophes become typographic (see ffEscape note), commas become
    // spaces ("Gilbert, AZ" → "Gilbert AZ").
    const clean = (s) =>
      String(s || "")
        .replace(/'/g, "’")
        .replace(/,/g, " ")
        .replace(/[^A-Za-z0-9 #.·\-&’\/]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const street = clean(manifest?.project?.address);
    if (!street) return "";
    const city = clean(manifest?.project?.city);
    let text = city ? `${street}  ·  ${city}` : street;
    if (text.length > 44) text = street;      // drop city before overflowing
    if (text.length > 44) return "";           // pathological — skip, don't wrap
    const dur = Number(clipDuration) > 0 ? Number(clipDuration) : 0;
    if (dur < 2.5) return "";                  // no room to fade in and out politely
    const end = Math.min(4.6, dur - 0.5);
    const endS = end.toFixed(2);
    const goneS = (end + 0.5).toFixed(2);
    const fontSize = Math.max(22, Math.round(dimensions.width / 38));
    const y = Math.round(dimensions.height * 0.062);
    const alpha =
      `if(lt(t,0.7),0,if(lt(t,1.3),(t-0.7)/0.6,` +
      `if(lt(t,${endS}),1,if(lt(t,${goneS}),(${goneS}-t)/0.5,0))))`;
    return (
      `drawtext=fontfile='${FFMPEG_FONT}'` +
      `:text='${ffEscape(text)}'` +
      `:fontcolor=white@0.94:fontsize=${fontSize}` +
      `:x=(w-text_w)/2:y=${y}` +
      `:alpha='${alpha}'` +
      `:box=1:boxcolor=black@0.35:boxborderw=12`
    );
  } catch {
    return "";
  }
}

// v50: serif title reveal — the thumbnail typography, in motion, over the
// opening scene. Street in the brand serif, thin gold rule, city beneath in
// letterspaced caps; staggered fades, gone by ~5s like the v48 chip it
// replaces. FAIL-OPEN CONTRACT: FINISH_TITLE=0, a missing/oversized
// address, a short opening clip, a missing serif font file, or ANY throw
// falls back to the v48 chip (which has its own fail-open to ""). Nothing
// user-controlled reaches the chain unsanitized.
function buildTitleIntro(manifest, dimensions, clipDuration, styleKey) {
  if (!FINISH_TITLE) return buildAddressIntro(manifest, dimensions, clipDuration);
  try {
    const clean = (s) =>
      String(s || "")
        .replace(/'/g, "’")
        .replace(/,/g, " ")
        .replace(/[^A-Za-z0-9 #.·\-&’\/]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const street = clean(manifest?.project?.address);
    if (!street) return "";
    if (street.length > 40) return buildAddressIntro(manifest, dimensions, clipDuration);
    const dur = Number(clipDuration) > 0 ? Number(clipDuration) : 0;
    if (dur < 3.0) return buildAddressIntro(manifest, dimensions, clipDuration);
    const serifPath = path.join(CAPTIONS_FONTS_DIR, "VistaliaSerif-SemiBold.ttf");
    if (!existsSync(serifPath)) return buildAddressIntro(manifest, dimensions, clipDuration);

    const city = clean(manifest?.project?.city);
    // Letterspaced caps via thin single-space joins — drawtext has no
    // tracking parameter; this is the standard approximation.
    const citySpaced = city ? city.toUpperCase().split("").join(" ").replace(/   /g, "  ") : "";

    const end = Math.min(4.8, dur - 0.4);
    const endS = end.toFixed(2);
    const goneS = (end + 0.5).toFixed(2);
    const streetSize = Math.round(dimensions.width / (street.length > 26 ? 26 : 22));
    const citySize = Math.max(18, Math.round(dimensions.width / 46));
    const yStreet = Math.round(dimensions.height * 0.056);
    const yRule = yStreet + streetSize + 16;
    const yCity = yRule + 14;
    const ruleW = Math.round(dimensions.width * 0.17);

    const alphaFor = (inStart, inEnd) =>
      `if(lt(t,${inStart}),0,if(lt(t,${inEnd}),(t-${inStart})/${(inEnd - inStart).toFixed(2)},` +
      `if(lt(t,${endS}),1,if(lt(t,${goneS}),(${goneS}-t)/0.5,0))))`;

    const parts = [
      `drawtext=fontfile='${serifPath}'` +
        `:text='${ffEscape(street)}'` +
        `:fontcolor=white@0.96:fontsize=${streetSize}` +
        `:x=(w-text_w)/2:y=${yStreet}` +
        `:alpha='${alphaFor(0.55, 1.15)}'` +
        `:shadowcolor=black@0.55:shadowx=0:shadowy=2`,
      `drawbox=x=(iw-${ruleW})/2:y=${yRule}:w=${ruleW}:h=2:color=0xC7A76C@0.85:t=fill` +
        `:enable='between(t,0.95,${goneS})'`
    ];
    if (citySpaced && citySpaced.length <= 40) {
      parts.push(
        `drawtext=fontfile='${serifPath}'` +
          `:text='${ffEscape(citySpaced)}'` +
          `:fontcolor=0xC7A76C@0.95:fontsize=${citySize}` +
          `:x=(w-text_w)/2:y=${yCity}` +
          `:alpha='${alphaFor(0.85, 1.45)}'` +
          `:shadowcolor=black@0.5:shadowx=0:shadowy=1`
      );
    }
    return parts.join(",");
  } catch {
    try {
      return buildAddressIntro(manifest, dimensions, clipDuration);
    } catch {
      return "";
    }
  }
}

// Lower-left tinted plate with name + brokerage. drawtext box is the closest
// ffmpeg-native equivalent of the Reel-e.ai persistent identity badge.
function buildWatermarkDrawtext({ name, brokerage }, dimensions) {
  if (!name && !brokerage) return "";
  const baseY = dimensions.height - 130;
  const fontSize = Math.max(22, Math.round(dimensions.width / 50));
  const subSize = Math.max(18, Math.round(dimensions.width / 64));
  const filters = [];
  if (name) {
    filters.push(
      `drawtext=fontfile='${FFMPEG_FONT}'` +
      `:text='${name}'` +
      `:fontcolor=white:fontsize=${fontSize}` +
      `:x=36:y=${baseY}` +
      `:box=1:boxcolor=black@0.55:boxborderw=12`
    );
  }
  if (brokerage) {
    const subY = name ? baseY + fontSize + 10 : baseY;
    filters.push(
      `drawtext=fontfile='${FFMPEG_FONT_REGULAR}'` +
      `:text='${brokerage}'` +
      `:fontcolor=white@0.85:fontsize=${subSize}` +
      `:x=36:y=${subY}` +
      `:box=1:boxcolor=black@0.55:boxborderw=10`
    );
  }
  return filters.join(",");
}

// Build a 5-second outro card via ffmpeg lavfi: solid background, agent name
// large + centered, brokerage below, contact line below. No headshot in v1
// (circular masks via geq are slow on the worker; Quick Reel renders the
// headshot circle the proper way via Remotion).
// Brand outro card, fully composited.
// Layers from back to front:
//   1. dark vignette background
//   2. circular headshot at top-center (if available)
//   3. brokerage logo to the right of the headshot (if available)
//   4. CTA eyebrow → agent name → brokerage → license → contact
//   5. Equal Housing footer + Vistalia attribution
// All optional pieces gracefully omit when not provided.
async function buildBrandOutroClip(
  { name, brokerage, phone, email, licenseNumber, cta },
  dimensions,
  tempDir,
  assets = {}
) {
  if (!name && !brokerage) return null;
  const outroPath = path.join(tempDir, "brand-outro.mp4");
  const { headshotCirclePath, logoAssetPath, headshotSize = 0, logoMaxHeight = 0 } = assets;

  // Layout — compute Y positions sequentially so the card adapts to which
  // optional pieces are present.
  const W = dimensions.width;
  const H = dimensions.height;
  // v35.2: size text from the EFFECTIVE width — min(W, H×9/16). On the
  // 9:16 master this equals W exactly (no change); on the 1:1 square the
  // card has half the height for the same-width fonts, so the text block
  // overcrowded and the footer clipped (test-17). Scaling type to the
  // height-constrained equivalent keeps the layout proportions identical
  // across aspects.
  const S = Math.min(W, Math.round((H * 9) / 16));
  const padTop = Math.round(H * 0.12);
  const headshotY = headshotCirclePath ? padTop : 0;
  // v50.9 (Pam Jensen outro): with a logo but NO headshot, logoY used the
  // headshot-centering formula (padTop + headshotSize*0.5 − logoH/2 — and
  // headshotSize is computed even when no headshot exists) while the text
  // block started at padTop as if no header existed — so the agent's NAME
  // drew straight through the logo. Name-wordmark logos made it obvious.
  // Coherent rule: the header is whatever exists (headshot, logo, both,
  // neither), and text always starts below it.
  const logoY = headshotCirclePath
    ? padTop + Math.round(headshotSize * 0.5) - Math.round(logoMaxHeight / 2)
    : padTop;
  const headerBlockBottom = headshotCirclePath
    ? padTop + headshotSize
    : logoAssetPath
      ? padTop + logoMaxHeight
      : padTop;
  const ctaY = headerBlockBottom + Math.round(H * 0.04);
  const ctaSize = Math.max(16, Math.round(S / 48));
  const nameSize = Math.max(40, Math.round(S / 13));
  const brokerSize = Math.max(22, Math.round(S / 32));
  const licenseSize = Math.max(16, Math.round(S / 50));
  const contactSize = Math.max(18, Math.round(S / 44));
  const footerSize = Math.max(13, Math.round(S / 60));

  const nameY = ctaY + ctaSize + Math.round(H * 0.025);
  const brokerY = nameY + nameSize + Math.round(H * 0.02);
  const licenseY = brokerY + brokerSize + Math.round(H * 0.012);
  const contactY = licenseY + licenseSize + Math.round(H * 0.022);
  const accentRuleY = contactY + contactSize + Math.round(H * 0.018);
  const footerY = H - Math.round(H * 0.06);

  // Inputs: lavfi background + optional headshot + optional logo. Indices
  // in the filter graph: [0:v] = bg, [1:v] = headshot (if present),
  // [2:v] = logo (if both present), or [1:v] = logo (if only logo).
  const inputs = [
    "-f", "lavfi",
    "-i", `color=c=0x0A0A0A:size=${W}x${H}:rate=30:duration=5`
  ];
  let nextInputIndex = 1;
  let headshotInputIdx = -1;
  let logoInputIdx = -1;
  if (headshotCirclePath) {
    inputs.push("-i", headshotCirclePath);
    headshotInputIdx = nextInputIndex++;
  }
  if (logoAssetPath) {
    inputs.push("-i", logoAssetPath);
    logoInputIdx = nextInputIndex++;
  }

  // Build the filter graph step by step. Each step labels its output for
  // the next step to consume.
  const graphSteps = [];
  let lastLabel = "0:v";
  graphSteps.push(`[${lastLabel}]vignette=PI/4[bg0]`);
  lastLabel = "bg0";

  if (headshotInputIdx >= 0) {
    const headshotX = logoAssetPath
      ? Math.round(W / 2 - headshotSize - 30)
      : Math.round((W - headshotSize) / 2);
    graphSteps.push(`[${lastLabel}][${headshotInputIdx}:v]overlay=${headshotX}:${headshotY}[withhead]`);
    lastLabel = "withhead";
  }
  if (logoInputIdx >= 0) {
    // v50.9: true centering via overlay expressions — the old guess assumed
    // a 3:1 logo aspect, which walked wide wordmarks off-center.
    // v53.3: with the new width cap (buildLogoAsset maxWidthPx) a wide logo
    // can render SHORTER than logoMaxHeight, so vertical centering beside
    // the headshot must use the actual overlay height, not the precomputed
    // logoY.
    const logoX = headshotCirclePath
      ? String(Math.round(W / 2 + 30))
      : "(main_w-overlay_w)/2";
    const logoYExpr = headshotCirclePath
      ? `${padTop + Math.round(headshotSize / 2)}-overlay_h/2`
      : String(logoY);
    graphSteps.push(`[${lastLabel}][${logoInputIdx}:v]overlay=${logoX}:${logoYExpr}[withlogo]`);
    lastLabel = "withlogo";
  }

  // Text overlays — chained as drawtext filters.
  const drawtextChain = [];
  // CTA eyebrow (gold uppercase, manually spaced for tracking)
  if (cta) {
    const spacedCta = cta.toUpperCase().split("").join(" ").replace(/  +/g, "  ");
    drawtextChain.push(
      `drawtext=fontfile='${FFMPEG_FONT}':text='${spacedCta}':fontcolor=0xC7A76C:fontsize=${ctaSize}:x=(w-text_w)/2:y=${ctaY}`
    );
  }
  // Agent name — the primary line
  drawtextChain.push(
    `drawtext=fontfile='${FFMPEG_FONT}':text='${name || "Your Local Agent"}':fontcolor=white:fontsize=${nameSize}:x=(w-text_w)/2:y=${nameY}`
  );
  // Brokerage
  if (brokerage) {
    drawtextChain.push(
      `drawtext=fontfile='${FFMPEG_FONT_REGULAR}':text='${brokerage}':fontcolor=white@0.85:fontsize=${brokerSize}:x=(w-text_w)/2:y=${brokerY}`
    );
  }
  // License number — the MLS-compliance signal
  if (licenseNumber) {
    drawtextChain.push(
      `drawtext=fontfile='${FFMPEG_FONT_REGULAR}':text='${licenseNumber}':fontcolor=0xC7A76C:fontsize=${licenseSize}:x=(w-text_w)/2:y=${licenseY}`
    );
  }
  // Contact line
  const contact = [phone, email].filter(Boolean).join("   ·   ");
  if (contact) {
    drawtextChain.push(
      `drawtext=fontfile='${FFMPEG_FONT_REGULAR}':text='${contact}':fontcolor=white@0.92:fontsize=${contactSize}:x=(w-text_w)/2:y=${contactY}`
    );
  }
  // Bottom accent rule.
  // v53.3 (m68): in drawbox, `w` is the BOX width — not the frame width
  // like drawtext's `w`. (w-280)/2 therefore evaluated to (280-280)/2 = 0
  // and the gold rule has been drawing as a stub at the LEFT EDGE on every
  // outro ever rendered. `iw` is the frame width in drawbox.
  drawtextChain.push(
    `drawbox=x=(iw-280)/2:y=${accentRuleY}:w=280:h=2:color=0xC7A76C:t=fill`
  );
  // Equal Housing + Vistalia attribution footer (MLS compliance)
  const footerText = ffEscape("Equal Housing Opportunity  ·  Made with Vistalia");
  drawtextChain.push(
    `drawtext=fontfile='${FFMPEG_FONT_REGULAR}':text='${footerText}':fontcolor=white@0.55:fontsize=${footerSize}:x=(w-text_w)/2:y=${footerY}`
  );
  // Fade in / out so xfade can blend cleanly
  drawtextChain.push(`fade=t=in:st=0:d=0.6:alpha=0`);
  drawtextChain.push(`fade=t=out:st=4.4:d=0.6:alpha=0`);

  graphSteps.push(`[${lastLabel}]${drawtextChain.join(",")}[vout]`);
  const filterComplex = graphSteps.join(";");

  await runFFmpeg([
    "-y",
    "-threads", "1",
    ...inputs,
    "-filter_complex", filterComplex,
    "-map", "[vout]",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-preset", ENCODE_PRESET,
    "-crf", ENCODE_CRF_MASTER,
    "-x264-params", X264_PARAMS,
    "-bufsize", BUFSIZE,
    "-r", "30",
    "-t", "5",
    "-an",
    outroPath
  ], { timeoutMs: 90000, label: "runway:outro-card" });

  // Free the asset PNGs now that the outro is on disk.
  if (headshotCirclePath) await fs.unlink(headshotCirclePath).catch(() => {});
  if (logoAssetPath) await fs.unlink(logoAssetPath).catch(() => {});

  return outroPath;
}

async function downloadFile(url, destPath) {
  // 60-second timeout — Runway clip downloads should be fast (~5MB), but
  // a hung CDN connection without a timeout would lock the whole pipeline.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(destPath, buffer);
  } finally {
    clearTimeout(timer);
  }
}

// v32.1 headshot/logo fix. The brand-kit URLs are getPublicUrl() links; on a
// private bucket Supabase's public endpoint returns a ~600-byte JSON error
// WITH HTTP 200, which downloadFile happily saved as "headshot-source.jpg"
// and ffmpeg rejected ("No JPEG data found") on EVERY render. This helper
// (1) validates magic bytes after download, (2) on failure logs exactly what
// was received, and (3) if the URL is Supabase storage, self-heals by
// minting a FRESH SIGNED URL with the worker's service-role client and
// retrying once. Fixes all legacy brand-kit rows without touching the webapp.
function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "webp";
  if (buf.slice(4, 8).toString() === "ftyp") return "heic"; // heic/heif/avif family
  return null;
}

function parseSupabaseStorageUrl(url) {
  const m = String(url || "").match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/([^?]+)/);
  return m ? { bucket: m[1], objectPath: decodeURIComponent(m[2]) } : null;
}

async function downloadImageValidated(url, destPath, label) {
  await downloadFile(url, destPath);
  let buf = await fs.readFile(destPath);
  let kind = sniffImageType(buf);
  if (kind === "heic") {
    throw new Error(`${label}: file is HEIC/HEIF — ffmpeg can't decode it. Re-upload as JPG or PNG.`);
  }
  if (kind) return kind;

  // v58.3: SVG brand assets (3D Realty's logo on m74) — the webapp accepts
  // them but ffmpeg can't decode vectors, so every outro silently dropped
  // the logo. sharp (libvips) rasterizes SVG cleanly; 1024px box keeps the
  // outro chip crisp.
  const head = buf.slice(0, 300).toString("utf8").trim().toLowerCase();
  if (head.startsWith("<?xml") || head.includes("<svg")) {
    try {
      const sharp = (await import("sharp")).default;
      const png = await sharp(buf, { density: 300 })
        .resize({ width: 1024, height: 1024, fit: "inside" })
        .png()
        .toBuffer();
      await fs.writeFile(destPath, png);
      console.info(`[brand] ${label}: SVG rasterized to PNG (${png.length} bytes) — logo restored.`);
      return "png";
    } catch (svgErr) {
      console.warn(`[brand] ${label}: SVG rasterize failed (${svgErr.message}).`);
    }
  }

  // Not an image. Log what we actually got (usually a storage error JSON).
  const preview = buf.slice(0, 120).toString("utf8").replace(/\s+/g, " ");
  console.warn(`[brand] ${label}: URL returned non-image (${buf.length} bytes): "${preview}"`);

  const parsed = parseSupabaseStorageUrl(url);
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (parsed && supabaseUrl && serviceKey) {
    console.info(`[brand] ${label}: re-signing ${parsed.bucket}/${parsed.objectPath} and retrying.`);
    const sb = createClient(supabaseUrl, serviceKey);
    const { data, error } = await sb.storage.from(parsed.bucket).createSignedUrl(parsed.objectPath, 3600);
    if (!error && data?.signedUrl) {
      await downloadFile(data.signedUrl, destPath);
      buf = await fs.readFile(destPath);
      kind = sniffImageType(buf);
      if (kind === "heic") {
        throw new Error(`${label}: file is HEIC/HEIF — ffmpeg can't decode it. Re-upload as JPG or PNG.`);
      }
      if (kind) return kind;
    } else if (error) {
      console.warn(`[brand] ${label}: re-sign failed (${error.message}).`);
    }
  }
  throw new Error(`${label}: URL does not serve a decodable image (jpeg/png/webp).`);
}

/* =================================================================
   Supabase upload
   ================================================================= */

// Per-scene clip uploader for regenerate-scene support. Pushes each
// normalized per-scene MP4 to Supabase Storage with a deterministic
// filename (scene-000.mp4 → scene-023.mp4) inside the job folder, and
// returns the scene metadata array that goes into the audit log.
// Failures here are warned-and-skipped; regen for that one scene will
// fall back to "not available" in the UI but the rest of the render
// still ships.
export async function uploadPerSceneClips({ manifest, jobId, normalizedClips, clipResults, pathPrefix }) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const bucket = process.env.SUPABASE_GENERATED_VIDEOS_BUCKET || "generated-videos";
  if (!supabaseUrl || !serviceRoleKey) {
    return [];
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const ownerId = slug(manifest.project?.userId || manifest.project?.id || "demo");
  const basePath = `${ownerId}/${pathPrefix}/${jobId}`;

  // Cross-reference normalizedClips against clipResults so we have full
  // per-scene metadata (photoId, runwayPrompt, fallback flag, etc).
  const resultsByIndex = new Map(clipResults.map((c) => [c.sceneIndex, c]));
  const sceneMeta = [];
  for (const clip of normalizedClips) {
    const original = resultsByIndex.get(clip.sceneIndex) || {};
    const sceneIndex = clip.sceneIndex;
    const filename = `scene-${String(sceneIndex).padStart(3, "0")}.mp4`;
    const storagePath = `${basePath}/${filename}`;
    let clipUrl = "";
    try {
      const buffer = await fs.readFile(clip.clipPath);
      const result = await supabase.storage.from(bucket).upload(storagePath, buffer, {
        contentType: "video/mp4",
        upsert: true
      });
      if (!result.error) {
        clipUrl = supabase.storage.from(bucket).getPublicUrl(storagePath).data.publicUrl;
      } else {
        console.warn(`[upload] scene ${sceneIndex} clip upload failed: ${result.error.message}`);
      }
    } catch (err) {
      console.warn(`[upload] scene ${sceneIndex} clip read/upload failed: ${err.message || err}`);
    }
    // Even if upload failed, still include the metadata — clipUrl will
    // just be empty and the regen UI will show that scene as "not regenerable".
    sceneMeta.push({
      sceneIndex,
      photoId: original.photoId || "",
      photoUrl: pickSceneImageUrl(original, manifest),
      clipUrl,
      storagePath: clipUrl ? storagePath : "",
      roomType: original.roomType || inferRoomTypeFromScene(original, manifest) || "",
      cameraMotion: original.cameraMotion || "",
      duration: Number(clip.duration || original.duration || 5),
      runwayPrompt: original.runwayPrompt || "",
      wasFallback: Boolean(original.fallback),
      // v49 audit enrichment — the Veo path finally writes the v23 fields.
      // engineUsed/fallbackReason/attempts power the floor-rate tuning
      // queries (render_scene_breakdown) and, later, the MLS-Safe
      // Certificate's per-scene provenance.
      engineUsed: (original.usedPhotoMotionFloor || original.fallback) ? "photo_motion" : "veo",
      fallbackReason: original.floorReason || null,
      attempts: Number.isFinite(original.attemptsUsed) ? original.attemptsUsed : null,
      sweepReplaced: Boolean(original.sweepReplaced)
    });
  }
  return sceneMeta;
}

// Look up the durable photo URL for a scene from the manifest's
// orderedPhotos. Used to build the scenes audit metadata.
function pickSceneImageUrl(sceneOrResult, manifest) {
  if (!sceneOrResult) return "";
  const photoId = sceneOrResult.photoId;
  if (!photoId) return "";
  const photo = (manifest.orderedPhotos || []).find((p) => p.id === photoId);
  if (!photo) return "";
  return photo.durableUrl || photo.durable_url || photo.publicUrl || photo.public_url || "";
}

function inferRoomTypeFromScene(sceneOrResult, manifest) {
  if (sceneOrResult?.roomType) return sceneOrResult.roomType;
  const manifestScene = (manifest.scenes || []).find((s) => s.photoId === sceneOrResult?.photoId);
  return manifestScene?.roomType || "";
}

async function uploadRunwayAssets({ manifest, jobId, variants, shorts, thumbnailPath, onProgress }) {
  return uploadDeliverables({
    manifest,
    jobId,
    variants,
    shorts,
    thumbnailPath,
    pathPrefix: "runway",
    onProgress
  });
}

// Shared multi-format uploader — used by both Runway and Remotion pipelines.
// Uploads:
//   <owner>/<prefix>/<jobId>/master.mp4           (vertical, kept as the
//                                                  primary deliverable)
//   <owner>/<prefix>/<jobId>/square.mp4
//   <owner>/<prefix>/<jobId>/wide.mp4
//   <owner>/<prefix>/<jobId>/short-1.mp4..short-N.mp4
//   <owner>/<prefix>/<jobId>/thumbnail.png
export async function uploadDeliverables({ manifest, jobId, variants, shorts, thumbnailPath, pathPrefix, onProgress }) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const bucket = process.env.SUPABASE_GENERATED_VIDEOS_BUCKET || "generated-videos";

  if (!supabaseUrl || !serviceRoleKey) {
    return {
      storageSkipped: true,
      storageWarning: "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required to upload generated videos.",
      formats: {},
      socialShorts: [],
      thumbnailUrl: ""
    };
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const ownerId = slug(manifest.project?.userId || manifest.project?.id || "demo");
  const basePath = `${ownerId}/${pathPrefix}/${jobId}`;

  const VARIANT_FILENAMES = {
    vertical: "master.mp4",
    square: "square.mp4",
    wide: "wide.mp4"
  };

  // Per-file upload helper with one retry — Supabase upload occasionally
  // 502s on large files due to network blips; one retry resolves >95%
  // of those without escalating to a job failure.
  const uploadOneFile = async (storagePath, localPath, contentType, label) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const buffer = await fs.readFile(localPath);
        const result = await supabase.storage.from(bucket).upload(storagePath, buffer, {
          contentType,
          upsert: true
        });
        if (result.error) throw new Error(result.error.message);
        return supabase.storage.from(bucket).getPublicUrl(storagePath).data.publicUrl;
      } catch (err) {
        if (attempt === 1) {
          console.warn(`[upload] ${label} failed after retry: ${err.message}`);
          return null;
        }
        console.warn(`[upload] ${label} attempt 1 failed (${err.message}), retrying...`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    return null;
  };

  // Compute total file count up front so we can emit accurate per-file
  // progress (94 → 99 distributed across all uploads).
  const variantEntries = Object.entries(variants || {}).filter(([, info]) => info?.path);
  const shortsToUpload = (shorts || []).filter((s) => s?.path);
  const totalFiles = variantEntries.length + shortsToUpload.length + 1; // +1 thumbnail
  let filesDone = 0;
  const tickProgress = (label) => {
    filesDone += 1;
    onProgress?.({
      phase: `Uploaded ${filesDone}/${totalFiles} — ${label}`,
      fileLabel: label,
      fraction: filesDone / totalFiles
    });
  };

  // Upload format variants (vertical / square / wide) — per-variant isolation.
  // If wide upload fails, vertical and square still ship. The vertical is
  // the primary deliverable; if even that fails, the response will reflect it.
  const uploadedFormats = {};
  for (const [variantKey, info] of variantEntries) {
    const filename = VARIANT_FILENAMES[variantKey] || `${variantKey}.mp4`;
    const storagePath = `${basePath}/${filename}`;
    const mp4Url = await uploadOneFile(storagePath, info.path, "video/mp4", `${variantKey} variant`);
    if (mp4Url) {
      uploadedFormats[variantKey] = {
        mp4Url,
        storagePath,
        dimensions: info.dimensions || null
      };
    }
    tickProgress(`${variantKey} variant`);
  }

  // Upload social shorts — per-short isolation. Worst case we ship 1 of 3
  // rather than zero of three.
  const uploadedShorts = [];
  for (const short of shortsToUpload) {
    const storagePath = `${basePath}/short-${short.clipNumber}.mp4`;
    const mp4Url = await uploadOneFile(storagePath, short.path, "video/mp4", `short ${short.clipNumber}`);
    if (mp4Url) {
      uploadedShorts.push({
        clipNumber: short.clipNumber,
        mp4Url,
        storagePath,
        durationSec: short.durationSec,
        sourceSceneOrder: short.sourceSceneOrder,
        roomType: short.roomType
      });
    }
    // Free the local file regardless of upload outcome.
    await fs.unlink(short.path).catch(() => {});
    tickProgress(`hero short ${short.clipNumber}`);
  }

  // Thumbnail — non-fatal if it fails.
  const thumbnailStoragePath = `${basePath}/thumbnail.png`;
  const thumbnailUrl = await uploadOneFile(thumbnailStoragePath, thumbnailPath, "image/png", "thumbnail");
  if (!thumbnailUrl) {
    console.warn("[upload] thumbnail upload failed; agents will see a black poster image. Render still ships.");
  }
  tickProgress("thumbnail");

  // Free the derived format files (the master is owned by the caller and may
  // still be needed for cleanup).
  for (const [variantKey, info] of Object.entries(variants || {})) {
    if (variantKey === "vertical") continue; // master stays — caller cleans up
    if (info?.path) await fs.unlink(info.path).catch(() => {});
  }

  return {
    storageSkipped: false,
    formats: uploadedFormats,
    socialShorts: uploadedShorts,
    thumbnailUrl,
    thumbnailStoragePath
  };
}

/* =================================================================
   Helpers
   ================================================================= */

function validateRunwayManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
    throw new Error("Runway render manifest must include scenes.");
  }
  const photos = manifest.orderedPhotos || [];
  if (!photos.length) throw new Error("Runway render manifest must include orderedPhotos.");

  const photosById = new Map(photos.map((p) => [p.id, p]));
  for (const scene of manifest.scenes) {
    const type = String(scene.type || "photo").toLowerCase();
    if (NON_PHOTO_TYPES.has(type)) continue;
    if (!scene.photoId) throw new Error(`Runway scene missing photoId.`);
    if (!photosById.has(scene.photoId)) throw new Error(`Runway scene ${scene.photoId} not in orderedPhotos.`);
    const photo = photosById.get(scene.photoId);
    const imageUrl = pickImageUrl(scene, photo);
    if (!imageUrl) throw new Error(`Runway scene ${scene.photoId} missing durable image URL.`);
    if (String(imageUrl).startsWith("blob:") || String(imageUrl).startsWith("data:")) {
      throw new Error(`Scene ${scene.photoId} has browser-only URL (blob:/data:). Re-upload first.`);
    }
    // v26.9: this validator runs for BOTH the veo and runway paths (the job is
    // engine-agnostic now). The Veo per-scene generator uses veoPrompt, falls
    // back to runwayPrompt, and finally to a constrained prompt — so a scene is
    // valid as long as it has ANY prompt (and even none is recoverable). Only
    // hard-require a prompt; never demand the legacy runwayPrompt specifically.
    if (!scene.veoPrompt && !scene.veo_prompt && !scene.runwayPrompt && !scene.runway_prompt) {
      throw new Error(`Scene ${scene.photoId} has no motion prompt — regenerate the edit plan.`);
    }
  }
}

function pickImageUrl(scene, photo) {
  return (
    scene?.durableUrl ||
    scene?.durable_url ||
    scene?.publicUrl ||
    scene?.public_url ||
    scene?.imageUrl ||
    photo?.durableUrl ||
    photo?.durable_url ||
    photo?.publicUrl ||
    photo?.public_url ||
    photo?.imageUrl ||
    photo?.uri ||
    ""
  );
}

function ratioForRunway(ratio, model = "gen4_turbo") {
  // Runway expects WxH pixel pairs for image_to_video, not aspect strings.
  // Gen-3a Turbo and Gen-4 Turbo use slightly different pixel pairs.
  // Picking the right pair per model so the API doesn't reject the request.
  const value = String(ratio || "9:16").toLowerCase();
  const isGen4 = String(model || "").toLowerCase().includes("gen4");

  if (value === "16:9" || value === "wide") {
    return isGen4 ? "1280:720" : "1280:768";
  }
  if (value === "1:1" || value === "square") {
    return "960:960"; // both Gen-3 and Gen-4 accept this
  }
  // 9:16 default
  return isGen4 ? "720:1280" : "768:1280";
}

// Music selection — checks the bundled local files first, then falls back
// to env-var URLs, then nothing. Bundled files live at
// /render-worker/music/{slug}.mp3. See render-worker/music/README.md for
// the curated track recommendations and how to drop them in.
function pickMusicUrl(manifest) {
  // Resolve absolute paths for the bundled music directory.
  const musicDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "music");

  // 0. Music selector: if the manifest explicitly names a track filename
  //    (set by the webapp's MusicSelector component from the typed catalog),
  //    use exactly that file. Strip any leading path so a malicious or
  //    misformed payload can't escape the music dir.
  const explicitTrack = String(manifest?.musicTrack || "").trim();
  if (explicitTrack) {
    const safeName = path.basename(explicitTrack);
    const explicitPath = path.join(musicDir, safeName);
    if (existsSync(explicitPath)) return explicitPath;
    console.warn(`[music] manifest.musicTrack="${safeName}" not found on disk — falling back to style default.`);
  }

  // Determine which style "slot" this mood belongs to.
  const mood = String(manifest.musicMood || manifest.selectedStyle || "").toLowerCase();
  let slot;
  if (mood.includes("social") || mood.includes("upbeat") || mood.includes("modern") || mood.includes("viral")) {
    slot = "social";
  } else if (mood.includes("mls") || mood.includes("ambient") || mood.includes("clean")) {
    slot = "mls";
  } else if (mood.includes("investor") || mood.includes("minimal")) {
    slot = "investor";
  } else {
    slot = "luxury"; // default for "Cinematic Luxury" or unrecognized
  }

  // Per-style default filenames — all Pixabay Content License (verified
  // source). The webapp normally sends an explicit manifest.musicTrack
  // (handled above); this slot path only fires for legacy/empty manifests.
  const SLOT_DEFAULT_FILE = {
    luxury:   "luxury-poradovskyi.mp3",
    social:   "the_mountain-pop-490010.mp3",
    mls:      "jonasblakewood-corporate-background-524146.mp3", // v41.4: clatter-free bed (m25)
    investor: "the_mountain-corporate-455905.mp3"
  };

  // 1. Slot default local file.
  const slotPath = path.join(musicDir, SLOT_DEFAULT_FILE[slot] || SLOT_DEFAULT_FILE.luxury);
  if (existsSync(slotPath)) return slotPath;

  // 2. Ultimate local fallback: the verified luxury track (always bundled),
  //    so every render still gets music even if a slot file is missing.
  const fallbackPath = path.join(musicDir, "luxury-poradovskyi.mp3");
  if (existsSync(fallbackPath)) return fallbackPath;

  // 3. Env-var-configured URLs (legacy fallback path).
  const envSlotMap = {
    luxury: ["RUNWAY_MUSIC_LUXURY_URL", "MUSIC_LUXURY_URL"],
    social: ["RUNWAY_MUSIC_VIRAL_URL", "MUSIC_VIRAL_URL"],
    mls: ["RUNWAY_MUSIC_MLS_URL", "MUSIC_MLS_CLEAN_URL"],
    investor: ["RUNWAY_MUSIC_INVESTOR_URL", "MUSIC_INVESTOR_URL"]
  };
  for (const envName of envSlotMap[slot] || []) {
    if (process.env[envName]) return process.env[envName];
  }

  // 4. Last-resort default URL.
  return process.env.RUNWAY_MUSIC_DEFAULT_URL || "";
}

function runwayHeaders() {
  return {
    Authorization: `Bearer ${process.env.RUNWAY_API_KEY}`,
    "X-Runway-Version": RUNWAY_API_VERSION,
    "Content-Type": "application/json"
  };
}

// Submit a Runway image_to_video task with exponential-backoff retry on
// 429 (short-window rate limit) and 5xx (transient server error). Stops
// retrying immediately on a 429 that contains "daily" — that's a terminal
// quota error, retrying just wastes time and floods their logs.
//
// Backoff: 2s, 5s, 12s, 25s — total worst-case 44s before giving up. With
// concurrency=4 across 24 scenes, the per-minute rate-limit window
// usually clears within the first or second backoff cycle.
async function submitRunwayTaskWithRetry({ body, sceneIndex, maxAttempts = 5 }) {
  let lastResponse = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(`${RUNWAY_API_BASE}/image_to_video`, {
      method: "POST",
      headers: runwayHeaders(),
      body: JSON.stringify(body)
    });
    if (response.ok) return response;

    // Read body once so we can both inspect for "daily" and propagate it.
    const errBody = await response.clone().text().catch(() => "");
    const isDailyCap = response.status === 429 && /daily/i.test(errBody);
    const isShortRateLimit = response.status === 429 && !isDailyCap;
    const isTransientServerError = response.status >= 500 && response.status < 600;

    if (isDailyCap || (!isShortRateLimit && !isTransientServerError)) {
      // Terminal — no point retrying.
      return response;
    }

    lastResponse = response;
    if (attempt === maxAttempts - 1) break;

    const delayMs = Math.min(25000, 2000 * Math.pow(2.2, attempt));
    console.warn(`[runway] scene ${sceneIndex + 1} got ${response.status}, retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${maxAttempts})`);
    await sleep(delayMs);
  }
  return lastResponse;
}

async function safeText(response) {
  try { return await response.text(); } catch { return ""; }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function pMap(items, fn, { concurrency = 4 } = {}) {
  const results = new Array(items.length);
  let cursor = 0;
  const errors = [];
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (error) {
        errors.push({ index: i, error });
        throw error;
      }
    }
  });
  try {
    await Promise.all(workers);
  } catch {
    // Surface the first error with full context. Preserve the structured
    // error.code from the underlying call (e.g. RUNWAY_DAILY_CAP) so the
    // worker's status endpoint and the frontend can surface upgrade prompts
    // instead of a generic failure.
    const first = errors[0];
    const wrapped = new Error(first.error.message || `Runway scene ${first.index + 1} failed.`);
    wrapped.code = first.error.code;
    wrapped.httpStatus = first.error.httpStatus;
    throw wrapped;
  }
  return results;
}

function createJobId(manifest) {
  const projectId = manifest.project?.id || manifest.project?.title || "estate-motion";
  return `runway-${slug(projectId)}-${Date.now()}`;
}

function slug(value) {
  return String(value || "render").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "render";
}

/* =================================================================
   Hallucination Guard — content-aware Runway-vs-Ken-Burns routing
   =================================================================

   The user's repeated production-blocker has been kitchens: split
   countertops, phantom microwave doors, phantom ceiling fans, morphed
   cabinet faces. These failures happen because Gen-4 Turbo, when shown
   parallel-edge surfaces (cabinets, counters, tile grids, blinds) or
   reflective panels (granite, marble, glass, polished steel), tends to
   invent motion in them — splitting one edge into two, or "completing"
   a partial circle by adding a fan.

   The pre-existing protectHighRiskRooms toggle only matched the
   roomType field. That misses two failure modes:
     1. Misclassified kitchens (labeled "living" or "amenity") still run
        through Runway and still hallucinate.
     2. Living rooms with bookshelves or windows with shutters have the
        same parallel-edge failure profile but aren't covered.

   The Hallucination Guard fixes both by scoring each scene's risk based
   on roomType AND on the visibleFeatures list AND on the prompt itself.
*/

// Risk-additive keywords. Each match adds points to the scene's risk
// score. Higher score → more likely Runway invents motion.
const RISK_KEYWORDS = {
  // Parallel-edge surfaces — Runway's #1 failure mode (splits or duplicates).
  high: [
    "cabinet", "cabinetry", "countertop", "counter", "shelves", "shelf",
    "bookshelf", "bookcase", "blinds", "shutters", "slats", "louver",
    "tile", "grout", "grid", "mullion", "wainscot"
  ],
  // Appliances — frequently morphed (microwave door on fridge, etc).
  appliance: [
    "appliance", "appliances", "microwave", "fridge", "refrigerator",
    "freezer", "oven", "range", "stove", "cooktop", "dishwasher",
    "washer", "dryer", "hood", "vent", "vent hood", "sink", "faucet"
  ],
  // Round/spinning shapes — Runway hallucinates fans / pendant motion.
  rotational: [
    "fan", "ceiling fan", "blade", "blades", "pendant", "chandelier",
    "wheel", "spinner", "turbine", "propeller", "globe"
  ],
  // Reflective surfaces — Runway invents reflections that morph the room.
  reflective: [
    "granite", "marble", "quartz", "polished", "mirror", "mirrors",
    "glass", "stainless", "chrome", "lacquer"
  ],
  // Text or signage — frequently mangled into gibberish.
  text: [
    "sign", "logo", "label", "text", "writing", "lettering", "menu",
    "address", "number", "license plate"
  ]
};

// Per-room baseline risk. Picked from observed failure rates over
// hundreds of test renders. Kitchen is intentionally pinned at 80 so a
// kitchen with ANY appliance feature crosses the "balanced" threshold (60).
const ROOM_BASE_RISK = {
  kitchen: 80,
  bathroom: 60,
  bedroom: 25,
  living: 20,
  detail: 15,
  amenity: 10,
  exterior: 8,
  outdoor: 5
};

// Resolve hallucinationGuard from manifest, with backwards-compat for the
// legacy protectHighRiskRooms boolean.
function resolveGuardLevel(manifest) {
  const raw = String(manifest?.hallucinationGuard || "").toLowerCase();
  if (["off", "balanced", "strict"].includes(raw)) return raw;
  // Legacy: protectHighRiskRooms true → balanced, false → off.
  // (Default for new clients: "balanced" — see the next line.)
  if (manifest?.protectHighRiskRooms === false) return "off";
  if (manifest?.protectHighRiskRooms === true) return "balanced";
  // Default when neither is specified: balanced. This is the new production
  // default — Runway hallucinations were the #1 quality complaint.
  return "balanced";
}

// Decide whether a given scene should go through Runway or Ken Burns,
// returning the risk score and a human-readable reason for logging.
function decideUseKenBurns(scene, guardLevel) {
  if (guardLevel === "off") {
    return { useKenBurns: false, risk: 0, reason: "guard off" };
  }
  const risk = computeHallucinationRisk(scene);
  const room = String(scene?.roomType || "").toLowerCase();

  // v27 AUDIT FIX: rotational objects (ceiling fans, chandeliers, pendants) are
  // the single most damaging hallucination — they SPIN or morph. ANY scene
  // whose photo contains one is forced safe regardless of score. On the Veo
  // path this maps to the CONSTRAINED "nothing moves" prompt; legacy Runway,
  // Ken Burns.
  //
  // v31 SMOKE-TEST FIX: scan ONLY visibleFeatures (the vision model's
  // observations of the photo). The old blob included the PROMPTS — and every
  // prompt ends with the universal constraint clause ("NO NEW CEILING FANS…
  // NO fan blades"), so the guard read its own prohibition text, matched
  // "fan", and forced 100% of scenes onto the flat constrained prompt on
  // every render since v27. The styled cinematic prompts never ran.
  const riskBlob = (Array.isArray(scene?.visibleFeatures) ? scene.visibleFeatures.join(" ") : "").toLowerCase();
  if (RISK_KEYWORDS.rotational.some((kw) => riskBlob.includes(kw))) {
    return { useKenBurns: true, risk, reason: `rotational object (fan/pendant) → constrained (risk ${risk})` };
  }

  // STRICT: lock all kitchens regardless of features. Aggressive lower threshold.
  if (guardLevel === "strict") {
    if (room === "kitchen") {
      return { useKenBurns: true, risk, reason: "strict: all kitchens locked" };
    }
    if (risk >= 35) {
      return { useKenBurns: true, risk, reason: `strict: risk≥35 (${risk})` };
    }
  }

  // v24.5: dramatically softened balanced default. Troy's user-test
  // hit 6/8 KB on a normal 8-photo listing — way too many. The new
  // contract for BALANCED:
  //   - Kitchens: ALWAYS fall back. The morphed-appliance failure is
  //     the most common AND most damaging hallucination on real estate
  //     content. Cost of falling back: one Ken Burns scene. Cost of
  //     Runway-on-kitchen: agent loses a listing because the fridge
  //     has the wrong door count.
  //   - Bathrooms: fall back ONLY at risk ≥85 (was ≥60). Most
  //     bathrooms render fine on Runway; only the heavy-mirror,
  //     heavy-tile shots are risky.
  //   - Everything else: fall back ONLY at risk ≥90 (was ≥80). Effectively
  //     never trips on a normal listing — would need multi-category
  //     keyword stacking PLUS aggressive motion. The goal is at most
  //     ONE fallback per typical listing (the kitchen).
  // v60.7: the kitchen-always + v49 constrained-first blocks below are
  // VEO floor-rate policy (541 Veo scenes, Jul 17). Kling is a different
  // animal: it went 15/15 on the hard set (audit-selected VEO failures,
  // kitchens included) and obeys restraint language literally — on the
  // fdc8e72 canary the constrained-first rooms ran at HALF the motion of
  // planned prompts (1.22-1.28 vs 2.4-3.4 YDIF) for zero fidelity gain
  // (QC passed 9/9 either way). On Kling, planned prompts run first;
  // the rotational-object lock, strict mode, risk≥90, complianceMode,
  // and QC-fail constrained RETRIES all remain in force.
  const klingEngine = String(process.env.FAL_VIDEO_MODEL || "").toLowerCase().includes("kling");
  if (!klingEngine && room === "kitchen") {
    return { useKenBurns: true, risk, reason: `kitchen always falls back (risk ${risk})` };
  }
  // v49 FLOOR-RATE DATA (Jul 17 2026, 541 scenes / 14 days of production):
  // bathrooms floored 32%, bedrooms 26.7%, amenity 33% — versus kitchens at
  // 7.7% under always-constrained. The old bathroom risk≥85 threshold almost
  // never tripped (base 60 needs +25 in keyword bumps), so mirror/glass/
  // textile rooms ran BOLD on attempt 1, burned the QC ladder, and floored
  // 4× more than the room the policy protects. Constrained-first is cheaper
  // (fewer retries), faster, and ships MORE real Veo motion, not less —
  // kitchens are the proof. Bedrooms earn it for patterned bedding/artwork
  // (the m48 "morphing pillows" class); amenity for gym/pool-room mirrors.
  if (!klingEngine && (room === "bathroom" || room === "bedroom" || room === "amenity")) {
    return { useKenBurns: true, risk, reason: `${room} constrained-first (v49 floor-rate data; risk ${risk})` };
  }
  if (risk >= 90) {
    return { useKenBurns: true, risk, reason: `risk≥90 (${risk}, ${room || "unknown"})` };
  }

  return { useKenBurns: false, risk, reason: `risk ${risk} below threshold` };
}

// Compute a 0-100 risk score for a single scene based on its room + features
// + prompt. Higher = more likely Runway hallucinates. Bounded so a perfectly
// safe exterior never crosses thresholds and a kitchen with multiple risk
// keywords saturates well above the "strict" threshold.
function computeHallucinationRisk(scene) {
  const room = String(scene?.roomType || "").toLowerCase();
  let score = ROOM_BASE_RISK[room] ?? 15;

  // v31 SMOKE-TEST FIX: score ONLY visibleFeatures. The blob used to include
  // runwayPrompt, whose appended universal constraint clause names fans,
  // fridges, signs, and text — inflating every scene's score ~+30 with
  // keywords from our own prohibition sentences rather than the photo.
  const blob = (Array.isArray(scene?.visibleFeatures) ? scene.visibleFeatures.join(" ") : "").toLowerCase();

  // v24.3: halved per-category bumps so non-kitchen/bath scenes rarely
  // hit the 80 threshold. Previous values (25/20/30/15/10) sent a
  // bedroom-with-ceiling-fan to 55 (25 base + 30 rotational), and
  // adding parallax motion (+8) tipped many scenes to KB unnecessarily.
  // New values let normal scenes pass; only multi-category-stacking
  // worst-cases (e.g. living + cabinet + appliance + reflective +
  // rotational) hit 80.
  if (RISK_KEYWORDS.high.some((kw) => blob.includes(kw))) score += 12;
  if (RISK_KEYWORDS.appliance.some((kw) => blob.includes(kw))) score += 10;
  if (RISK_KEYWORDS.rotational.some((kw) => blob.includes(kw))) score += 15;
  if (RISK_KEYWORDS.reflective.some((kw) => blob.includes(kw))) score += 8;
  if (RISK_KEYWORDS.text.some((kw) => blob.includes(kw))) score += 5;

  // Camera motion modulation — parallax/lateral_pan add risk because they
  // sweep across more pixels, giving Runway more surface area to invent on.
  const motion = String(scene?.cameraMotion || "").toLowerCase();
  if (motion === "parallax_zoom" || motion === "lateral_pan") score += 4;
  if (motion === "detail_sweep") score += 3;

  // Long clips are riskier — more frames = more chances to drift.
  const duration = Number(scene?.duration || 5);
  if (duration > 5.5) score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}
