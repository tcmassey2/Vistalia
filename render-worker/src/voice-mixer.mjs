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
import { buildCaptionsAss, subtitlesFilterPath, CAPTIONS_FONTS_DIR } from "./captions.mjs";

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";
const DEFAULT_MODEL = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";
const FALLBACK_VOICE_ID = process.env.ELEVENLABS_DEFAULT_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // "Rachel"
const SYNTH_CONCURRENCY = 4;
const SYNTH_TIMEOUT_MS = 25000;
// Music volume during narration. 0.30 ≈ -10 dB on the (stem-normalized)
// bed while a line plays. Override via env DUCK_LEVEL or manifest.duckLevel.
const DUCK_LEVEL = Number(process.env.DUCK_LEVEL ?? 0.30);

// v43.3 STEM-NORMALIZED MIX (m31 finding). The final loudnorm was DYNAMIC:
// during the music fade-in it cranked gain up — boosting line 1 and its
// sibilance into audible "clatter" — then pulled everything down once the
// full bed arrived, burying the voice (~-25 dB under a -14 dB bed; the
// Cinematic track happened to be mastered ~9 dB quieter, which is why
// m30 sounded fine and MLS renders didn't). Root cause: catalog tracks
// aren't loudness-matched and TTS output level varies, so fixed relative
// gains can never hold a voice-over-music ratio. Fix: measure each stem's
// integrated loudness, apply STATIC makeup gains to hit targets, and keep
// the final stage deterministic (amix normalize=0 + limiter) — no
// time-varying gain anywhere in the chain. VOICE_WEIGHT's old +3 dB push
// is folded into VOICE_TARGET_I.
const VOICE_TARGET_I = Number(process.env.VOICE_TARGET_LUFS ?? -17); // speech
const BED_TARGET_I = Number(process.env.BED_TARGET_LUFS ?? -22);     // music between lines
const MIX_MAKEUP_DB = 3; // static lift after amix → mix lands ≈ -16 LUFS

const clampDb = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Integrated loudness (LUFS) of a file's first audio stream via ffmpeg's
// loudnorm analysis pass. Returns null on any failure — callers fail open.
async function measureLoudnessI(filePath) {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", [
      "-hide_banner", "-nostats", "-i", filePath,
      "-map", "a:0", "-af", "loudnorm=print_format=json", "-f", "null", "-"
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (c) => { stderr += c.toString(); });
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} resolve(null); }, 30000);
    proc.on("close", () => {
      clearTimeout(timer);
      const m = stderr.match(/"input_i"\s*:\s*"?(-?[\d.]+)/);
      const v = m ? Number(m[1]) : NaN;
      resolve(Number.isFinite(v) && v > -70 ? v : null);
    });
    proc.on("error", () => { clearTimeout(timer); resolve(null); });
  });
}

// Measure both stems, return static makeup gains. Fail-open: unmeasurable
// stems get 0 dB (bed) / +3 dB (voice) — roughly the old fixed-weights feel.
async function computeStemGains(masterMp4, narrationTrackPath) {
  const [bedI, voiceI] = await Promise.all([
    measureLoudnessI(masterMp4),
    measureLoudnessI(narrationTrackPath)
  ]);
  const bedGainDb = bedI == null ? 0 : clampDb(BED_TARGET_I - bedI, -18, 6);
  const voiceGainDb = voiceI == null ? 3 : clampDb(VOICE_TARGET_I - voiceI, -6, 18);
  console.info(
    `[voice] stem levels — narration ${voiceI == null ? "unmeasured" : `${voiceI.toFixed(1)} LUFS`} → ` +
    `${voiceGainDb >= 0 ? "+" : ""}${voiceGainDb.toFixed(1)}dB, music bed ` +
    `${bedI == null ? "unmeasured" : `${bedI.toFixed(1)} LUFS`} → ` +
    `${bedGainDb >= 0 ? "+" : ""}${bedGainDb.toFixed(1)}dB (static mix, no dynamic rides).`
  );
  return { bedGainDb, voiceGainDb };
}

