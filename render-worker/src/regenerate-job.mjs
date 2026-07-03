// Vistalia — Per-scene regenerate orchestrator.
//
// The production-grade fix for hallucinated AI scenes. When one of the 24
// Runway scenes comes out wrong (microwave-on-fridge, ceiling fan doubled,
// phantom wall), the user clicks "Regen this one" and we:
//
//   1. Look up the original audit row by jobId (which has scenes[])
//   2. Generate ONE new clip for the target sceneIndex (Runway OR Ken Burns)
//   3. Download the other N-1 scene clips from Supabase Storage
//   4. Re-stitch + re-derive variants + re-cut shorts
//   5. Re-upload master + variants + shorts + thumbnail (overwriting)
//   6. Update the audit row with the new master URL + replaced scene entry
//
// Cost-vs-credits tradeoff: ONE Runway clip = ~$0.25 instead of $6.00 for a
// full re-render. ~24× cheaper, ~10× faster (one clip plus stitch instead of
// 24 clips concurrent then stitch).
//
// Failure modes handled:
//   - Audit row missing → can't regen, surface to user
//   - Scene clip URL missing in audit row → that scene was never persisted
//   - Runway daily cap → bubble up so frontend can prompt for upgrade
//   - Runway returns garbage again → user can re-click regen with mode=kenburns

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  generateClip,
  generateKenBurnsFallback,
  generateVeoSceneClip,
  stitchClipsAndOverlays,
  uploadPerSceneClips,
  uploadDeliverables
} from "./runway-job.mjs";
import { readRenderAudit, updateRenderAudit } from "./audit-log.mjs";
import { deriveAspectVariants, buildSocialShorts } from "./aspect-variants.mjs";
import { applyVoiceNarration } from "./voice-mixer.mjs";

