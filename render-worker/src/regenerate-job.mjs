// Vistalia — Per-scene STEADY-SHOT replacement (v62.38).
//
// The old regen re-generated one clip with AI and then rebuilt the entire
// soundtrack from the legacy per-scene-lines machinery — because the
// voice-first stem was never persisted, "fix one wobbling scene" silently
// replaced the whole video's voice with a different, stiffer read of
// different sentences, and (post-v62.36) laid a pre-trim narration timeline
// over a post-trim video. Six audited defects, one root cause: regen tried
// to rebuild audio it could instead leave alone.
//
// The v62.38 contract inverts it. The replacement clip is a DETERMINISTIC
// steady shot (the same homography-drift floor the QC ladder ships) rendered
// at the MEASURED duration of the clip it replaces — so the rebuilt video's
// timeline is identical to the original's, and the original master's audio
// stream remuxes onto it byte-for-byte. The voice, music, and ducking are
// untouched by construction, not by care. Captions are re-burned from the
// captions.ass the render persisted (v62.38 main-flow change).
//
//   1. Audit row → scene list (post-trim truth), clip URLs, master URL
//   2. Download the master (audio + length reference), ALL N clips, and
//      captions.ass (404 + captions-on original ⇒ refuse: pre-v62.38 render)
//   3. ffprobe the target clip → exact duration; render the steady shot at it
//   4. Restitch: N−1 clips preNormalized (grade/card/watermark already
//      burned — normalize now skips them), the new clip normalized fresh
//   5. ASSERT the rebuilt video's length matches the original master's —
//      refuse and change nothing on mismatch (the customer can never end
//      up worse than they started)
//   6. Burn captions.ass + mux the ORIGINAL audio in one pass
//   7. Trial renders: re-apply the free-render mark (dual-master, same as
//      the main flow) — the clean master refreshes too, so a regen followed
//      by the instant unlock serves the FIXED video, not the pre-regen one
//   8. Upload master (+clean), thumbnail, per-scene clips; patch audit row
//
// Deterministic replacement means: no QC needed (the floor cannot
// hallucinate — that is its contract), no fal spend, no ElevenLabs spend.
// mode is accepted for backward compatibility and ignored — every
// replacement is a steady shot now.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import {
  generateKenBurnsFallback,
  stitchClipsAndOverlays,
  uploadPerSceneClips,
  uploadDeliverables,
  buildTrialMarkArgs,
  ENCODE_PRESET,
  ENCODE_CRF_MASTER
} from "./runway-job.mjs";
import { runFFmpeg, ENCODE_THREADS } from "./ffmpeg-runner.mjs";
import { subtitlesFilterPath, CAPTIONS_FONTS_DIR } from "./captions.mjs";
import { readRenderAudit, updateRenderAudit } from "./audit-log.mjs";

// The rebuilt timeline must equal the original's. The stitch is
// deterministic and metadata-driven, and the replacement is rendered at the
// same metadata the original stitch used — so the reproduction is exact to
// container framing. Anything past ~a frame means an input genuinely
// changed: refuse rather than desync the remuxed audio. (Adversarial
// review proved the first cut's 0.35s tolerance was 10.5 frames wide, and
// -shortest quietly deleted that much of the customer's final word.)
const LENGTH_TOLERANCE_SEC = 0.06;

