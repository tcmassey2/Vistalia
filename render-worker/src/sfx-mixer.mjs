// EstateMotion — Transition SFX mixer (v23).
//
// Layers transition sound effects onto the master MP4's audio bus at scene
// boundaries. Per-scene SFX is selected from the bundled library based on
// the scene's transition type and the active style pack.
//
// This step runs AFTER applyVoiceNarration so SFX sits on top of the
// already-mixed (music + narration) audio. SFX is mixed at -18dB so it's
// audible against music+voice without competing with the narrator.
//
// Bundled SFX library (render-worker/sfx/):
//   whoosh-1.mp3   — 0.4s bandpass swell, used on whip_pan
//   whoosh-2.mp3   — 0.4s lower variant, alternates with whoosh-1
//   impact-1.mp3   — 0.35s low thud + filtered burst, used on match_cut
//   impact-2.mp3   — 0.18s mid-frequency tap, used on blur_wipe
//   riser.mp3      — 1.2s ascending build, used on light_leak / before outro
//   pop.mp3        — 0.12s bright tap, used on slide/wipe and MLS Clean default
//
// To upgrade: replace the .mp3 files with curated samples from
// Soundsnap / Splice / Epidemic Sound. Filenames must stay the same.
//
// Failure mode: any error here is fail-soft. The original master is
// returned untouched and the render still ships.

import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { runFFmpeg } from "./ffmpeg-runner.mjs";
import { shouldMixTransitionSfx } from "./legacy-mode.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SFX_DIR = path.resolve(__dirname, "..", "sfx");

// SFX volume relative to existing audio bus.
// -18dB is gentle enough that it doesn't fight narration but loud enough
// to be perceived. ffmpeg amix weights are linear (not dB), so
// 10^(-18/20) ≈ 0.126.
const SFX_WEIGHT = 0.126;

// Slight delay so the SFX hits ON the visual cut, not before. Most cuts
// have ~50-80ms of motion before "landing" — SFX hits at 60ms in.
const SFX_LEAD_MS = 60;

// Scene-transition → SFX file mapping. Some transitions get an alternation
// pattern so consecutive scenes don't sound identical.
const TRANSITION_SFX_MAP = {
  whip_pan: ["whoosh-1.mp3", "whoosh-2.mp3"],
  match_cut: ["impact-1.mp3"],
  light_leak: ["riser.mp3"],
  blur_wipe: ["impact-2.mp3"],
  slide: ["pop.mp3"],
  wipe: ["pop.mp3"]
};

// Style-pack default: when a scene's transition isn't mapped (or no
// transition was set), fall back to the style pack's default SFX. MLS
// Clean uses pop (subtle); Luxury/Investor use impact-2 (gentle); Viral
// uses whoosh-1 (energetic).
const STYLE_DEFAULT_SFX = {
  luxury: "impact-2.mp3",
  viral: "whoosh-1.mp3",
  mls: "pop.mp3",
  "mls-clean": "pop.mp3",
  "mls clean": "pop.mp3",
  investor: "impact-2.mp3"
};

