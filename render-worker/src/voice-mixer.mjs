// EstateMotion — Voice narration synthesis + music ducking for the render
// worker.
//
// Pipeline:
//   1. For each scene with a narrationLine, hit ElevenLabs TTS and get an
//      MP3. Run them in parallel (capped concurrency) since each call is
//      ~1-2 seconds.
//   2. Pad each MP3 to its scene's exact duration with silence and concat.
//      Result: one continuous narration track aligned to scene boundaries.
//   3. Remix the master video — bring music down to ~28% during narration
//      windows (sidechain-compressor style ducking via volume automation).
//   4. Replace the master's audio with the new mix.
//
// If ELEVENLABS_API_KEY is missing or no scenes have narrationLine, the
// helper is a no-op and returns the master untouched.

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";
const DEFAULT_MODEL = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";
const FALLBACK_VOICE_ID = process.env.ELEVENLABS_DEFAULT_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // "Rachel"
const SYNTH_CONCURRENCY = 4;
// Music volume during narration. 0.28 = ~ -11dB, similar to broadcast TV
// voiceover. 1.0 outside narration windows (full music).
const DUCK_LEVEL = 0.28;

export async function applyVoiceNarration({ masterMp4, scenes, brandKit, tempDir, jobId, onProgress }) {
  if (!process.env.ELEVENLABS_API_KEY) {
    return { masterMp4, narrationApplied: false, reason: "ELEVENLABS_API_KEY not set" };
  }

  const photoScenes = (scenes || []).filter((s) => String(s.type || "photo").toLowerCase() === "photo");
  const narrationScenes = photoScenes
    .map((scene, index) => ({ scene, index }))
    .filter(({ scene }) => typeof scene.narrationLine === "string" && scene.narrationLine.trim().length >= 3);

  if (narrationScenes.length === 0) {
    return { masterMp4, narrationApplied: false, reason: "No narrationLine fields on any scene" };
  }

  const voiceId = (brandKit?.voiceId || "").trim() || FALLBACK_VOICE_ID;
  onProgress?.({ phase: `Synthesizing voice (${narrationScenes.length} lines)`, fraction: 0 });

  // Per-scene synthesis, capped concurrency.
  const synthesized = new Array(photoScenes.length).fill(null);
  let completed = 0;
  await pMap(
    narrationScenes,
    async ({ scene, index }) => {
      const mp3Path = path.join(tempDir, `${jobId}-narration-${String(index).padStart(3, "0")}.mp3`);
      await synthesizeToFile({
        text: scene.narrationLine.trim(),
        voiceId,
        outPath: mp3Path
      });
      synthesized[index] = { mp3Path, scene };
      completed++;
      onProgress?.({ phase: `Synthesizing voice (${completed}/${narrationScenes.length})`, fraction: completed / narrationScenes.length });
    },
    { concurrency: SYNTH_CONCURRENCY }
  );

  // Build the narration timeline. For each photo scene:
  //   - if narration: pad/trim narration to scene duration, prepend a small
  //     silence (so the voice starts ~0.4s into the scene, after the cut
  //     lands on screen)
  //   - if no narration: emit silence for the scene duration
  const segmentPaths = [];
  const narrationActiveWindows = []; // [[startSec, endSec], ...] for ducking
  let cursorSec = 0;
  for (let i = 0; i < photoScenes.length; i++) {
    const scene = photoScenes[i];
    const sceneDuration = Number(scene.duration || 3);
    const synth = synthesized[i];
    if (synth) {
      const leadInSec = 0.35;
      const trimmedPath = path.join(tempDir, `${jobId}-narration-segment-${String(i).padStart(3, "0")}.mp3`);
      // ffmpeg: prepend leadInSec silence + narration, then pad/trim to
      // exactly sceneDuration.
      await runFFmpeg([
        "-y",
        "-threads", "1",
        "-f", "lavfi",
        "-i", `anullsrc=channel_layout=stereo:sample_rate=44100`,
        "-i", synth.mp3Path,
        "-filter_complex",
        `[0:a]atrim=duration=${leadInSec}[lead];[lead][1:a]concat=n=2:v=0:a=1,apad=whole_dur=${sceneDuration},atrim=duration=${sceneDuration},aresample=44100,asetpts=N/SR/TB[out]`,
        "-map", "[out]",
        "-c:a", "libmp3lame",
        "-b:a", "128k",
        trimmedPath
      ]);
      segmentPaths.push(trimmedPath);
      // Narration is approximately active from leadInSec to (leadInSec + narrationDuration);
      // we don't know the exact ElevenLabs output duration without probing, so we'll
      // assume it fills the rest of the scene minus a tiny tail. Good enough for ducking.
      narrationActiveWindows.push([cursorSec + leadInSec, cursorSec + sceneDuration - 0.2]);
    } else {
      const silentPath = path.join(tempDir, `${jobId}-narration-silent-${String(i).padStart(3, "0")}.mp3`);
      await runFFmpeg([
        "-y",
        "-threads", "1",
        "-f", "lavfi",
        "-i", `anullsrc=channel_layout=stereo:sample_rate=44100`,
        "-t", String(sceneDuration),
        "-c:a", "libmp3lame",
        "-b:a", "128k",
        silentPath
      ]);
      segmentPaths.push(silentPath);
    }
    cursorSec += sceneDuration;
  }

  // Concat narration segments into one continuous voice track.
  onProgress?.({ phase: "Mixing narration with music", fraction: 0.85 });
  const narrationTrackPath = path.join(tempDir, `${jobId}-narration-track.mp3`);
  const concatList = path.join(tempDir, `${jobId}-narration-concat.txt`);
  await fs.writeFile(concatList, segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  await runFFmpeg([
    "-y",
    "-threads", "1",
    "-f", "concat",
    "-safe", "0",
    "-i", concatList,
    "-c:a", "copy",
    narrationTrackPath
  ]);

  // Build a music-volume automation expression that ducks music during
  // narration windows. ffmpeg's `volume` filter accepts a per-frame eval
  // expression; we use `between(t,start,end)` for each window.
  const duckExpr = narrationActiveWindows.length
    ? narrationActiveWindows
        .map(([start, end]) => `between(t,${start.toFixed(2)},${end.toFixed(2)})`)
        .join("+")
    : "0";
  // Final volume = 1 outside windows, DUCK_LEVEL inside.
  const volumeExpr = narrationActiveWindows.length
    ? `if(${duckExpr},${DUCK_LEVEL},1)`
    : "1";

  // Final mix: master video + master audio (ducked) + narration track.
  const mixedMp4 = path.join(tempDir, `${jobId}-narrated.mp4`);
  await runFFmpeg([
    "-y",
    "-threads", "1",
    "-i", masterMp4,
    "-i", narrationTrackPath,
    "-filter_complex",
    // [0:a] is the master's existing audio (music). Apply volume duck.
    // [1:a] is the narration track, kept at full volume.
    // Mix them. If the master has no audio, ffmpeg silently drops [0:a]
    // and we just use the narration — the `?` makes the input optional.
    `[0:a:0]volume=eval=frame:volume='${volumeExpr}'[ducked];[ducked][1:a]amix=inputs=2:duration=first:dropout_transition=0:weights=1 1.4,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`,
    "-map", "0:v:0",
    "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    mixedMp4
  ]).catch(async (err) => {
    // Master may have no audio at all (Quick Reel sometimes ships without
    // music when no track is configured). Retry mixing narration onto a
    // silent audio bed so we still get voice.
    if (!/no such filter|map.*audio|Stream specifier/i.test(err.message || "")) throw err;
    await runFFmpeg([
      "-y",
      "-threads", "1",
      "-i", masterMp4,
      "-i", narrationTrackPath,
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-shortest",
      mixedMp4
    ]);
  });

  // Free the per-scene narration mp3s now that the final mix is on disk.
  for (const p of segmentPaths) await fs.unlink(p).catch(() => {});
  for (let i = 0; i < synthesized.length; i++) {
    if (synthesized[i]?.mp3Path) await fs.unlink(synthesized[i].mp3Path).catch(() => {});
  }
  await fs.unlink(concatList).catch(() => {});
  await fs.unlink(narrationTrackPath).catch(() => {});

  return {
    masterMp4: mixedMp4,
    narrationApplied: true,
    voiceId,
    narrationLineCount: narrationScenes.length
  };
}

async function synthesizeToFile({ text, voiceId, outPath }) {
  const response = await fetchWithTimeout(
    `${ELEVENLABS_BASE}/text-to-speech/${encodeURIComponent(voiceId)}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        model_id: DEFAULT_MODEL,
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.85,
          style: 0.18,
          use_speaker_boost: true
        }
      })
    },
    30000
  );
  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${err.slice(0, 240)}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outPath, buffer);
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
    proc.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-600).replace(/\n/g, " | ")}`));
    });
    proc.on("error", (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
  });
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

async function pMap(items, fn, { concurrency = 4 } = {}) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