// The shared final-mix audio chain: normalized bed → duck under lines →
// normalized voice → deterministic sum → static makeup → true-peak guard.
function buildMixAudioFilter(volumeExpr, bedGainDb, voiceGainDb) {
  return (
    `[0:a:0]volume=${bedGainDb.toFixed(1)}dB,volume=eval=frame:volume='${volumeExpr}'[ducked];` +
    `[1:a]volume=${voiceGainDb.toFixed(1)}dB[vo];` +
    `[ducked][vo]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,` +
    `volume=${MIX_MAKEUP_DB}dB,alimiter=limit=0.841:level=false[aout]`
  );
}

export async function applyVoiceNarration({ masterMp4, scenes, sceneDurationsByPhoto, crossfadeOverlapSec = 0, narrationScript = "", brandKit, tempDir, jobId, onProgress, captionsEnabled = true, captionsVariant = "luxury" }) {
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
  // v33 ALIGNED-CONTINUOUS NARRATION (primary path)
  // The per-scene lines (written per photo, in scene order — the mapping IS
  // the plan) are joined and synthesized in ONE ElevenLabs call for a single
  // continuous performance, using the with-timestamps endpoint. Character
  // timing tells us exactly where each sentence lives in the audio; each
  // sentence is cut at its true boundary and placed at ITS scene's start.
  // Alignment is correct BY CONSTRUCTION — test-7's script narrated the
  // kitchen over rooftop-deck footage because a whole-script read follows
  // the model's imagined tour order, not the actual scene order.
  // Fallback chain: aligned → whole-script layover → per-line synth.
  // ============================================================
  {
    const alignedLines = photoScenes
      .map((scene, index) => ({ scene, index, text: String(scene.narrationLine || "").trim() }))
      .filter((l) => l.text.length >= 3);
    if (alignedLines.length >= 2) {
      try {
        return await applyAlignedNarration({
          masterMp4, photoScenes, realDur, crossfadeOverlapSec,
          lines: alignedLines, voiceId, tempDir, jobId, onProgress,
          captionsEnabled, captionsVariant
        });
      } catch (err) {
        // v34.1: LOUD failure with the real cause — this error was being
        // summarized away, and the silent fallback to the whole-script
        // layover reintroduced wrong-order narration for multiple smoke
        // tests while looking like the aligned path from the outside.
        console.error(`[voice] ALIGNED PATH FAILED — falling back to per-line. Cause: ${err.stack || err.message}`);
      }
    }
  }

  // v34.1: the whole-script layover is REMOVED from the fallback chain. It
  // narrates the model's imagined tour order, not the actual scene order —
  // the only path capable of wrong-room narration. With it gone, both
  // remaining paths (aligned, per-line) are scene-locked by construction:
  // the worst possible failure is choppier delivery, never irrelevant
  // narration. (applyContinuousNarration is retained below, unused, for
  // reference.)
  void narrationScript;

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
  const sceneStarts = []; // start time of each scene in seconds (VISUAL timeline)
  const sceneDurs = [];   // VISIBLE duration of each scene on the master
  let cursor = 0;
  // v31 pipeline-audit fix: with crossfades, each join eats crossfadeOverlapSec
  // (0.5s) of clip, so the VISIBLE window of a scene is clipDuration - overlap
  // and scene k starts at the sum of visible windows before it — the raw
  // clip-duration sum drifted every line (k-1)*overlap late vs picture and
  // over-stated the narration track length by the same amount. The final photo
  // clip's tail overlap is absorbed by the outro-card crossfade, so the
  // uniform (d - overlap) window is exact for every scene.
  for (const sc of photoScenes) {
    const d = realDur(sc, Number(sc.duration || 3));
    const visible = Math.max(0.8, d - crossfadeOverlapSec);
    sceneStarts.push(cursor);
    sceneDurs.push(visible);
    cursor += visible;
  }
  const totalDurationSec = cursor;

  // v28.1: voice is capped strictly to the PHOTO scenes — it must NEVER bleed
  // over the silent brand-outro card (that read as unclean). Lines are sized to
  // fit upstream: create-edit-plan sets each narrated scene's duration to its
  // line's spoken length, so the line finishes naturally inside its own scene
  // instead of being chopped or spilling into the outro.
  const narrationTrackDurSec = totalDurationSec;
  // v34.2 last-line grace — same rationale as the aligned path: the CTA may
  // end 0.8s into the outro CROSSFADE (never over the standing card).
  const PL_GRACE_SEC = 0.8;
  const narrTrackPadSec = narrationTrackDurSec + PL_GRACE_SEC;
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
      // v31.1 flowing narration: a line's window runs to the start of the NEXT
      // NARRATED scene, not the next cut. With dense v31 plans (alternating
      // ~4s/2s scenes on some beat grids) short scenes carry no line of their
      // own — their airtime belongs to the previous line so sentences flow
      // across quick cuts instead of being chopped into fragments. Overlap
      // with the next LINE remains impossible: the window ends where the
      // next narrated scene begins.
      const isLast = i === lastNarrIndex;
      let windowEndSec = sceneStarts[i] + sceneDur;
      if (isLast) {
        // Last line: run up to the master end + grace (video continues into
        // the silent brand-outro card's crossfade).
        windowEndSec = Math.max(windowEndSec, narrTrackPadSec);
      } else {
        for (let j = i + 1; j < synthesized.length; j++) {
          if (synthesized[j]) { windowEndSec = sceneStarts[j]; break; }
          windowEndSec = sceneStarts[j] + sceneDurs[j];
        }
      }
      const windowDur = windowEndSec - sceneStarts[i];
      // Two guards: subtractive (window - leadIn - tail) AND, for non-final
      // lines only, proportional (90% of the full window). Min of the two.
      const cap1 = windowDur - leadInSec - TAIL_BUFFER_SEC;
      const cap2 = isLast ? Infinity : windowDur * 0.90;
      const maxNarrationSec = Math.max(0.6, Math.min(cap1, cap2));
      const sceneEndMs = Math.round(windowEndSec * 1000);
      return {
        mp3Path: entry.mp3Path,
        sceneStartSec: sceneStarts[i],
        sceneDurSec: windowDur,
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
      // Duck music through each line's FULL (v31.1 extended) window — to the
      // next narrated scene, or master end for the last line.
      let endSec = sceneStarts[i] + sceneDurs[i];
      if (i === lastNarrIndex) {
        endSec = narrTrackPadSec;
      } else {
        for (let j = i + 1; j < synthesized.length; j++) {
          if (synthesized[j]) { endSec = sceneStarts[j]; break; }
          endSec = sceneStarts[j] + sceneDurs[j];
        }
      }
      return [sceneStarts[i] + leadInSec, endSec - 0.2];
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
  // v31.3 MEASURE-AND-FIT: the word budget assumes a speaking rate, but the
  // v27 "natural read" ElevenLabs settings speak slower — lines ran ~15-20%
  // past their windows and the atrim cap CHOPPED them mid-sentence ("cuts
  // itself off too soon", round-3 smoke test). Instead of assuming, probe
  // each synthesized MP3's real duration: overruns up to 15% are absorbed
  // with atempo time-compression (≤1.15x is imperceptible on speech);
  // anything still over gets the old trim+fade as a last resort. Lines that
  // fit are left completely untouched — no fade nibbling their natural tail.
  for (const n of placedNarrations) {
    n.mp3DurSec = await probeAudioDuration(n.mp3Path);
  }
  const adelaySteps = placedNarrations
    .map((n, i) => {
      const cap = n.maxNarrationSec;
      const dur = n.mp3DurSec > 0 ? n.mp3DurSec : cap; // probe failed → old behavior
      let tempo = 1;
      if (dur > cap) tempo = Math.min(1.15, dur / cap);
      const effective = dur / tempo;
      const trimmed = effective > cap + 0.05;
      console.info(
        `[voice] line ${i + 1}: mp3 ${dur.toFixed(2)}s vs window ${cap.toFixed(2)}s` +
        (tempo > 1.005 ? ` → atempo ${tempo.toFixed(3)}` : "") +
        (trimmed ? " → TRIM+fade (still over)" : " → fits clean")
      );
      const chain = [
        tempo > 1.005 ? `atempo=${tempo.toFixed(4)}` : null,
        `atrim=duration=${cap.toFixed(2)}`,
        `asetpts=PTS-STARTPTS`,
        `afade=t=in:st=0:d=${FADE_IN_SEC}`,
        trimmed ? `afade=t=out:st=${Math.max(0, cap - FADE_OUT_SEC).toFixed(2)}:d=${FADE_OUT_SEC.toFixed(2)}` : null,
        `adelay=${n.delayMs}|${n.delayMs}`,
        `apad=whole_dur=${n.sceneEndMs}ms`
      ].filter(Boolean).join(",");
      return `[${i + 1}:a]${chain}[n${i}]`;
    })
    .join(";");
  const mixInputs = placedNarrations.map((_, i) => `[n${i}]`).join("");
  // v43.4 normalize=0: amix's default normalization divides every input by
  // the input COUNT — with N lines + the silent base, speech shipped at
  // -20·log10(N+1) dB (m32: 7 inputs = -16.9 dB, narration track measured
  // -43 LUFS and saturated the stem-gain clamp). The old dynamic loudnorm
  // masked this for months. Lines never overlap (windows are sequential),
  // so summing at native level cannot clip.
  const filterComplex = `${adelaySteps};[0:a]${mixInputs}amix=inputs=${placedNarrations.length + 1}:duration=first:dropout_transition=0:normalize=0,atrim=duration=${narrTrackPadSec}[narr]`;

  const narrationTrackPath = path.join(tempDir, `${jobId}-narration-track.mp3`);
  const narrationArgs = [
    "-y",
    "-threads", "1",
    "-f", "lavfi",
    "-i", `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${narrTrackPadSec}`,
    ...placedNarrations.flatMap((n) => ["-i", n.mp3Path]),
    "-filter_complex", filterComplex,
    "-map", "[narr]",
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    "-t", String(narrTrackPadSec),
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
    const { bedGainDb, voiceGainDb } = await computeStemGains(masterMp4, narrationTrackPath);
    await runFFmpeg([
      "-y",
      "-threads", "1",
      "-i", masterMp4,
      "-i", narrationTrackPath,
      "-filter_complex",
      buildMixAudioFilter(volumeExpr, bedGainDb, voiceGainDb),
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
   v33 — aligned-continuous narration
   ============================================================ */

async function applyAlignedNarration({ masterMp4, photoScenes, realDur, crossfadeOverlapSec, lines, voiceId, tempDir, jobId, onProgress, captionsEnabled = true, captionsVariant = "luxury" }) {
  // Visible timeline (same model as everywhere): scene k starts at the sum
  // of visible durations before it.
  const sceneStarts = [];
  const sceneVisible = [];
  let cursor = 0;
  for (const sc of photoScenes) {
    const d = realDur(sc, Number(sc.duration || 3));
    const vis = Math.max(0.8, d - crossfadeOverlapSec);
    sceneStarts.push(cursor);
    sceneVisible.push(vis);
    cursor += vis;
  }
  const trackDurSec = cursor;
  const leadInSec = 0.35;
  // v34.2 last-line grace (test-11): the CTA line's window used to end hard
  // at the last photo scene's cut, so a short final scene (2.5s on fast beat
  // grids) forced atempo 1.15 + TRIM on the one line that must land clean.
  // The master continues 0.5s of crossfade INTO the brand-outro card — let
  // the closer breathe 0.8s into that fade. It ends during the transition,
  // never over the standing card (the v28.1 complaint was mid-card speech).
  const LAST_LINE_GRACE_SEC = 0.8;
  const trackPadSec = trackDurSec + LAST_LINE_GRACE_SEC;

  // One text, one performance. Ensure sentence-final punctuation per line so
  // the read pauses naturally at what will become our cut points.
  const texts = lines.map((l) => (/[.!?]$/.test(l.text) ? l.text : `${l.text}.`));
  const joined = texts.join(" ");

  onProgress?.({ phase: "Synthesizing voiceover", fraction: 0.2 });
  const { audioPath, alignment } = await synthesizeWithTimestamps({
    text: joined, voiceId, tempDir, jobId,
    settingsOverride: { stability: 0.55, similarity_boost: 0.85, style: 0.15, use_speaker_boost: true }
  });
  if (!alignment?.characters?.length) throw new Error("no character alignment returned");

  // Map each line's character range in `joined` to audio time.
  const chars = alignment.characters;
  const starts = alignment.character_start_times_seconds;
  const ends = alignment.character_end_times_seconds;
  const segs = [];
  let charCursor = 0;
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    const from = charCursor;               // first char of this line in `joined`
    const to = charCursor + t.length;      // exclusive
    charCursor = to + 1;                   // skip the joining space
    // Guard against provider-side normalization shifting characters: clamp.
    const a = Math.min(from, chars.length - 1);
    const b = Math.min(to - 1, chars.length - 1);
    const segStart = Math.max(0, (starts[a] ?? 0) - 0.03);
    const segEnd = Math.min((ends[b] ?? segStart + 1) + 0.05, ends[ends.length - 1] ?? segStart + 1);
    segs.push({ index: lines[i].index, segStart, segEnd, dur: Math.max(0.2, segEnd - segStart), charFrom: from, charTo: to });
  }

  // Placement: sentence i starts at its scene start (+lead-in); its window
  // runs to the NEXT narrated scene's start (flowing-window model). Overruns
  // get per-segment atempo ≤1.15, then trim+fade as last resort.
  const placements = segs.map((s, i) => {
    const startAt = sceneStarts[s.index] + leadInSec;
    const nextStart = i + 1 < segs.length ? sceneStarts[segs[i + 1].index] : trackPadSec;
    const cap = Math.max(0.6, nextStart - startAt - 0.15);
    let tempo = 1;
    if (s.dur > cap) tempo = Math.min(1.15, s.dur / cap);
    const effective = s.dur / tempo;
    const trimmed = effective > cap + 0.05;
    console.info(
      `[voice] aligned line ${i + 1} → scene ${s.index + 1}: audio ${s.segStart.toFixed(2)}-${s.segEnd.toFixed(2)}s ` +
      `(${s.dur.toFixed(2)}s) @ t=${startAt.toFixed(2)}s, window ${cap.toFixed(2)}s` +
      (tempo > 1.005 ? ` atempo ${tempo.toFixed(3)}` : "") + (trimmed ? " TRIM" : "")
    );
    return { ...s, startAt, cap, tempo, trimmed };
  });

  // v38 WORD-SYNCED CAPTIONS: the alignment already gives us character
  // times; map each word through its line's placement (offset + atempo)
  // into VIDEO time. Two ASS tracks are written — vertical master and
  // square variant geometry — and burned during the final mixes.
  let captionsAssPath = null;
  let captionsSquareAssPath = null;
  if (captionsEnabled) {
    try {
      const words = [];
      for (let i = 0; i < placements.length; i++) {
        const p = placements[i];
        const text = texts[i];
        let wStart = -1;
        let firstOfLine = true; // v38.1: caption pages never straddle lines
        for (let c = 0; c <= text.length; c++) {
          const isSpace = c === text.length || /\s/.test(text[c]);
          if (!isSpace && wStart < 0) wStart = c;
          if (isSpace && wStart >= 0) {
            const gi0 = Math.min(p.charFrom + wStart, chars.length - 1);
            const gi1 = Math.min(p.charFrom + c - 1, chars.length - 1);
            const aStart = starts[gi0] ?? p.segStart;
            const aEnd = ends[gi1] ?? aStart + 0.2;
            let vStart = p.startAt + (aStart - p.segStart) / p.tempo;
            let vEnd = p.startAt + (aEnd - p.segStart) / p.tempo;
            const capEnd = p.startAt + p.cap;
            if (vStart < capEnd - 0.05) {
              vEnd = Math.min(vEnd, capEnd);
              words.push({
                text: text.slice(wStart, c).replace(/[.,!?]+$/, ""),
                start: vStart,
                end: vEnd,
                lineStart: firstOfLine
              });
              firstOfLine = false;
            }
            wStart = -1;
          }
        }
      }
      if (words.length) {
        captionsAssPath = path.join(tempDir, `${jobId}-captions-v.ass`);
        captionsSquareAssPath = path.join(tempDir, `${jobId}-captions-sq.ass`);
        await fs.writeFile(captionsAssPath, buildCaptionsAss({ words, playW: 1080, playH: 1920, variant: captionsVariant }));
        await fs.writeFile(captionsSquareAssPath, buildCaptionsAss({ words, playW: 1080, playH: 1080, variant: captionsVariant }));
        console.info(`[captions] ${words.length} words → ${path.basename(captionsAssPath)} (word-synced, skin=${captionsVariant})`);
      }
    } catch (err) {
      console.warn(`[captions] build failed open (${err.message}) — shipping without captions.`);
      captionsAssPath = null;
      captionsSquareAssPath = null;
    }
  }

  onProgress?.({ phase: "Building narration track", fraction: 0.6 });
  const steps = placements.map((p, i) => {
    const chain = [
      `atrim=start=${p.segStart.toFixed(3)}:end=${p.segEnd.toFixed(3)}`,
      "asetpts=PTS-STARTPTS",
      p.tempo > 1.005 ? `atempo=${p.tempo.toFixed(4)}` : null,
      p.trimmed ? `atrim=duration=${p.cap.toFixed(2)}` : null,
      "afade=t=in:st=0:d=0.04",
      p.trimmed ? `afade=t=out:st=${Math.max(0, p.cap - 0.3).toFixed(2)}:d=0.30` : null,
      `adelay=${Math.round(p.startAt * 1000)}|${Math.round(p.startAt * 1000)}`,
      `apad=whole_dur=${Math.round(trackPadSec * 1000)}ms`
    ].filter(Boolean).join(",");
    return `[1:a]${chain}[s${i}]`;
  });
  const mixIns = placements.map((_, i) => `[s${i}]`).join("");
  // v43.4 normalize=0 — see the per-line builder note: default amix
  // normalization was attenuating speech by -20·log10(N+1) dB. Aligned
  // placements are strictly sequential; native-level sum cannot clip.
  const filterComplex =
    `${steps.join(";")};[0:a]${mixIns}amix=inputs=${placements.length + 1}:duration=first:dropout_transition=0:normalize=0,atrim=duration=${trackPadSec}[narr]`;

  const narrationTrackPath = path.join(tempDir, `${jobId}-narration-track.mp3`);
  await runFFmpeg([
    "-y", "-threads", "1",
    "-f", "lavfi", "-i", `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${trackPadSec}`,
    "-i", audioPath,
    "-filter_complex", filterComplex,
    "-map", "[narr]",
    "-c:a", "libmp3lame", "-b:a", "128k",
    "-t", String(trackPadSec),
    narrationTrackPath
  ], { timeoutMs: 120000, label: "voice:aligned-track" });

  onProgress?.({ phase: "Mixing narration with music", fraction: 0.85 });
  const duckWindows = placements.map((p) => {
    const end = Math.min(trackPadSec, p.startAt + Math.min(p.dur / p.tempo, p.cap) + 0.15);
    return [Math.max(0, p.startAt - 0.1), end];
  });
  const duckExpr = duckWindows.map(([s, e]) => `between(t,${s.toFixed(2)},${e.toFixed(2)})`).join("+");
  const volumeExpr = `if(${duckExpr},${DUCK_LEVEL},1)`;
  const mixedMp4 = path.join(tempDir, `${jobId}-narrated.mp4`);
  const masterHasAudio = await detectAudioStream(masterMp4);

  if (masterHasAudio) {
    const vf = captionsAssPath
      ? [`[0:v:0]subtitles='${subtitlesFilterPath(captionsAssPath)}':fontsdir='${subtitlesFilterPath(CAPTIONS_FONTS_DIR)}'[vout];`, "[vout]", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "superfast", "-crf", "19"]]
      : ["", "0:v:0", ["-c:v", "copy"]];
    const { bedGainDb, voiceGainDb } = await computeStemGains(masterMp4, narrationTrackPath);
    await runFFmpeg([
      "-y", "-threads", "1",
      "-i", masterMp4, "-i", narrationTrackPath,
      "-filter_complex",
      vf[0] + buildMixAudioFilter(volumeExpr, bedGainDb, voiceGainDb),
      "-map", vf[1], "-map", "[aout]",
      ...vf[2], "-c:a", "aac", "-b:a", "192k",
      "-shortest", mixedMp4
    ], { timeoutMs: captionsAssPath ? 240000 : 90000, label: "voice:aligned-final-mix" });
  } else {
    await runFFmpeg([
      "-y", "-threads", "1",
      "-i", masterMp4, "-i", narrationTrackPath,
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
      "-map", "0:v:0", "-map", "1:a:0",
      "-shortest", mixedMp4
    ], { timeoutMs: 60000, label: "voice:aligned-mix-narration-only" });
  }

  await fs.unlink(audioPath).catch(() => {});
  await fs.unlink(narrationTrackPath).catch(() => {});

  return {
    masterMp4: mixedMp4,
    narrationApplied: true,
    voiceId,
    narrationLineCount: placements.length,
    aligned: true,
    captionsApplied: Boolean(captionsAssPath),
    captionsSquareAssPath
  };
}

// Single TTS call returning audio + character-level timing.
async function synthesizeWithTimestamps({ text, voiceId, tempDir, jobId, settingsOverride = null }) {
  const response = await fetchWithTimeout(
    `${ELEVENLABS_BASE}/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`,
    {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        model_id: DEFAULT_MODEL,
        voice_settings: settingsOverride || { stability: 0.55, similarity_boost: 0.85, style: 0.15, use_speaker_boost: true }
      })
    },
    SYNTH_TIMEOUT_MS * 3 // long-form single call — give it real headroom
  );
  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`ElevenLabs with-timestamps failed (${response.status}): ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  if (!data?.audio_base64) throw new Error("with-timestamps returned no audio");
  const audioPath = path.join(tempDir, `${jobId}-aligned-full.mp3`);
  await fs.writeFile(audioPath, Buffer.from(data.audio_base64, "base64"));
  return { audioPath, alignment: data.alignment || data.normalized_alignment || null };
}

/* ============================================================
   v32 — continuous narration
   ============================================================ */

async function applyContinuousNarration({ masterMp4, photoScenes, realDur, crossfadeOverlapSec, script, voiceId, tempDir, jobId, onProgress }) {
  // Visible photo-section length (same model as the per-line path): each
  // crossfade join eats crossfadeOverlapSec of clip.
  let trackDurSec = 0;
  for (const sc of photoScenes) {
    const d = realDur(sc, Number(sc.duration || 3));
    trackDurSec += Math.max(0.8, d - crossfadeOverlapSec);
  }
  const leadInSec = 0.35;
  const tailGuardSec = 0.4;
  const availSec = Math.max(3, trackDurSec - leadInSec - tailGuardSec);

  onProgress?.({ phase: "Synthesizing voiceover", fraction: 0.2 });
  const mp3Path = path.join(tempDir, `${jobId}-narration-script.mp3`);
  // Long-form read profile: the v27 per-line settings (stability 0.45,
  // style 0.30) were tuned for 5-word expressive fragments and can wander
  // or glitch over a 50+ word read. Steadier profile for the single pass.
  await synthesizeToFile({
    text: script, voiceId, outPath: mp3Path,
    settingsOverride: { stability: 0.55, similarity_boost: 0.85, style: 0.15, use_speaker_boost: true }
  });

  const rawDur = await probeAudioDuration(mp3Path);
  const dur = rawDur > 0 ? rawDur : availSec;
  let tempo = 1;
  if (dur > availSec) tempo = Math.min(1.15, dur / availSec);
  const effective = dur / tempo;
  const trimmed = effective > availSec + 0.05;
  console.info(
    `[voice] continuous script: ${script.split(/\s+/).length} words, mp3 ${dur.toFixed(2)}s, ` +
    `photo section ${trackDurSec.toFixed(2)}s, avail ${availSec.toFixed(2)}s` +
    (tempo > 1.005 ? ` → atempo ${tempo.toFixed(3)}` : "") +
    (trimmed ? " → TRIM+fade tail (script over budget)" : " → fits")
  );

  onProgress?.({ phase: "Building narration track", fraction: 0.6 });
  const chain = [
    tempo > 1.005 ? `atempo=${tempo.toFixed(4)}` : null,
    `atrim=duration=${availSec.toFixed(2)}`,
    "asetpts=PTS-STARTPTS",
    "afade=t=in:st=0:d=0.08",
    trimmed ? `afade=t=out:st=${Math.max(0, availSec - 0.6).toFixed(2)}:d=0.60` : null,
    `adelay=${Math.round(leadInSec * 1000)}|${Math.round(leadInSec * 1000)}`,
    `apad=whole_dur=${Math.round(trackDurSec * 1000)}ms`
  ].filter(Boolean).join(",");
  const filterComplex =
    `[1:a]${chain}[n0];[0:a][n0]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,atrim=duration=${trackDurSec}[narr]`;

  const narrationTrackPath = path.join(tempDir, `${jobId}-narration-track.mp3`);
  await runFFmpeg([
    "-y", "-threads", "1",
    "-f", "lavfi", "-i", `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${trackDurSec}`,
    "-i", mp3Path,
    "-filter_complex", filterComplex,
    "-map", "[narr]",
    "-c:a", "libmp3lame", "-b:a", "128k",
    "-t", String(trackDurSec),
    narrationTrackPath
  ], { timeoutMs: 90000, label: "voice:continuous-track" });

  onProgress?.({ phase: "Mixing narration with music", fraction: 0.85 });
  const speechEnd = Math.min(trackDurSec, leadInSec + Math.min(effective, availSec) + 0.2);
  const volumeExpr = `if(between(t,${(leadInSec - 0.1).toFixed(2)},${speechEnd.toFixed(2)}),${DUCK_LEVEL},1)`;
  const mixedMp4 = path.join(tempDir, `${jobId}-narrated.mp4`);
  const masterHasAudio = await detectAudioStream(masterMp4);

  if (masterHasAudio) {
    const { bedGainDb, voiceGainDb } = await computeStemGains(masterMp4, narrationTrackPath);
    await runFFmpeg([
      "-y", "-threads", "1",
      "-i", masterMp4,
      "-i", narrationTrackPath,
      "-filter_complex",
      buildMixAudioFilter(volumeExpr, bedGainDb, voiceGainDb),
      "-map", "0:v:0", "-map", "[aout]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
      "-shortest",
      mixedMp4
    ], { timeoutMs: 90000, label: "voice:continuous-final-mix" });
  } else {
    await runFFmpeg([
      "-y", "-threads", "1",
      "-i", masterMp4, "-i", narrationTrackPath,
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
      "-map", "0:v:0", "-map", "1:a:0",
      "-shortest",
      mixedMp4
    ], { timeoutMs: 60000, label: "voice:continuous-mix-narration-only" });
  }

  await fs.unlink(mp3Path).catch(() => {});
  await fs.unlink(narrationTrackPath).catch(() => {});

  return {
    masterMp4: mixedMp4,
    narrationApplied: true,
    voiceId,
    narrationLineCount: 1,
    continuous: true
  };
}

/* ============================================================
   Helpers
   ============================================================ */

async function synthesizeToFile({ text, voiceId, outPath, previousText = "", nextText = "", settingsOverride = null }) {
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
        // v32: continuous long-form reads pass settingsOverride (steadier
        // profile) — the expressive per-line profile wanders on 50+ words.
        voice_settings: settingsOverride || {
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
// v31.3: real duration of a synthesized narration MP3 (0 on failure —
// callers treat 0 as "unknown, use legacy behavior").
async function probeAudioDuration(filePath) {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      filePath
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.on("close", () => resolve(Number(stdout.trim()) || 0));
    proc.on("error", () => resolve(0));
  });
}

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