export async function regenerateScene(body, options = {}) {
  const { jobId, sceneIndex, mode = "ai", manifest } = body || {};
  if (!jobId) throw new Error("regenerateScene: jobId required.");
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0) {
    throw new Error("regenerateScene: sceneIndex (non-negative integer) required.");
  }
  if (!manifest) throw new Error("regenerateScene: manifest required.");

  // v26.3: AI regen now runs Veo 3.1 Fast (matching the production cutover
  // in dispatchRender). Rollback mirror: VEO_PRODUCTION=false restores
  // Runway regen. mode='kenburns' still works for legacy renders until the
  // Phase 3 UI strip.
  const useVeo = process.env.VEO_PRODUCTION !== "false" && Boolean(process.env.FAL_KEY);
  if (mode === "ai" && !useVeo && !process.env.RUNWAY_API_KEY) {
    throw new Error("FAL_KEY (Veo) or RUNWAY_API_KEY is required for AI regenerate. Use mode='kenburns' to skip AI.");
  }

  options.onProgress?.({ phase: "Looking up original render", progress: 4 });

  // Step 1: read the audit row so we can find the per-scene clip URLs.
  const auditRow = await readRenderAudit(jobId);
  if (!auditRow) {
    throw new Error(
      `Audit row not found for jobId ${jobId}. Per-scene regenerate only works on renders made with worker v16+ — older renders need a full re-render.`
    );
  }

  const originalScenes = Array.isArray(auditRow.scenes) ? auditRow.scenes : [];
  if (!originalScenes.length) {
    throw new Error(
      `Audit row for ${jobId} has no scenes array. Re-render this listing once with the latest worker to enable per-scene regen.`
    );
  }

  const targetScene = originalScenes.find((s) => Number(s.sceneIndex) === Number(sceneIndex));
  if (!targetScene) {
    throw new Error(`Scene ${sceneIndex} is not in the audit row for ${jobId}.`);
  }

  // Validate that every OTHER scene has a clipUrl we can pull from Supabase.
  // If even one is missing we can't reassemble the video, so fail loudly.
  const otherScenes = originalScenes.filter((s) => Number(s.sceneIndex) !== Number(sceneIndex));
  const missing = otherScenes.filter((s) => !s.clipUrl);
  if (missing.length) {
    const indexes = missing.map((s) => s.sceneIndex).join(", ");
    throw new Error(
      `Cannot regen — scenes ${indexes} have no persisted clipUrl in the audit row. ` +
      `This usually means the original render predates v16 per-scene persistence. Run a full re-render once to enable regen.`
    );
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "estatemotion-regen-"));

  // Step 2: locate the manifest scene for the target so we have prompt + photo.
  // We trust the audit row's runwayPrompt over manifest.scenes[sceneIndex]
  // because the manifest the frontend just posted may have been regenerated
  // and have slightly different prompts than the original render — and we want
  // regen to produce a clip that drops into the EXISTING stitch unchanged.
  const manifestScene = buildSceneForRegen(targetScene, manifest);

  // Step 3: generate the replacement clip.
  const replacementPhase = mode === "kenburns" ? "Generating Ken Burns scene" : "Regenerating with AI";
  options.onProgress?.({ phase: replacementPhase, progress: 8 });

  let replacementClip;
  try {
    if (mode === "kenburns") {
      replacementClip = await generateKenBurnsFallback(manifestScene, manifest, tempDir, sceneIndex);
    } else if (useVeo) {
      // v26.3: Veo regen. A user regenerating a scene is usually unhappy
      // with hallucinated detail, so regen runs CONSTRAINED by default —
      // maximal fidelity is the whole point of the click. Retry once on
      // failure; no Ken Burns downgrade on the Veo path.
      try {
        replacementClip = await generateVeoSceneClip(manifestScene, manifest, tempDir, sceneIndex, { constrained: true });
      } catch (veoErr) {
        console.warn(`[regen] veo regen failed (${veoErr.message}). Retrying once.`);
        replacementClip = await generateVeoSceneClip(manifestScene, manifest, tempDir, sceneIndex, { constrained: true });
      }
    } else {
      replacementClip = await generateClip(manifestScene, manifest, tempDir, sceneIndex);
    }
  } catch (err) {
    if (err.code === "RUNWAY_DAILY_CAP") throw err;
    if (useVeo && mode === "ai") {
      // No silent KB downgrade on Veo — surface the failure honestly.
      const wrapped = new Error(`Veo regenerate failed twice for scene ${sceneIndex + 1}: ${err.message}`);
      wrapped.code = "VEO_REGEN_FAILED";
      throw wrapped;
    }
    console.warn(`[regen] ${mode} regen failed (${err.message}). Falling back to Ken Burns.`);
    replacementClip = await generateKenBurnsFallback(manifestScene, manifest, tempDir, sceneIndex);
  }

  // Step 4: download the OTHER N-1 scene clips from Supabase Storage in
  // parallel. These are the already-normalized scene-NNN.mp4 files we
  // uploaded at the end of the original render.
  options.onProgress?.({ phase: `Loading remaining ${otherScenes.length} scenes`, progress: 32 });

  // Capped parallelism on downloads — Render Standard has limited bandwidth
  // and 24 parallel downloads can saturate it and time out individual ones.
  const downloadConcurrency = Math.min(6, otherScenes.length || 1);
  const downloaded = await pMap(otherScenes, async (s) => {
    const localPath = path.join(tempDir, `clip-${String(s.sceneIndex).padStart(3, "0")}.mp4`);
    await downloadFile(s.clipUrl, localPath);
    return {
      sceneIndex: Number(s.sceneIndex),
      photoId: s.photoId || "",
      clipPath: localPath,
      duration: Number(s.duration || 5),
      transition: "crossfade",
      overlay: null,
      runwayTaskId: null,
      fallback: Boolean(s.wasFallback),
      // Mark as pre-normalized so stitchClipsAndOverlays can skip re-encoding.
      preNormalized: true,
      roomType: s.roomType || "",
      cameraMotion: s.cameraMotion || "",
      runwayPrompt: s.runwayPrompt || ""
    };
  }, { concurrency: downloadConcurrency });

  // Step 5: assemble the full clipResults array in sceneIndex order.
  const clipResults = [...downloaded, replacementClip].sort(
    (a, b) => a.sceneIndex - b.sceneIndex
  );

  // Step 6: stitch. The existing stitchClipsAndOverlays helper re-normalizes
  // every clip (applies the cinematic grade + watermark consistently). For
  // already-normalized clips from Supabase, the normalization pass is mostly
  // re-applying the brand watermark — which is exactly what we want if the
  // user updated their brand kit between the original render and this regen.
  options.onProgress?.({ phase: "Re-stitching video", progress: 50 });
  const finalMp4 = path.join(tempDir, `${jobId}.mp4`);
  const thumbnailPath = path.join(tempDir, `${jobId}.png`);
  const { normalizedClips } = await stitchClipsAndOverlays(
    clipResults,
    manifest,
    finalMp4,
    thumbnailPath,
    {
      onProgress: (patch) => {
        // Map the stitch's internal 76-81% progress to our 50-72% window.
        const inner = patch?.progress || 76;
        const mapped = 50 + Math.min(22, Math.max(0, Math.round(((inner - 76) / 5) * 22)));
        options.onProgress?.({ phase: patch?.phase || "Re-stitching", progress: mapped });
      }
    }
  );

  // Step 7: optional narration re-apply. If the original render had narration
  // and the brand kit + scene texts haven't changed, we *could* try to reuse
  // the original narration tracks — but the scene durations and music ducking
  // are tightly coupled to the stitched timeline, and resplicing audio across
  // a swapped scene is error-prone. v1 approach: re-synthesize end-to-end.
  // Bypassable via manifest.skipNarration or manifest.regenSkipNarration.
  let narration = { narrationApplied: false, reason: "skipped" };
  if (manifest?.skipNarration || manifest?.regenSkipNarration) {
    console.info("[regen] narration skipped via manifest flag.");
  } else {
    options.onProgress?.({ phase: "Re-applying narration", progress: 74 });
    const NARRATION_TIME_BUDGET_MS = 120 * 1000;
    try {
      narration = await Promise.race([
        applyVoiceNarration({
          masterMp4: finalMp4,
          scenes: manifest.scenes,
          // v31 pipeline-audit fix: regen never passed the ACTUAL clip
          // durations (the v26.9 narration-sync fix) — the mixer fell back
          // to manifest durations, which post-v31 are the snapped values,
          // not the +0.5-padded clips on disk. Pass the real durations +
          // crossfade overlap so regen narration lands on the same visible
          // timeline as full renders.
          sceneDurationsByPhoto: Object.fromEntries(
            clipResults.filter((c) => c && c.photoId).map((c) => [c.photoId, Number(c.duration) || 0])
          ),
          crossfadeOverlapSec: manifest?.runwayConfig?.useCrossfades !== false ? 0.5 : 0,
          // v32: continuous script (same one the original render used) so a
          // single-scene regen re-lays the identical voiceover.
          narrationScript: manifest?.narrationScript || "",
          brandKit: manifest.brandKit || {},
          tempDir,
          jobId,
          onProgress: () => {} // muted — we drive progress at the outer level
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Narration re-apply exceeded 2 minutes — shipping music-only audio.")), NARRATION_TIME_BUDGET_MS)
        )
      ]);
    } catch (err) {
      console.warn(`[regen] narration re-apply failed (${err.message}). Continuing music-only.`);
      narration = { narrationApplied: false, reason: err.message || "narration_failed" };
    }
  }
  const masterForVariants = narration.narrationApplied ? narration.masterMp4 : finalMp4;

  // Step 8: re-derive aspect variants.
  options.onProgress?.({ phase: "Re-deriving aspect variants", progress: 82 });
  const wants4K = Boolean(
    manifest?.runwayConfig?.is4K ||
    manifest?.runwayConfig?.upscale4K ||
    manifest?.export4K
  );
  let variants = {};
  try {
    variants = await deriveAspectVariants({
      masterMp4: masterForVariants,
      tempDir,
      jobId,
      upscale4K: wants4K
    });
  } catch (err) {
    console.warn(`[regen] aspect variants failed (${err.message}). Vertical-only.`);
    variants = { vertical: { format: "vertical", path: masterForVariants, dimensions: { w: 1080, h: 1920 } } };
  }
  if (!variants.vertical?.path) {
    variants.vertical = { format: "vertical", path: masterForVariants, dimensions: { w: 1080, h: 1920 } };
  }

  // Step 9: re-cut social shorts.
  options.onProgress?.({ phase: "Re-cutting social shorts", progress: 88 });
  let shorts = [];
  try {
    shorts = await buildSocialShorts({
      masterMp4: masterForVariants,
      scenes: manifest.scenes,
      tempDir,
      jobId,
      count: 3
    });
  } catch (err) {
    console.warn(`[regen] shorts failed (${err.message}). Continuing without shorts.`);
    shorts = [];
  }

  // Step 10: upload deliverables — overwrites the existing master/variants/
  // shorts/thumbnail at the same storage paths so the library entry stays
  // pointed at the same URLs and the frontend just gets fresh content on
  // next reload.
  options.onProgress?.({ phase: "Uploading regenerated render", progress: 92 });
  const upload = await uploadDeliverables({
    manifest,
    jobId,
    variants,
    shorts,
    thumbnailPath,
    pathPrefix: "runway",
    onProgress: (info) => {
      options.onProgress?.({
        phase: info.phase || "Uploading deliverables",
        progress: 92 + Math.floor((info.fraction || 0) * 5)
      });
    }
  });

  // Step 11: re-upload per-scene clips. The replacement scene needs its new
  // clipUrl persisted; the other 23 scenes are unchanged but re-uploading
  // them keeps the scene-NNN.mp4 files consistent with what's currently
  // stitched into the master. Idempotent (upsert: true).
  options.onProgress?.({ phase: "Persisting scene library", progress: 97 });
  const scenesMeta = await uploadPerSceneClips({
    manifest,
    jobId,
    normalizedClips,
    clipResults,
    pathPrefix: "runway"
  });

  // Cleanup local per-scene normalized clips.
  for (const clip of normalizedClips) {
    await fs.unlink(clip.clipPath).catch(() => {});
  }
  // Also clean up the downloaded source clips.
  for (const clip of clipResults) {
    if (clip?.clipPath) await fs.unlink(clip.clipPath).catch(() => {});
  }

  // Step 12: update the audit row. Patch the master URL, thumbnail, scenes
  // array (so subsequent regens see the latest clipUrl), and bump status.
  // Failures here are non-fatal — the new master is already live.
  options.onProgress?.({ phase: "Updating render history", progress: 99 });
  const patch = {
    master_mp4_url: upload?.formats?.vertical?.mp4Url || "",
    thumbnail_url: upload?.thumbnailUrl || "",
    social_short_count: Array.isArray(upload?.socialShorts) ? upload.socialShorts.length : 0,
    formats_count: Object.keys(upload?.formats || {}).length || 1,
    narration_applied: Boolean(narration?.narrationApplied),
    narration_voice_id: narration?.voiceId || null,
    scenes: scenesMeta,
    status: "completed"
  };
  await updateRenderAudit({ jobId, patch });

  options.onProgress?.({ phase: "Ready to download", progress: 100 });

  return {
    status: "complete",
    engine: "runway",
    mode,
    jobId,
    regeneratedSceneIndex: sceneIndex,
    mp4Url: upload?.formats?.vertical?.mp4Url || "",
    thumbnailUrl: upload?.thumbnailUrl || "",
    formats: upload?.formats || {},
    socialShorts: upload?.socialShorts || [],
    scenes: scenesMeta,
    narration: narration.narrationApplied
      ? { applied: true, voiceId: narration.voiceId, lineCount: narration.narrationLineCount }
      : { applied: false, reason: narration.reason }
  };
}