/* ============================================================
   Public entry: applyTransitionSfx
   ============================================================
   Inputs:
     masterMp4   — current master MP4 path (post-narration, ideally)
     scenes      — manifest.scenes array (used to determine transitions + durations)
     tempDir     — temp directory for intermediate files
     jobId       — used in output filename
     manifest    — for resolving the style pack default SFX
     onProgress  — optional callback for phase updates
   Returns:
     { masterMp4, applied: bool, reason?: string, sfxCount?: number }
*/
export async function applyTransitionSfx({ masterMp4, scenes, tempDir, jobId, manifest, onProgress, preRollSeconds = 0 }) {
  // V23 kill switch: when LEGACY_RENDER_MODE=true, ship without SFX bus.
  // Pre-v23 renders had no transition SFX — bring that behavior back.
  if (!shouldMixTransitionSfx()) {
    return { masterMp4, applied: false, reason: "legacy_render_mode" };
  }
  if (manifest?.skipTransitionSfx) {
    return { masterMp4, applied: false, reason: "manifest.skipTransitionSfx=true" };
  }

  const photoScenes = (scenes || []).filter((s) => String(s.type || "photo").toLowerCase() === "photo");
  if (photoScenes.length === 0) {
    return { masterMp4, applied: false, reason: "no_photo_scenes" };
  }

  const styleSlug = String(
    manifest?.selectedStyle || manifest?.template?.style || "luxury"
  ).trim().toLowerCase();
  const styleDefault = STYLE_DEFAULT_SFX[styleSlug] || STYLE_DEFAULT_SFX.luxury;

  // Compute scene start times. SFX plays at the BOUNDARY between scenes,
  // so we want the timestamp at which scene N starts (transitioning IN
  // from scene N-1). The very first scene gets no SFX (no inbound
  // transition) unless we add a riser before the address card later.
  const sceneStarts = [];
  // v23: preRollSeconds shifts every scene-start forward by the duration of
  // the address opener card (3.5s) that sits before scene 1 in the master.
  let cursor = preRollSeconds;
  for (const sc of photoScenes) {
    sceneStarts.push(cursor);
    cursor += Number(sc.duration || 3);
  }
  const totalDurationSec = cursor;

  // Build SFX placements (skip first scene — no inbound transition).
  const placements = [];
  let altCursor = 0; // for alternating between whoosh-1 / whoosh-2 etc.
  for (let i = 1; i < photoScenes.length; i++) {
    const transition = String(photoScenes[i].transition || "").toLowerCase().replace(/[^a-z_]/g, "");
    const candidates = TRANSITION_SFX_MAP[transition] || [styleDefault];
    const sfxFile = candidates[altCursor % candidates.length];
    altCursor++;

    const sfxPath = path.join(SFX_DIR, sfxFile);
    if (!existsSync(sfxPath)) {
      // Missing SFX file — skip this scene's SFX but keep going.
      console.warn(`[sfx] ${sfxFile} missing on disk — skipping scene ${i + 1} SFX`);
      continue;
    }
    placements.push({
      sfxPath,
      sfxFile,
      delayMs: Math.round(sceneStarts[i] * 1000) + SFX_LEAD_MS,
      sceneIndex: i
    });
  }

  if (placements.length === 0) {
    return { masterMp4, applied: false, reason: "no_sfx_to_place" };
  }

  onProgress?.({ phase: `Adding transition SFX (${placements.length})`, fraction: 0.3 });

  // Detect whether master already has audio. If not, this whole step is
  // basically synthesizing audio from scratch, which is unusual but
  // technically supported — SFX-only master.
  const masterHasAudio = await detectAudioStream(masterMp4);

  // ============================================================
  // Build single SFX track via adelay (same pattern as voice-mixer)
  // ============================================================
  const adelaySteps = placements
    .map((p, i) => `[${i + 1}:a]adelay=${p.delayMs}|${p.delayMs},apad[s${i}]`)
    .join(";");
  const mixInputs = placements.map((_, i) => `[s${i}]`).join("");
  const sfxFilter =
    `${adelaySteps};` +
    `[0:a]${mixInputs}amix=inputs=${placements.length + 1}:duration=first:dropout_transition=0,` +
    `atrim=duration=${totalDurationSec}[sfx]`;

  const sfxTrackPath = path.join(tempDir, `${jobId}-sfx-track.mp3`);
  const sfxTrackArgs = [
    "-y",
    "-threads", "1",
    "-f", "lavfi",
    "-i", `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${totalDurationSec}`,
    ...placements.flatMap((p) => ["-i", p.sfxPath]),
    "-filter_complex", sfxFilter,
    "-map", "[sfx]",
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    "-t", String(totalDurationSec),
    sfxTrackPath
  ];
  await runFFmpeg(sfxTrackArgs, { timeoutMs: 90000, label: "sfx:adelay-mix" });

  // ============================================================
  // Final mix: master video audio + SFX track at SFX_WEIGHT
  // ============================================================
  onProgress?.({ phase: "Mixing SFX into master", fraction: 0.8 });
  const outPath = path.join(tempDir, `${jobId}-sfx.mp4`);

  if (masterHasAudio) {
    await runFFmpeg([
      "-y",
      "-threads", "1",
      "-i", masterMp4,
      "-i", sfxTrackPath,
      "-filter_complex",
      `[0:a:0][1:a]amix=inputs=2:duration=first:dropout_transition=0:weights=1.0 ${SFX_WEIGHT.toFixed(3)}[aout]`,
      "-map", "0:v:0",
      "-map", "[aout]",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      outPath
    ], { timeoutMs: 90000, label: "sfx:final-mix" });
  } else {
    await runFFmpeg([
      "-y",
      "-threads", "1",
      "-i", masterMp4,
      "-i", sfxTrackPath,
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-shortest",
      outPath
    ], { timeoutMs: 60000, label: "sfx:final-mix-sfx-only" });
  }

  await fs.unlink(sfxTrackPath).catch(() => {});

  return {
    masterMp4: outPath,
    applied: true,
    sfxCount: placements.length,
    placements: placements.map((p) => ({ sceneIndex: p.sceneIndex, sfxFile: p.sfxFile }))
  };
}

// Local copy of detectAudioStream — keeps this module self-contained
// without a circular dep on voice-mixer.mjs.
async function detectAudioStream(filePath) {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=codec_name",
      "-of", "default=nw=1:nk=1",
      filePath
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.on("close", () => resolve(Boolean(stdout.trim())));
    proc.on("error", () => resolve(false));
  });
}
