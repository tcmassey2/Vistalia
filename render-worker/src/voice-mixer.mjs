// Vistalia — Voice narration synthesis + music ducking, fast path.
//
// REBUILD NOTES (vs prior version):
//   The old implementation did 24 sequential ffmpeg calls to build per-scene
//   audio segments before concatenating, which silently took 30-60s and
//   looked like "frozen at 80%" to the user.
//   This rewrite builds the entire narration track in ONE ffmpeg pass using
//   the `adelay` filter to position each narration MP3 at its correct
//   timestamp on a silent base — typical render-step time drops from
//   ~45s to ~6s.
//
// Pipeline (current):
//   1. Synthesize per-scene narration via ElevenLabs in parallel (4 at a time).
//   2. ONE ffmpeg pass: silent base of total-video-duration + each narration
//      MP3 with adelay offset = sceneStart + 0.35s lead-in, all amixed.
//   3. ONE ffmpeg pass: master video + ducked music + narration → final.
//
// Bypass: if ELEVENLABS_API_KEY is missing, no scenes have narrationLine,
// or any step throws, the helper returns the master untouched and the
// caller ships music-only audio.

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { runFFmpeg } from "./ffmpeg-runner.mjs";
import { resolveVoiceId } from "./voices.mjs";

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";
const DEFAULT_MODEL = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";
const FALLBACK_VOICE_ID = process.env.ELEVENLABS_DEFAULT_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // "Rachel"
const SYNTH_CONCURRENCY = 4;
const SYNTH_TIMEOUT_MS = 25000;
// Music volume during narration. 0.30 ≈ -10 dB relative to the music bed,
// which means with the runway-job pre-attenuating music to 0.35, music
// during voice drops to ~0.105 (-19 dB). Combined with VOICE_WEIGHT=1.4
// that puts voice ~22 dB above music when narration plays — broadcast
// voiceover level. Override via env DUCK_LEVEL or manifest.duckLevel.
const DUCK_LEVEL = Number(process.env.DUCK_LEVEL ?? 0.30);
// Voice gain in the final amix. 1.4 ≈ +3 dB push so voice cuts through
// any low-frequency music rumble. Override via env VOICE_LEVEL or
// manifest.voiceLevel.
const VOICE_WEIGHT = Number(process.env.VOICE_LEVEL ?? 1.4);