/* =================================================================
   Helpers
   ================================================================= */

// Build a synthetic "scene" object suitable for feeding into generateClip /
// generateKenBurnsFallback. Prefers the audit-row data (so regen reproduces
// the original render context) but falls back to the manifest if anything
// is missing.
function buildSceneForRegen(auditScene, manifest) {
  // Try to match the manifest scene by photoId so we can pull a fresh
  // runwayPrompt if the user re-generated their edit plan.
  const manifestScene =
    (manifest.scenes || []).find((s) => s.photoId === auditScene.photoId) || {};

  return {
    photoId: auditScene.photoId || manifestScene.photoId,
    roomType: manifestScene.roomType || auditScene.roomType || "",
    cameraMotion: manifestScene.cameraMotion || auditScene.cameraMotion || "push_in",
    duration: Number(manifestScene.duration || auditScene.duration || 5),
    // Prefer the manifest's prompt — it reflects the latest anti-hallucination
    // tweaks. Fall back to the audit row's prompt if the manifest scene wasn't
    // re-generated.
    runwayPrompt: manifestScene.runwayPrompt || manifestScene.runway_prompt || auditScene.runwayPrompt || "",
    durableUrl: manifestScene.durableUrl || manifestScene.durable_url || auditScene.photoUrl || "",
    transition: manifestScene.transition || "crossfade",
    overlay: manifestScene.overlay || null
  };
}

// Local downloader with timeout. Mirrors the one in runway-job.mjs but kept
// here so this module doesn't depend on an export of an internal helper.
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