export async function regenerateScene(body, options = {}) {
  const { jobId, sceneIndex, manifest } = body || {};
  if (!jobId) throw new Error("regenerateScene: jobId required.");
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0) {
    throw new Error("regenerateScene: sceneIndex (non-negative integer) required.");
  }
  if (!manifest) throw new Error("regenerateScene: manifest required.");

  options.onProgress?.({ phase: "Looking up original render", progress: 4 });

  const auditRow = await readRenderAudit(jobId);
  if (!auditRow) {
    throw new Error(
      `Audit row not found for jobId ${jobId}. Scene replacement only works on renders made with worker v16+ — older renders need a full re-render.`
    );
  }
  const originalScenes = Array.isArray(auditRow.scenes) ? auditRow.scenes : [];
  if (!originalScenes.length) {
    throw new Error(`Audit row for ${jobId} has no scenes array. Re-render this listing once to enable scene replacement.`);
  }
  const targetScene = originalScenes.find((s) => Number(s.sceneIndex) === Number(sceneIndex));
  if (!targetScene) throw new Error(`Scene ${sceneIndex} is not in the audit row for ${jobId}.`);

  // v62.39: only the OTHER N−1 clips are load-bearing — they get stitched.
  // The TARGET's stored clip is a cross-check measurement at most (the
  // replacement renders at the AUDIT duration, the timeline's author), and
  // the scene most likely to NEED replacing is precisely the one whose
  // upload was flaky: the Jul 27 smoke test's scene 1 stalled at fal,
  // retried constrained, AND lost its clip upload — the old all-clips rule
  // would have locked replacement for the whole video over it.
  const missing = originalScenes.filter(
    (s) => Number(s.sceneIndex) !== Number(sceneIndex) && !s.clipUrl
  );
  if (missing.length) {
    const indexes = missing.map((s) => s.sceneIndex).join(", ");
    throw new Error(
      `Cannot replace — scenes ${indexes} have no persisted clipUrl in the audit row. Run a full re-render once to enable scene replacement.`
    );
  }
  const masterUrl = auditRow.master_mp4_url || "";
  if (!masterUrl) {
    throw new Error(`Audit row for ${jobId} has no master URL — the original audio cannot be preserved. Re-render this listing.`);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "estatemotion-regen-"));
  try {
    return await rebuildWithSteadyScene({
      jobId, sceneIndex, manifest, auditRow, originalScenes, targetScene, masterUrl, tempDir, options
    });
  } finally {
    // Success or failure, the workspace goes. Uploads happen before this.
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function rebuildWithSteadyScene({ jobId, sceneIndex, manifest, auditRow, originalScenes, targetScene, masterUrl, tempDir, options }) {
  // ── Captions: the master's captions live in its PIXELS, so a video-only
  // rebuild must re-burn them. v62.38 renders persist captions.ass next to
  // master.mp4; its URL is derived, not stored.
  const captionsUrl = masterUrl.replace(/master\.mp4(\?.*)?$/i, "captions.ass");
  let assPath = null;
  if (captionsUrl !== masterUrl) {
    const candidate = path.join(tempDir, "captions.ass");
    const got = await downloadFile(captionsUrl, candidate).then(() => true).catch(() => false);
    if (got) {
      // Guard against a storage 404 page saved as a "file".
      const head = (await fs.readFile(candidate, "utf8").catch(() => "")).slice(0, 64);
      if (/\[Script Info\]/i.test(head)) assPath = candidate;
    }
  }
  if (!assPath && manifest?.captionsEnabled !== false) {
    // The original very likely has captions burned in and we cannot
    // reproduce them. Shipping a captionless replacement master would be a
    // silent downgrade — refuse with a path forward instead.
    const err = new Error(
      "This video was rendered before scene replacement shipped (no caption track was persisted). " +
      "Re-render the listing once — every new render supports scene replacement."
    );
    err.code = "REGEN_PREDATES_CAPTION_ARTIFACT";
    throw err;
  }

  // ── Pull the original master (audio + length reference) and all N clips.
  options.onProgress?.({ phase: "Loading original render", progress: 8 });
  const originalMasterPath = path.join(tempDir, "original-master.mp4");
  await downloadFile(masterUrl, originalMasterPath);
  const originalLen = await probeDurationSec(originalMasterPath);
  if (!Number.isFinite(originalLen) || originalLen <= 0) {
    throw new Error("Could not measure the original master — refusing to rebuild against an unknown length.");
  }

  // The N−1 others are REQUIRED (pMap throws on any failure); the target is
  // best-effort — it only feeds the cross-check measurement below.
  const otherScenes = originalScenes.filter((s) => Number(s.sceneIndex) !== Number(sceneIndex));
  const downloadConcurrency = Math.min(6, otherScenes.length || 1);
  const downloaded = await pMap(otherScenes, async (s) => {
    const localPath = path.join(tempDir, `clip-${String(s.sceneIndex).padStart(3, "0")}.mp4`);
    await downloadFile(s.clipUrl, localPath);
    return { scene: s, localPath };
  }, { concurrency: downloadConcurrency });

  // ── The replacement speaks METADATA, not measurement. The original
  // stitch computed its xfade offsets from the audit row's duration values;
  // to reproduce that timeline exactly, the steady shot must be rendered at
  // the SAME value — even if the stored file secretly diverges from it
  // (the documented pre-v62 Kling short-delivery class). Adversarial
  // review proved the measurement-driven version re-authored a DIFFERENT
  // timeline for exactly those renders, slid the drift under the old
  // tolerance, and cost real voiceover bytes. Measurement demotes to a
  // cross-check log.
  const auditDuration = Number(targetScene.durationSec || targetScene.duration || 5);
  let measured = NaN;
  if (targetScene.clipUrl) {
    const targetPath = path.join(tempDir, `clip-target-${String(sceneIndex).padStart(3, "0")}.mp4`);
    const got = await downloadFile(targetScene.clipUrl, targetPath).then(() => true).catch(() => false);
    if (got) measured = await probeDurationSec(targetPath);
  } else {
    console.info(`[regen] scene ${sceneIndex + 1} has no stored clip (its original upload failed) — skipping the duration cross-check; the audit value governs regardless.`);
  }
  if (Number.isFinite(measured) && Math.abs(measured - auditDuration) > 0.1) {
    console.warn(
      `[regen] scene ${sceneIndex + 1}: stored clip measures ${measured.toFixed(3)}s but the audit row says ` +
      `${auditDuration.toFixed(3)}s — rebuilding at the audit value (the timeline's author). If the length gate ` +
      `refuses below, this render's metadata never matched its media.`
    );
  }
  console.info(`[regen] scene ${sceneIndex + 1}: replacing a ${auditDuration.toFixed(3)}s slot with a steady shot of the same length.`);

  options.onProgress?.({ phase: "Rendering steady replacement", progress: 22 });
  const sceneForFloor = buildSceneForRegen(targetScene, manifest);
  const replacementClip = await generateKenBurnsFallback(sceneForFloor, manifest, tempDir, sceneIndex, {
    durationSec: auditDuration
  });
  // Trust the floor's RETURNED duration (it clamps to [1.6,10]); if the
  // clamp ever bites, metadata and file agree with each other and the
  // length gate below decides honestly.
  replacementClip.duration = Number(replacementClip.duration) || auditDuration;
  replacementClip.preNormalized = false; // fresh clip: gets grade/card/watermark in normalize

  const clipResults = [
    ...downloaded // already the N−1 others (v62.39)
      .map((d) => ({
        sceneIndex: Number(d.scene.sceneIndex),
        photoId: d.scene.photoId || "",
        clipPath: d.localPath,
        duration: Number(d.scene.durationSec || d.scene.duration || 5),
        transition: "crossfade",
        overlay: null,
        runwayTaskId: null,
        fallback: Boolean(d.scene.wasFallback),
        preNormalized: true, // grade/card/watermark already burned — normalize skips them (v62.38)
        roomType: d.scene.roomType || "",
        cameraMotion: d.scene.cameraMotion || "",
        runwayPrompt: d.scene.runwayPrompt || "",
        // Carry QC provenance THROUGH the regen — uploadPerSceneClips
        // rebuilds the audit scene entries from these objects, and dropping
        // the fields rewrote every untouched scene's history (sweepReplaced
        // → false, fallbackReason → null) on each regen.
        usedPhotoMotionFloor: d.scene.engineUsed === "photo_motion",
        floorReason: d.scene.fallbackReason || null,
        attemptsUsed: Number.isFinite(d.scene.attempts) ? d.scene.attempts : undefined,
        sweepReplaced: Boolean(d.scene.sweepReplaced)
      })),
    replacementClip
  ].sort((a, b) => a.sceneIndex - b.sceneIndex);

  // ── Restitch, video-only (skipMusic: the original audio is the audio).
  options.onProgress?.({ phase: "Rebuilding video", progress: 40 });
  const silentStitched = path.join(tempDir, `${jobId}-restitch.mp4`);
  const thumbnailPath = path.join(tempDir, `${jobId}.png`);
  const { normalizedClips } = await stitchClipsAndOverlays(
    clipResults,
    { ...manifest, skipMusic: true },
    silentStitched,
    thumbnailPath,
    {
      onProgress: (patch) => {
        const inner = patch?.progress || 76;
        const mapped = 40 + Math.min(30, Math.max(0, Math.round(((inner - 76) / 5) * 30)));
        options.onProgress?.({ phase: patch?.phase || "Rebuilding video", progress: mapped });
      }
    }
  );

  // ── THE CONTRACT: same timeline or no deal.
  const rebuiltLen = await probeDurationSec(silentStitched);
  if (!Number.isFinite(rebuiltLen) || Math.abs(rebuiltLen - originalLen) > LENGTH_TOLERANCE_SEC) {
    throw new Error(
      `Rebuilt video is ${Number.isFinite(rebuiltLen) ? rebuiltLen.toFixed(2) : "?"}s vs the original ${originalLen.toFixed(2)}s ` +
      `— refusing to remux the original audio onto a drifted timeline. The original render is untouched.`
    );
  }

  // ── Captions + original audio, one pass. Without captions the video
  // stream copies untouched (zero generation loss). NO -shortest: within
  // the (sub-frame) tolerance the residue must PAD, never truncate —
  // adversarial review measured -shortest deleting the voiceover's entire
  // final word inside the old tolerance. The audio maps whole; a video
  // ending a frame early just holds its last frame.
  options.onProgress?.({ phase: "Restoring voiceover", progress: 74 });
  const cleanMaster = path.join(tempDir, `${jobId}-clean.mp4`);
  const vfArgs = assPath
    ? ["-vf", `subtitles='${subtitlesFilterPath(assPath)}':fontsdir='${subtitlesFilterPath(CAPTIONS_FONTS_DIR)}'`,
       "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", ENCODE_PRESET, "-crf", ENCODE_CRF_MASTER]
    : ["-c:v", "copy"];
  await runFFmpeg([
    "-y", "-threads", ENCODE_THREADS,
    "-i", silentStitched,
    "-i", originalMasterPath,
    "-map", "0:v:0", "-map", "1:a:0?",
    ...vfArgs,
    "-c:a", "copy",
    cleanMaster
  ], { timeoutMs: assPath ? 240000 : 90000, label: "regen:caption-burn+audio-mux" });

  // ── PROVE the audio survived whole. The stream copy plus no -shortest
  // makes truncation impossible in theory; this makes it impossible in
  // practice. (The class this catches: any future edit that reintroduces
  // -shortest or re-encodes the audio.)
  const originalAudioSec = await probeAudioDurationSec(originalMasterPath);
  const outputAudioSec = await probeAudioDurationSec(cleanMaster);
  if (Number.isFinite(originalAudioSec) && Number.isFinite(outputAudioSec) &&
      Math.abs(outputAudioSec - originalAudioSec) > 0.06) {
    throw new Error(
      `Rebuilt master's audio is ${outputAudioSec.toFixed(3)}s vs the original ${originalAudioSec.toFixed(3)}s ` +
      `— the voiceover was not preserved intact. The original render is untouched.`
    );
  }

  // ── Trial mark (dual-master, mirrors the main flow). Fixes both audited
  // money bugs at once: a trial regen ships MARKED again (no more watermark
  // laundering), and clean.mp4 refreshes so a post-regen unlock serves the
  // fixed video.
  const masterDims = regenDims(manifest);
  let deliverablePath = cleanMaster;
  let includeClean = Boolean(auditRow.master_clean_url);
  if (manifest.freeRenderWatermark) {
    const markedPath = path.join(tempDir, `${jobId}-marked.mp4`);
    await runFFmpeg(
      buildTrialMarkArgs(cleanMaster, masterDims, markedPath),
      { timeoutMs: 240000, label: "regen:trial-mark" }
    );
    deliverablePath = markedPath;
    includeClean = true;
    console.info("[regen] trial mark re-applied — clean master retained for instant unlock.");
  }

  const variants = {
    vertical: {
      format: masterDims.width === masterDims.height ? "square" : "vertical",
      path: deliverablePath,
      dimensions: masterDims
    },
    ...(includeClean ? { clean: { format: "clean", path: cleanMaster, dimensions: masterDims } } : {})
  };

  // ── Upload. Same storage paths as the original render — the library entry
  // just gets fresh content. No shorts: regen ships exactly what the render
  // shipped (v62.18 rule), and the main render ships none.
  options.onProgress?.({ phase: "Uploading replacement", progress: 86 });
  const upload = await uploadDeliverables({
    manifest, jobId, variants, shorts: [], thumbnailPath, pathPrefix: "runway",
    onProgress: (info) => {
      options.onProgress?.({ phase: info.phase || "Uploading", progress: 86 + Math.floor((info.fraction || 0) * 8) });
    }
  });

  // ── An upload failure must NOT touch the audit row. The old expression
  // patched master_mp4_url to "" on any storage failure while reporting
  // success — the customer's finished video vanished from their library
  // with no error anywhere (adversarial review, executed). A patch with an
  // empty URL is a delete; refuse instead. (storageSkipped = no Supabase
  // configured — dev/harness — where there is no audit row to protect.)
  const newMasterUrl = upload?.formats?.vertical?.mp4Url || "";
  if (!newMasterUrl && !upload?.storageSkipped) {
    throw new Error(
      `Replacement master upload failed (${upload?.storageWarning || "storage error"}) — ` +
      `the original render is untouched.`
    );
  }

  options.onProgress?.({ phase: "Persisting scene library", progress: 96 });
  const scenesMeta = await uploadPerSceneClips({
    manifest, jobId, normalizedClips, clipResults, pathPrefix: "runway"
  });

  // ── Audit patch. Narration fields are deliberately untouched — the audio
  // IS the original's. Only fields with real values are written; a falsy
  // value in a PATCH is a delete, never a default.
  options.onProgress?.({ phase: "Updating render history", progress: 99 });
  if (newMasterUrl) {
    await updateRenderAudit({
      jobId,
      patch: {
        master_mp4_url: newMasterUrl,
        ...(upload?.formats?.clean?.mp4Url ? { master_clean_url: upload.formats.clean.mp4Url } : {}),
        ...(upload?.thumbnailUrl ? { thumbnail_url: upload.thumbnailUrl } : {}),
        scenes: scenesMeta,
        status: "completed"
      }
    });
  }

  options.onProgress?.({ phase: "Ready to download", progress: 100 });
  return {
    status: "complete",
    engine: "runway",
    mode: "steady",
    jobId,
    regeneratedSceneIndex: sceneIndex,
    mp4Url: upload?.formats?.vertical?.mp4Url || "",
    thumbnailUrl: upload?.thumbnailUrl || "",
    formats: upload?.formats || {},
    socialShorts: [],
    scenes: scenesMeta,
    // The whole point: the voiceover was never re-synthesized.
    narration: { applied: true, preserved: true },
    // Harness-only: local artifact paths for assertions, never in production
    // responses (the server would forward them to the client).
    ...(process.env.REGEN_TEST_EXPOSE_LOCAL === "1"
      ? { __local: { cleanMaster, deliverablePath, silentStitched, thumbnailPath, rebuiltLen, originalLen } }
      : {})
  };
}

/* =================================================================
   Helpers
   ================================================================= */

function regenDims(manifest) {
  const ratio = String(manifest?.runwayConfig?.ratio || manifest?.exportFormat || "vertical").toLowerCase();
  if (ratio === "16:9" || ratio === "wide") return { width: 1920, height: 1080 };
  if (ratio === "1:1" || ratio === "square") return { width: 1080, height: 1080 };
  return { width: 1080, height: 1920 };
}

// Feed for generateKenBurnsFallback: audit truth first, manifest fallback.
function buildSceneForRegen(auditScene, manifest) {
  const manifestScene = (manifest.scenes || []).find((s) => s.photoId === auditScene.photoId) || {};
  return {
    photoId: auditScene.photoId || manifestScene.photoId,
    roomType: manifestScene.roomType || auditScene.roomType || "",
    cameraMotion: manifestScene.cameraMotion || auditScene.cameraMotion || "push_in",
    duration: Number(auditScene.durationSec || auditScene.duration || manifestScene.duration || 5),
    durableUrl: manifestScene.durableUrl || manifestScene.durable_url || auditScene.photoUrl || "",
    transition: manifestScene.transition || "crossfade",
    overlay: manifestScene.overlay || null
  };
}

function probeDurationSec(file) {
  return new Promise((resolve) => {
    execFile("ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { timeout: 15000 },
      (err, stdout) => resolve(err ? NaN : Number(String(stdout).trim()))
    );
  });
}

function probeAudioDurationSec(file) {
  return new Promise((resolve) => {
    execFile("ffprobe",
      ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "csv=p=0", file],
      { timeout: 15000 },
      (err, stdout) => resolve(err ? NaN : Number(String(stdout).trim()))
    );
  });
}

async function downloadFile(url, destPath) {
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
    const first = errors[0];
    const wrapped = new Error(first.error.message || `Regen download ${first.index + 1} failed.`);
    wrapped.code = first.error.code;
    throw wrapped;
  }
  return results;
}

// Exported for the harness: drives the full rebuild against local/HTTP
// fixtures without Supabase (the caller supplies what readRenderAudit
// would have returned).
export { rebuildWithSteadyScene as __testRebuildWithSteadyScene };