export async function applyVoiceNarration({ masterMp4, scenes, sceneDurationsByPhoto, brandKit, tempDir, jobId, onProgress }) {
  // v26.9: actual rendered clip duration per scene (keyed by photoId). When
  // present it overrides the manifest's stated duration so narration timing
  // matches the real video exactly — the single biggest narration-sync fix.
  const realDur = (scene, fallback) => {
    const d = sceneDurationsByPhoto && scene && scene.photoId ? Number(sceneDurationsByPhoto[scene.photoId]) : 0;
    return d > 0 ? d : fallback;
  };
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

  // v27: resolve the stored value. brandKit.voiceId may be a PRESET SLUG
  // ("luxury-warm") from the picker or a RAW CLONED ID from "use your own
  // voice". ElevenLabs only accepts raw IDs — resolveVoiceId maps slugs and
  // passes cloned IDs through. Before this, slugs were sent verbatim and every
  // preset-voice render shipped silent.
  const voiceId = resolveVoiceId(brandKit?.voiceId, brandKit?.style);

  // ============================================================
  // STEP 1 — synthesize each narration line via ElevenLabs (parallel)
  // Per-line fail-soft: one failed TTS call no longer kills the whole
  // narration step. Before: pMap used Promise.all, so a single 502 from
  // ElevenLabs aborted everything and the user got zero narration. Now we
  // catch per-line and continue. If *every* line fails we return
  // narrationApplied:false so the master ships music-only.
  // ============================================================
  onProgress?.({ phase: `Synthesizing voice (${narrationScenes.length} lines)`, fraction: 0 });
  const synthesized = new Array(photoScenes.length).fill(null);
  const synthErrors = [];
  let completed = 0;
  // v27.1: attach each line's neighbors for request-stitching (consistent voice).
  const narrationWithCtx = narrationScenes.map((it, p) => ({
    ...it,
    previousText: p > 0 ? (narrationScenes[p - 1].scene.narrationLine || "").trim() : "",
    nextText: p < narrationScenes.length - 1 ? (narrationScenes[p + 1].scene.narrationLine || "").trim() : ""
  }));
  await pMap(
    narrationWithCtx,
    async ({ scene, index, previousText, nextText }) => {
      const mp3Path = path.join(tempDir, `${jobId}-n-${String(index).padStart(3, "0")}.mp3`);
      try {
        await synthesizeToFile({
          text: scene.narrationLine.trim(),
          voiceId,
          outPath: mp3Path,
          previousText,
          nextText
        });
        synthesized[index] = { mp3Path, scene };
      } catch (err) {
        synthErrors.push({ index, message: err.message || String(err) });
        console.warn(`[voice] scene ${index + 1} TTS failed: ${err.message} — skipping this line, continuing.`);
      }
      completed += 1;
      onProgress?.({ phase: `Synthesizing voice (${completed}/${narrationScenes.length})`, fraction: completed / narrationScenes.length * 0.6 });
    },
    { concurrency: SYNTH_CONCURRENCY }
  );

  const successCount = synthesized.filter(Boolean).length;
  console.info(`[voice] synthesized ${successCount}/${narrationScenes.length} lines (${synthErrors.length} failed)`);
  if (successCount === 0) {
    return {
      masterMp4,
      narrationApplied: false,
      reason: `All ${narrationScenes.length} ElevenLabs TTS calls failed. First error: ${synthErrors[0]?.message || "unknown"}`
    };
  }

  // ============================================================
  // STEP 2 — single-pass narration track via adelay
  // Compute each scene's start timestamp + 0.35s lead-in, build a filter
  // graph that places every narration MP3 at the right offset on a silent
  // base. The total-video duration is the sum of photo-scene durations.
  // ============================================================
  onProgress?.({ phase: "Building narration track", fraction: 0.7 });

  const leadInSec = 0.35;
  const sceneStarts = []; // start time of each scene in seconds
  const sceneDurs = [];   // resolved duration of each scene (actual clip > manifest)
  let cursor = 0;
  for (const sc of photoScenes) {
    const d = realDur(sc, Number(sc.duration || 3));
    sceneStarts.push(cursor);
    sceneDurs.push(d);
    cursor += d;
  }
  const totalDurationSec = cursor;

  // v28.1: voice is capped strictly to the PHOTO scenes — it must NEVER bleed
  // over the silent brand-outro card (that read as unclean). Lines are sized to
  // fit upstream: create-edit-plan sets each narrated scene's duration to its
  // line's spoken length, so the line finishes naturally inside its own scene
  // instead of being chopped or spilling into the outro.
  const narrationTrackDurSec = totalDurationSec;
  let lastNarrIndex = -1;
  for (let i = 0; i < synthesized.length; i++) if (synthesized[i]) lastNarrIndex = i;

  // v24.4: BULLETPROOFED voice scheduling. Earlier fix used atrim only;
  // this version also (a) tightens the safety buffer to 0.8s tail, (b)
  // caps narration at 80% of the scene duration as a second guard, (c)
  // uses bounded apad (apad=whole_dur=END_MS) instead of unbounded so
  // narration audio CANNOT extend past its scene window even if amix
  // misbehaves, (d) logs the exact trim values per scene for one-line
  // diagnosis if overlap is reported again.
  // v27 smoothness: give lines more room (tail 0.8→0.5, cap 0.80→0.90) so a
  // natural sentence rarely needs trimming, and any trim is faded (below) not
  // hard-cut. Still strictly within the scene window → never overlaps the next
  // line (which starts at nextSceneStart + leadIn).
  const TAIL_BUFFER_SEC = 0.5;
  const FADE_IN_SEC = 0.08;   // soften the start of every line (kills clicks)
  const FADE_OUT_SEC = 0.35;  // only bites when a line is trimmed → smooth, not a cut
  const placedNarrations = synthesized
    .map((entry, i) => {
      if (!entry) return null;
      const sceneDur = sceneDurs[i];
      // The LAST line has no following line to overlap, and the master video
      // continues into the silent brand-outro card — so let it use ALL the room
      // up to the master end (minus a tail) instead of the tight per-scene cap.
      // Every other line stays strictly inside its scene window so it can never
      // bleed into the next line.
      const isLast = i === lastNarrIndex;
      const windowEndSec = isLast
        ? Math.max(sceneStarts[i] + sceneDur, narrationTrackDurSec)
        : sceneStarts[i] + sceneDur;
      // Two guards: subtractive (window - leadIn - tail) AND, for non-final
      // lines only, proportional (90% of sceneDur). Min of the two is the cap.
      const cap1 = windowEndSec - sceneStarts[i] - leadInSec - TAIL_BUFFER_SEC;
      const cap2 = isLast ? Infinity : sceneDur * 0.90;
      const maxNarrationSec = Math.max(0.6, Math.min(cap1, cap2));
      const sceneEndMs = Math.round(windowEndSec * 1000);
      return {
        mp3Path: entry.mp3Path,
        sceneStartSec: sceneStarts[i],
        sceneDurSec: sceneDur,
        delayMs: Math.round((sceneStarts[i] + leadInSec) * 1000),
        maxNarrationSec,
        sceneEndMs
      };
    })
    .filter(Boolean);

  // Diagnostic log — printed once per render. If overlap is reported
  // again, this line tells us exactly what trim windows were used.
  console.info(
    `[voice] scheduled ${placedNarrations.length} narration line(s):`,
    placedNarrations.map((n) =>
      `s${n.sceneStartSec.toFixed(1)}-${(n.sceneStartSec + n.sceneDurSec).toFixed(1)}s ` +
      `(narr ≤${n.maxNarrationSec.toFixed(2)}s)`
    ).join(" | ")
  );

  const narrationActiveWindows = synthesized
    .map((entry, i) => {
      if (!entry) return null;
      // Keep music ducked through the (possibly extended) last line.
      const endSec = (i === lastNarrIndex ? narrationTrackDurSec : sceneStarts[i] + sceneDurs[i]) - 0.2;
      return [sceneStarts[i] + leadInSec, endSec];
    })
    .filter(Boolean);

  // Build the filter_complex graph. Inputs:
  //   [0:a] silent base (lavfi anullsrc, duration = totalDurationSec)
  //   [1:a] first narration mp3
  //   [2:a] second narration mp3 ...
  // For each narration:
  //   1. atrim caps it at maxNarrationSec so the audio CONTENT can't
  //      extend past the trim.
  //   2. asetpts rebases timestamps after the trim.
  //   3. adelay positions it at sceneStart+leadIn.
  //   4. apad=whole_dur=sceneEndMs HARD-CAPS the stream at the scene
  //      boundary — even if amix or ffmpeg quirks try to extend the
  //      audio, the stream itself ends at the scene's end timestamp.
  //      This is the belt-and-suspenders that makes overlap physically
  //      impossible.
  // v27 smoothness: afade in at the start (no click) and afade out at the very
  // end of the (possibly trimmed) window. The fade-out only lands on audio when
  // a line is actually longer than its cap — turning what used to be an abrupt
  // mid-word chop into a natural fade. Shorter lines end on their own clean
  // sentence boundary, untouched. asetpts after trim, then fades, then position.
  const adelaySteps = placedNarrations
    .map((n, i) => {
      const fadeOutStart = Math.max(0, n.maxNarrationSec - FADE_OUT_SEC).toFixed(2);
      return (
        `[${i + 1}:a]atrim=duration=${n.maxNarrationSec.toFixed(2)},asetpts=PTS-STARTPTS,` +
        `afade=t=in:st=0:d=${FADE_IN_SEC},afade=t=out:st=${fadeOutStart}:d=${FADE_OUT_SEC.toFixed(2)},` +
        `adelay=${n.delayMs}|${n.delayMs},apad=whole_dur=${n.sceneEndMs}ms[n${i}]`
      );
    })
    .join(";");
  const mixInputs = placedNarrations.map((_, i) => `[n${i}]`).join("");
  const filterComplex = `${adelaySteps};[0:a]${mixInputs}amix=inputs=${placedNarrations.length + 1}:duration=first:dropout_transition=0,atrim=duration=${narrationTrackDurSec}[narr]`;

  const narrationTrackPath = path.join(tempDir, `${jobId}-narration-track.mp3`);
  const narrationArgs = [
    "-y",
    "-threads", "1",
    "-f", "lavfi",
    "-i", `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${narrationTrackDurSec}`,
    ...placedNarrations.flatMap((n) => ["-i", n.mp3Path]),
    "-filter_complex", filterComplex,
    "-map", "[narr]",
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    "-t", String(narrationTrackDurSec),
    narrationTrackPath
  ];
  await runFFmpeg(narrationArgs, { timeoutMs: 90000, label: "voice:adelay-mix" });

  // ============================================================
  // STEP 3 — final mix: master video + (ducked music if any) + narration
  // ============================================================
  onProgress?.({ phase: "Mixing narration with music", fraction: 0.9 });

  const duckExpr = narrationActiveWindows.length
    ? narrationActiveWindows.map(([s, e]) => `between(t,${s.toFixed(2)},${e.toFixed(2)})`).join("+")
    : "0";
  const volumeExpr = narrationActiveWindows.length
    ? `if(${duckExpr},${DUCK_LEVEL},1)`
    : "1";

  const mixedMp4 = path.join(tempDir, `${jobId}-narrated.mp4`);

  // Detect whether the master has an audio track. If not, we skip the
  // music-duck step entirely — narration becomes the only audio source.
  const masterHasAudio = await detectAudioStream(masterMp4);

  if (masterHasAudio) {
    await runFFmpeg([
      "-y",
      "-threads", "1",
      "-i", masterMp4,
      "-i", narrationTrackPath,
      "-filter_complex",
      `[0:a:0]volume=eval=frame:volume='${volumeExpr}'[ducked];[ducked][1:a]amix=inputs=2:duration=first:dropout_transition=0:weights=1 ${VOICE_WEIGHT.toFixed(2)},loudnorm=I=-16:TP=-1.5:LRA=11[aout]`,
      "-map", "0:v:0",
      "-map", "[aout]",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      mixedMp4
    ], { timeoutMs: 90000, label: "voice:final-mix-with-music" });
  } else {
    // No music in master — narration becomes the only audio.
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
    ], { timeoutMs: 60000, label: "voice:final-mix-narration-only" });
  }

  // Cleanup temp files (best-effort).
  for (let i = 0; i < synthesized.length; i++) {
    if (synthesized[i]?.mp3Path) await fs.unlink(synthesized[i].mp3Path).catch(() => {});
  }
  await fs.unlink(narrationTrackPath).catch(() => {});

  return {
    masterMp4: mixedMp4,
    narrationApplied: true,
    voiceId,
    narrationLineCount: narrationScenes.length
  };
}

/* ============================================================
   Helpers
   ============================================================ */

async function synthesizeToFile({ text, voiceId, outPath, previousText = "", nextText = "" }) {
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
        // v27.1 request-stitching: give each line the surrounding lines as
        // context so ElevenLabs keeps tone/prosody consistent across scenes
        // (independent per-line calls drifted and sounded like the voice
        // changed mid-video).
        ...(previousText ? { previous_text: previousText } : {}),
        ...(nextText ? { next_text: nextText } : {}),
        // v27.1 expressiveness: lower stability + higher style read as a warm,
        // natural human read instead of the old flat/monotone 0.55/0.18.
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.85,
          style: 0.30,
          use_speaker_boost: true
        }
      })
    },
    SYNTH_TIMEOUT_MS
  );
  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${err.slice(0, 240)}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outPath, buffer);
}

// Probe whether the input MP4 has an audio stream. Used to decide whether
// to duck music or to use narration as the sole audio source.
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
