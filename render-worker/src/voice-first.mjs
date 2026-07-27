// Vistalia — v62 VOICE-FIRST narration engine.
//
// THE INVERSION (Troy, day 13: "Invert the performance and use the new
// expressive features"): narration is performed FIRST — one continuous
// monologue, one expressive ElevenLabs pass — and its word timestamps
// BECOME the scene-timing grid. Scenes flex to the voice. Nothing ever
// squeezes the voice into windows again: atempo, TRIM, per-line placement
// and the 2-line-collapse class (m80) are structurally impossible on this
// path, not merely guarded against.
//
// Pipeline position: runs at the FRONT of renderRunwayJob, BEFORE any clip
// generation — a narration failure costs ~seconds and zero fal spend, and
// per-scene clip durations derive from the grid.
//
// Synthesis rungs (clones must survive — ElevenLabs both rungs):
//   1. EXPRESSIVE: eleven_v3 reads the tagged monologue ([warm]/[pause]/…),
//      then POST /v1/forced-alignment maps the CLEAN transcript to word
//      timestamps (v3 has no with-timestamps support; alignment is a
//      separate, model-agnostic call).
//   2. PROVEN: eleven_turbo_v2_5 (current production model) via
//      with-timestamps — character alignment grouped into words. Fires when
//      v3 or forced-alignment errors, or VOICE_FIRST_V3=0.
// Both rungs produce the same shape: { audioPath, words:[{word,start,end}] }
// — the grid math never knows which rung ran.
//
// Kill switches: VOICE_FIRST=0 disables the whole path (legacy per-line →
// aligned machinery untouched, instant rollback). VOICE_FIRST_V3=0 keeps
// the inversion but pins synthesis to the proven model.

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { runFFmpeg } from "./ffmpeg-runner.mjs";

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";
const V3_MODEL = process.env.ELEVENLABS_V3_MODEL_ID || "eleven_v3";
const TIMESTAMP_MODEL = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";
const SYNTH_TIMEOUT_MS = 90000;   // long-form single call, worst case
const ALIGN_TIMEOUT_MS = 60000;

// ── Grid constants ────────────────────────────────────────────────────
export const LEAD_IN_SEC = 0.60;     // silence before the first word
export const CUT_PREROLL_SEC = 0.15; // a room appears just before it's named
export const TAIL_PAD_SEC = 1.20;    // breath after the last word, pre-outro
export const MIN_SCENE_SEC = 1.80;   // never flash-cut
// Visible-scene ceiling: ask = visible + 0.5 xfade comp, and the Kling ask
// caps at 10s — so a scene may show at most 9.5s of one clip. A longer
// sentence SPILLS: the cut comes at 9.5s and the narration finishes over
// the next room (what human tour videos do), never a trim, never a drop.
export const MAX_SCENE_VISIBLE_SEC = 9.5;

export function stripAudioTags(text) {
  return String(text || "").replace(/\[[^\][\n]{1,40}\]/g, " ").replace(/\s+/g, " ").trim();
}

const norm = (w) => String(w || "").toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

// Assign aligned words to sentences by consuming the transcript in order.
// Tokenizer drift (hyphens, numerals read as words) is absorbed by matching
// counts, not exact tokens — the transcript and the sentence list are the
// same text by contract (validated plan-side AND re-checked here).
export function wordsToSentences(sentences, words) {
  const out = sentences.map(() => []);
  let wi = 0;
  for (let si = 0; si < sentences.length; si++) {
    const toks = String(sentences[si].text || "").split(/\s+/).map(norm).filter(Boolean);
    let matched = 0;
    while (wi < words.length && matched < toks.length) {
      if (!norm(words[wi].word)) { wi++; continue; }
      out[si].push(words[wi]);
      wi++;
      matched++;
    }
  }
  while (wi < words.length) { out[out.length - 1].push(words[wi]); wi++; }
  return out;
}

// Choose n-1 cut TIMES inside [t0,t1] for a multi-photo sentence. Prefer the
// largest word gaps (breaths, commas); fall back to equal-time division when
// gap cuts can't respect minScene. Cuts are continuous — a visual cut
// mid-phrase is normal film grammar; the audio never pauses for it.
function chooseCutTimes(wordRun, t0, t1, n, minScene) {
  if (n <= 1) return [];
  const even = Array.from({ length: n - 1 }, (_, k) => t0 + ((k + 1) * (t1 - t0)) / n);
  const gaps = [];
  for (let i = 0; i < wordRun.length - 1; i++) {
    gaps.push({ t: (wordRun[i].end + wordRun[i + 1].start) / 2, gap: wordRun[i + 1].start - wordRun[i].end });
  }
  gaps.sort((a, b) => b.gap - a.gap);
  const picked = [];
  for (const g of gaps) {
    if (picked.length >= n - 1) break;
    if (g.t <= t0 || g.t >= t1) continue;
    const cand = [...picked, g.t].sort((a, b) => a - b);
    const edges = [t0, ...cand, t1];
    let okAll = true;
    for (let i = 0; i < edges.length - 1; i++) {
      if (edges[i + 1] - edges[i] < minScene) { okAll = false; break; }
    }
    if (okAll) picked.push(g.t);
  }
  return picked.length === n - 1 ? picked.sort((a, b) => a - b) : even;
}

/* ════════════════════════════════════════════════════════════════════
   v62.36 — THE DURATION CONTRACT, IN SECONDS

   The customer orders 30 or 60 seconds. Under voice-first the video's
   length IS the narration's length, so that order is a promise about the
   voice — but every gate on it upstream is denominated in WORDS, and
   words do not convert to seconds at a fixed rate. Speech time is

       leadIn + Σ(word durations) + Σ(gaps) + tailPad

   and the gaps split into intra-sentence breaths and the much longer
   pauses a voice takes at a full stop. Those scale with the sentence
   COUNT, not the word count, which is why measured pace ranges 2.13-2.80
   w/s across real renders and why an in-band 80-word script shipped a
   37.6s video on a 30s order.

   No estimator fixes that; it only narrows it. But the worker does not
   have to estimate. By the time this function has synthesized and
   aligned, it holds the real word timestamps — the exact final length is
   known at progress 7, BEFORE a single clip is submitted. manifest
   .targetDurationSec has been riding along all this time (audit-log reads
   it; nothing else ever did). So: measure, and if the voice overshot,
   cut sentences out of the AUDIO at the silences we can see, drop their
   scenes before we pay to generate them, and rebuild the grid from what
   is left. No re-synthesis, no atempo — the two things v62 exists to
   avoid.
   ════════════════════════════════════════════════════════════════════ */

// How much audio disappears if sentence k is removed: its own speech plus
// the one pause that preceded it. The pause that followed k survives and
// becomes the boundary between k-1 and k+1 — so a cut leaves exactly one
// gap where there were two, which is what every other boundary looks like.
function spanRemovedBy(perSentence, k) {
  const prevEnd = perSentence[k - 1][perSentence[k - 1].length - 1].end;
  const ownEnd = perSentence[k][perSentence[k].length - 1].end;
  return { start: prevEnd, end: ownEnd, sec: ownEnd - prevEnd };
}

/**
 * Choose which sentences to drop so the video lands inside its order.
 * Never the hook (0) or the CTA (last) — those are the two lines an ad
 * cannot lose. Greedy: each step takes the drop that lands closest to
 * target without falling through the floor.
 *
 * @returns { drop:number[], projectedSec, spans:[{start,end}] } | null
 */
export function planDurationTrim(perSentence, videoEndSec, targetSec, opts = {}) {
  const {
    ceilingSec = targetSec + Math.max(2, targetSec * 0.08),
    floorSec = targetSec * 0.75,
    minSentences = 3,
    minPhotos = 5,
    photosPerSentence = null // ordinal counts, to honour the 5-scene floor
  } = opts;
  if (!Number.isFinite(targetSec) || targetSec <= 0) return null;
  if (!(videoEndSec > ceilingSec)) return null;
  const n = perSentence.length;
  if (n < minSentences + 1) return null;

  const alive = new Set(perSentence.map((_, i) => i));
  const dropped = [];
  let projected = videoEndSec;
  const photosLeft = () => (photosPerSentence
    ? [...alive].reduce((a, i) => a + (photosPerSentence[i] || 0), 0)
    : Infinity);

  for (let guard = 0; guard < n && projected > ceilingSec; guard++) {
    // v62.36a: "change nothing" is a scored candidate, not the fallback.
    // Without it the loop took ANY drop that cleared the floor, so a 33.0s
    // video 0.6s over the ceiling could lose its only droppable sentence
    // and land at 22.8s — 7.2s UNDER the order, a third of the script gone,
    // and further from what the customer bought than doing nothing. A cut
    // has to earn its place by getting CLOSER to the order, or it is just
    // deleting the customer's content.
    let best = { k: null, after: projected, score: Math.abs(projected - targetSec) };
    for (let k = 1; k < n - 1; k++) {
      if (!alive.has(k)) continue;
      if (!perSentence[k].length || !perSentence[k - 1]?.length) continue;
      if (alive.size - 1 < minSentences) continue;
      if (photosLeft() - (photosPerSentence?.[k] || 0) < minPhotos) continue;
      const { sec } = spanRemovedBy(perSentence, k);
      const after = projected - sec;
      if (after < floorSec) continue;
      const score = Math.abs(after - targetSec);
      if (score < best.score) best = { k, sec, after, score };
    }
    if (best.k === null) break;
    alive.delete(best.k);
    dropped.push(best.k);
    projected = best.after;
  }

  if (!dropped.length) return null;
  dropped.sort((a, b) => a - b);
  // Spans are computed against the ORIGINAL timeline, so adjacent drops
  // chain correctly: [prev.end, k.end] and [k.end, k+1.end] abut.
  const spans = dropped.map((k) => {
    const { start, end } = spanRemovedBy(perSentence, k);
    return { start, end, sentenceIndex: k };
  });
  return { drop: dropped, projectedSec: +projected.toFixed(3), spans };
}

/**
 * Apply removal spans to a word list: drop the words inside them and pull
 * everything after each span earlier by its length. Pure — used by the
 * audio cut so picture and voice come from the same arithmetic.
 */
export function shiftWordsAfterCuts(words, spans) {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out = [];
  for (const w of words) {
    let shift = 0;
    let inside = false;
    for (const s of sorted) {
      if (w.start >= s.end) shift += s.end - s.start;
      else if (w.end > s.start) { inside = true; break; }
    }
    if (inside) continue;
    out.push({ ...w, start: +(w.start - shift).toFixed(4), end: +(w.end - shift).toFixed(4) });
  }
  return out;
}

// buildVoiceGrid(narration, words) → the grid the pipeline obeys.
//   narration.sentences: [{ text, photos: [sceneOrdinal…] }] — ordinals into
//   the PHOTO-SCENE list (0-based, ascending, each exactly once; [] = linger
//   on the current photo).
//   words: [{ word, start, end }] in AUDIO time.
// Returns { scenes:[{ photoOrdinal, start, end, duration, sentenceIndex }],
//           narrationOffsetSec, videoEndSec, sentenceSpansSec, stats }.
// Scene times are VISIBLE video time; contiguous from 0 by construction.
export function buildVoiceGrid(narration, words, opts = {}) {
  const {
    leadIn = LEAD_IN_SEC,
    cutPreroll = CUT_PREROLL_SEC,
    tailPad = TAIL_PAD_SEC,
    minScene = MIN_SCENE_SEC,
    maxSceneVisible = MAX_SCENE_VISIBLE_SEC
  } = opts;
  const warnings = [];

  if (!narration?.sentences?.length) throw new Error("voice-grid: no sentences");
  if (!words?.length) throw new Error("voice-grid: no aligned words");

  const offset = leadIn - words[0].start; // lay audio so word 1 lands at leadIn
  const t = (x) => x + offset;
  const perSentence = wordsToSentences(narration.sentences, words);

  // 1) Group sentences into PHOTO RUNS ([] = linger extends the current run).
  const runs = [];
  for (let si = 0; si < narration.sentences.length; si++) {
    const s = narration.sentences[si];
    const ws = perSentence[si];
    const photos = (s.photos || []).slice().sort((a, b) => a - b);
    if (!photos.length && runs.length) {
      const r = runs[runs.length - 1];
      r.sentenceIndices.push(si);
      r.words.push(...ws);
    } else if (!photos.length) {
      warnings.push("sentence 0 has no photos — pinned to photo 0");
      runs.push({ photos: [0], sentenceIndices: [si], words: [...ws] });
    } else {
      runs.push({ photos, sentenceIndices: [si], words: [...ws] });
    }
  }
  // Re-home photos of word-less sentences so no photo silently vanishes.
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].words.length) continue;
    const home = runs[i - 1] || runs[i + 1];
    if (home) {
      home.photos.push(...runs[i].photos);
      home.photos.sort((a, b) => a - b);
      warnings.push(`sentence ${runs[i].sentenceIndices[0]} aligned to no words — photos re-homed`);
      runs.splice(i, 1);
    }
  }
  if (!runs.length) throw new Error("voice-grid: no photo runs derived");

  // 1b) Merge runs whose span can't hold their photos at minScene each
  //     (rapid-fire sentences). Photos concatenate — nothing vanishes here;
  //     the capacity check below is the only honest dropper (fallback class).
  const runSpan = (ri) => {
    const run = runs[ri];
    const next = runs[ri + 1];
    const t0 = ri === 0 ? 0 : t(run.words[0].start) - cutPreroll;
    const t1 = next ? t(next.words[0].start) - cutPreroll
      : t(run.words[run.words.length - 1].end) + tailPad;
    return t1 - t0;
  };
  // v62.17: bound captured ONCE. `runs.length * 2` re-read a length that
  // shrinks with every merge, so from R runs only ~2R/3 merges could happen
  // — the loop bailed mid-work on rapid-fire narration, leaving short runs
  // that the capacity check below then paid for by DROPPING photos (which
  // reverts the whole job to the legacy path after ElevenLabs is spent).
  const mergeBudget = runs.length * 2;
  for (let guard = 0; guard < mergeBudget && runs.length > 1; guard++) {
    const shortIdx = runs.findIndex((_, ri) => runSpan(ri) < minScene * Math.max(1, runs[ri].photos.length));
    if (shortIdx === -1) break;
    const into = shortIdx < runs.length - 1 ? shortIdx + 1 : shortIdx - 1;
    const [a, b] = shortIdx < into ? [shortIdx, into] : [into, shortIdx];
    runs[a].photos = [...runs[a].photos, ...runs[b].photos].sort((x, y) => x - y);
    runs[a].sentenceIndices.push(...runs[b].sentenceIndices);
    runs[a].words.push(...runs[b].words);
    runs.splice(b, 1);
  }

  // 2) Time each run and cut it into per-photo scenes.
  const droppedPhotos = [];
  const scenes = [];
  for (let ri = 0; ri < runs.length; ri++) {
    const run = runs[ri];
    const next = runs[ri + 1];
    const t0 = ri === 0 ? 0 : Math.max(t(run.words[0].start) - cutPreroll, scenes[scenes.length - 1].end);
    const t1 = next
      ? Math.max(t(next.words[0].start) - cutPreroll, t(run.words[run.words.length - 1].end))
      : t(run.words[run.words.length - 1].end) + tailPad;

    let n = run.photos.length;
    const fit = Math.max(1, Math.floor((t1 - t0) / minScene));
    if (n > fit) {
      const dropped = run.photos.slice(fit);
      droppedPhotos.push(...dropped);
      warnings.push(`run@sentence ${run.sentenceIndices[0]}: ${(t1 - t0).toFixed(1)}s holds ${fit}/${n} photos — dropped [${dropped.join(",")}]`);
      run.photos = run.photos.slice(0, fit);
      n = fit;
    }

    const cuts = chooseCutTimes(run.words, t0, t1, n, minScene);
    const edges = [t0, ...cuts, t1];
    for (let k = 0; k < n; k++) {
      scenes.push({
        photoOrdinal: run.photos[k],
        sentenceIndex: run.sentenceIndices[0],
        start: edges[k],
        end: edges[k + 1]
      });
    }
  }

  // 3) Over-length SPILL: cap any scene at maxSceneVisible by pulling the
  //    next cut earlier — the narration finishes over the following room.
  //    Audio is untouched; total end is unchanged; contiguity preserved.
  for (let i = 0; i < scenes.length - 1; i++) {
    if (scenes[i].end - scenes[i].start > maxSceneVisible) {
      warnings.push(`scene ${i + 1}: ${(scenes[i].end - scenes[i].start).toFixed(1)}s > ${maxSceneVisible}s — cut early, narration spills into next scene`);
      scenes[i].end = scenes[i].start + maxSceneVisible;
      scenes[i + 1].start = scenes[i].end;
    }
  }
  // Final scene has no next to spill FORWARD into — spill BACKWARD instead:
  // its start moves later and the previous scene grows (the previous room
  // stays on screen while the closing sentence begins — the mirror of the
  // forward spill; audio and total length untouched). Cascades toward scene
  // 0 if the growth pushes an earlier scene over the cap.
  for (let k = scenes.length - 1; k > 0; k--) {
    const dur = scenes[k].end - scenes[k].start;
    if (dur <= maxSceneVisible) break;
    warnings.push(`scene ${k + 1}: ${dur.toFixed(1)}s > ${maxSceneVisible}s — starts late, previous scene holds while narration runs`);
    scenes[k].start = scenes[k].end - maxSceneVisible;
    scenes[k - 1].end = scenes[k].start;
  }
  if (scenes[0].end - scenes[0].start > maxSceneVisible) {
    // Only reachable when the WHOLE video exceeds sceneCount×cap — a
    // single-photo monster narration. Nothing left to spill into; the clip
    // ask will cap and the stitch runs short. Say so loudly.
    warnings.push(`ALERT scene 1: ${(scenes[0].end - scenes[0].start).toFixed(1)}s exceeds the ${maxSceneVisible}s clip ceiling with nowhere to spill — expect a short tail`);
  }

  for (const sc of scenes) {
    sc.duration = +(sc.end - sc.start).toFixed(3);
    sc.start = +sc.start.toFixed(3);
    sc.end = +sc.end.toFixed(3);
  }

  // Sentence spans in VIDEO time (duck windows + caption paging).
  const sentenceSpansSec = perSentence.map((ws) => ws.length
    ? { start: +t(ws[0].start).toFixed(3), end: +t(ws[ws.length - 1].end).toFixed(3) }
    : null);

  const speechStart = t(words[0].start);
  const speechEnd = t(words[words.length - 1].end);
  const gaps = [];
  for (let i = 0; i < words.length - 1; i++) gaps.push(words[i + 1].start - words[i].end);
  const stats = {
    wordCount: words.length,
    sentenceCount: narration.sentences.length,
    sceneCount: scenes.length,
    speechSec: +(speechEnd - speechStart).toFixed(2),
    wps: +(words.length / Math.max(0.1, speechEnd - speechStart)).toFixed(2),
    maxWordGapSec: +Math.max(...gaps, 0).toFixed(2),
    sceneDurations: scenes.map((s) => s.duration),
    minSceneSec: +Math.min(...scenes.map((s) => s.duration)).toFixed(2),
    maxSceneSec: +Math.max(...scenes.map((s) => s.duration)).toFixed(2),
    droppedPhotos,
    warnings
  };

  return {
    scenes,
    narrationOffsetSec: +offset.toFixed(3), // may be <0 → head-trim in the mixer
    videoEndSec: scenes[scenes.length - 1].end,
    sentenceSpansSec,
    stats
  };
}

/* ============================================================
   Synthesis rungs
   ============================================================ */

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Rung 1a — expressive read: eleven_v3 with audio tags, plain TTS endpoint
// (v3 does not support with-timestamps; timing comes from forced alignment).
async function synthesizeV3({ monologue, voiceId, tempDir, jobId }) {
  const response = await fetchWithTimeout(
    `${ELEVENLABS_BASE}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: monologue,
        model_id: V3_MODEL,
        // v3 profile: 0.5 = the balanced "Natural" point; expressiveness
        // comes from the tags + text, not a style knob.
        voice_settings: { stability: 0.5, similarity_boost: 0.8 }
      })
    },
    SYNTH_TIMEOUT_MS
  );
  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`eleven_v3 TTS failed (${response.status}): ${err.slice(0, 200)}`);
  }
  const audioPath = path.join(tempDir, `${jobId}-vf-v3.mp3`);
  await fs.writeFile(audioPath, Buffer.from(await response.arrayBuffer()));
  return audioPath;
}

// Rung 1b — forced alignment: audio + CLEAN transcript → word timestamps.
async function forceAlign({ audioPath, cleanText, expectedWords }) {
  const buf = await fs.readFile(audioPath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/mpeg" }), "narration.mp3");
  form.append("text", cleanText);
  const response = await fetchWithTimeout(
    `${ELEVENLABS_BASE}/forced-alignment`,
    { method: "POST", headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY }, body: form },
    ALIGN_TIMEOUT_MS
  );
  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`forced-alignment failed (${response.status}): ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  const words = (data?.words || [])
    .map((w) => ({ word: String(w.text ?? w.word ?? "").trim(), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => w.word && Number.isFinite(w.start) && Number.isFinite(w.end));
  if (!words.length) throw new Error("forced-alignment returned no words");
  // v62.17: rung 1 had NO divergence guard while rung 2 did — an asymmetry
  // that mattered because rung 1 is the DEFAULT. A short alignment doesn't
  // fail loudly; wordsToSentences just runs out of words early, every
  // sentence boundary slides, cuts drift off the voice, and the final
  // sentence can map to zero words — which silently deletes the CTA's duck
  // window (sentenceSpansSec entry goes null). Same tolerance as rung 2.
  if (expectedWords > 0 && (words.length < expectedWords * 0.8 || words.length > expectedWords * 1.6)) {
    throw new Error(`forced-alignment word count ${words.length} diverges from transcript ${expectedWords} — refusing to cut a grid from it`);
  }
  return words;
}

/**
 * v62.36: excise time ranges from the narration mp3. Every cut starts and
 * ends on a word BOUNDARY that the aligner reported, so both edges land in
 * the silence a voice leaves at a full stop — the join is one word ending
 * followed by the pause that already preceded the next sentence. atrim +
 * concat rather than seek arithmetic: sample-exact, and one re-encode.
 */
async function cutAudioSpans({ audioPath, spans, tempDir, jobId }) {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const keep = [];
  let cursor = 0;
  for (const s of sorted) {
    if (s.start > cursor + 0.01) keep.push([cursor, s.start]);
    cursor = Math.max(cursor, s.end);
  }
  keep.push([cursor, null]); // to end of file
  if (keep.length < 2) throw new Error("cutAudioSpans: nothing would be removed");

  const parts = keep.map(([a, b], i) =>
    `[0:a]atrim=start=${a.toFixed(4)}${b === null ? "" : `:end=${b.toFixed(4)}`},asetpts=N/SR/TB[k${i}]`
  );
  const filter = `${parts.join(";")};${keep.map((_, i) => `[k${i}]`).join("")}concat=n=${keep.length}:v=0:a=1[out]`;
  const outPath = path.join(tempDir, `${jobId}-vf-trimmed.mp3`);
  await runFFmpeg([
    "-y", "-v", "error", "-i", audioPath,
    "-filter_complex", filter, "-map", "[out]",
    "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100", outPath
  ], { timeoutMs: 60000, label: "voice-first duration trim" });

  // v62.36a: PROVE the cut. atrim past end-of-file yields an empty segment
  // and concat accepts it without complaint, so a span that overruns the
  // audio removes less than asked while shiftWordsAfterCuts still moves
  // every later word by the full amount — a silent multi-second desync,
  // the exact class this file exists to prevent. Measure the output and
  // refuse it if it disagrees. mp3 frame granularity is ~26ms; 150ms is
  // loose enough never to false-alarm and tight enough that no real
  // mistake fits through.
  const removed = sorted.reduce((a, s) => a + (s.end - s.start), 0);
  const srcSec = await probeDurationSec(audioPath);
  const outSec = await probeDurationSec(outPath);
  if (Number.isFinite(srcSec) && Number.isFinite(outSec)) {
    const expected = srcSec - removed;
    if (Math.abs(outSec - expected) > 0.15) {
      await fs.unlink(outPath).catch(() => {});
      throw new Error(
        `cut audio is ${outSec.toFixed(2)}s, expected ${expected.toFixed(2)}s ` +
        `(${srcSec.toFixed(2)}s source minus ${removed.toFixed(2)}s) — refusing to desync the stem`
      );
    }
  }
  return outPath;
}

// Exported for the duration-contract verification harness only: the silent
// out-of-range desync this guards is unreachable through prepareVoiceFirst
// (the CTA is never dropped, so spans stay inside the file), which is
// exactly why it needs a direct test.
export const __testCutAudioSpans = cutAudioSpans;

function probeDurationSec(file) {
  return new Promise((resolve) => {
    execFile("ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { timeout: 15000 },
      (err, stdout) => resolve(err ? NaN : Number(String(stdout).trim()))
    );
  });
}

// Rung 2 — proven path: with-timestamps on the production model, clean text.
// Character alignment grouped into whitespace-delimited words.
async function synthesizeWithTimestampsClean({ cleanText, voiceId, tempDir, jobId }) {
  const response = await fetchWithTimeout(
    `${ELEVENLABS_BASE}/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`,
    {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: cleanText,
        model_id: TIMESTAMP_MODEL,
        // Long-form single-pass profile (same as the aligned path's v33 read).
        voice_settings: { stability: 0.55, similarity_boost: 0.85, style: 0.15, use_speaker_boost: true }
      })
    },
    SYNTH_TIMEOUT_MS
  );
  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`with-timestamps failed (${response.status}): ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  if (!data?.audio_base64) throw new Error("with-timestamps returned no audio");
  const audioPath = path.join(tempDir, `${jobId}-vf-ts.mp3`);
  await fs.writeFile(audioPath, Buffer.from(data.audio_base64, "base64"));
  const alignment = data.alignment || data.normalized_alignment;
  if (!alignment?.characters?.length) throw new Error("with-timestamps returned no alignment");
  const { characters, character_start_times_seconds: cs, character_end_times_seconds: ce } = alignment;
  const words = [];
  let cur = null;
  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    if (/\s/.test(ch)) {
      if (cur) { words.push(cur); cur = null; }
    } else if (cur) {
      cur.word += ch;
      cur.end = Number(ce[i] ?? cur.end);
    } else {
      cur = { word: ch, start: Number(cs[i] ?? 0), end: Number(ce[i] ?? 0) };
    }
  }
  if (cur) words.push(cur);
  if (!words.length) throw new Error("alignment grouped to zero words");
  // normalized_alignment fallback hazard: its characters are the NORMALIZED
  // text ("24024" → "twenty four thousand…"), whose token count can diverge
  // wildly from the clean transcript and skew every later sentence. Numeral
  // expansion makes counts GROW; tolerate modest growth, reject blowups.
  const expected = cleanText.split(/\s+/).filter(Boolean).length;
  if (words.length < expected * 0.8 || words.length > expected * 1.6) {
    throw new Error(`alignment word count ${words.length} diverges from transcript ${expected} — refusing to cut a grid from it`);
  }
  return { audioPath, words };
}

/* ============================================================
   prepareVoiceFirst — the front-of-job stage.
   ============================================================
   Input: manifest.narration = { monologue, sentences:[{text, photos:[photoId]}],
   direction? } with photos as PHOTO IDs (plan currency). photoScenes is the
   worker's filtered scene list — ids are mapped to ordinals here so the grid
   math stays index-based. Fail-open: any error returns null (caller logs and
   the legacy voice path runs at the old pipeline position).
   Returns { grid, audioPath, words, cleanText, rung } on success. */
export async function prepareVoiceFirst({ manifest, photoScenes, tempDir, jobId, resolveVoice, maxSceneVisible }) {
  const narration = manifest?.narration;
  if (!narration?.monologue || !Array.isArray(narration.sentences) || !narration.sentences.length) {
    return null;
  }
  // v62.42: say WHOSE narration this is FIRST, before any exit can hide it.
  // Three renders running, the "why isn't this the Director's monologue"
  // question escaped through three different doors: two pre-v62.39 plans
  // carried no reason, then the Jul 27 square render bailed at the
  // preflight below — which printed the word count and swallowed the
  // provenance. Every bail from here down now happens under this line.
  if (narration.source && narration.source !== "director") {
    console.warn(
      `[voice-first] narration source is "${narration.source}"` +
      (narration.sourceReason ? ` — plan-side reason: ${narration.sourceReason}` : " (no reason on manifest — pre-v62.39 plan)")
    );
  }
  if (!process.env.ELEVENLABS_API_KEY) {
    console.warn("[voice-first] ELEVENLABS_API_KEY not set — legacy voice path will run.");
    return null;
  }

  // Map sentence photo IDs → photo-scene ordinals. Unknown/dropped ids are
  // skipped (a photo the plan mapped but the worker filtered must not sink
  // the whole render); a sentence left with no known photos becomes a linger.
  const ordinalByPhotoId = new Map(photoScenes.map((s, i) => [String(s.photoId), i]));
  const mapped = narration.sentences.map((s, i) => ({
    index: i,
    text: String(s.text || "").trim(),
    asked: Array.isArray(s.photos) ? s.photos.length : 0,
    photos: (Array.isArray(s.photos) ? s.photos : [])
      .map((id) => ordinalByPhotoId.get(String(id)))
      .filter((x) => Number.isInteger(x))
  }));
  // v62.35: a sentence that ARRIVED with photos and left with none had every
  // one of its photoIds filtered above — the plan mapped a scene the worker
  // no longer has. buildVoiceGrid then merges its words into the PREVIOUS
  // run (that is the linger contract) and only warns when it is sentence 1,
  // so mid-list this used to happen in total silence: the sentence plays
  // over the room before it, and the scene count still matches so nothing
  // reverts. Say it out loud — it is the signature of an upstream membership
  // change and the only warning we would get.
  for (const m of mapped) {
    if (m.text && m.asked > 0 && m.photos.length === 0) {
      console.warn(
        `[voice-first] sentence ${m.index + 1} mapped ${m.asked} photoId(s) the worker does not have ` +
        `— it will play over the PREVIOUS room: "${m.text.slice(0, 60)}"`
      );
    }
  }
  const sentences = mapped
    .filter((s) => s.text)
    .map((s) => ({ text: s.text, photos: s.photos }));
  if (!sentences.length) {
    console.warn("[voice-first] narration.sentences empty after photo mapping — legacy path will run.");
    return null;
  }
  if (!sentences[0].photos.length) {
    // A photo-less opener would pin to ordinal 0 while a later sentence may
    // own it too → duplicate grid scene → count-mismatch revert AFTER the
    // TTS spend. Catch it before spending (plan-side validation rejects
    // this too; this is the worker's own belt).
    console.warn("[voice-first] sentence 1 maps to no known photos — legacy path will run.");
    return null;
  }
  // Every scene ordinal must appear exactly once across sentences (ascending).
  const seen = new Set();
  let lastSeen = -1;
  let orderOk = true;
  for (const s of sentences) {
    for (const p of s.photos) {
      if (seen.has(p) || p < lastSeen) { orderOk = false; }
      seen.add(p);
      lastSeen = Math.max(lastSeen, p);
    }
  }
  if (!orderOk) {
    console.warn("[voice-first] sentence→photo mapping out of order or repeated — legacy path will run.");
    return null;
  }
  // Unmapped scenes attach to the nearest preceding sentence (linger-style)
  // by inserting their ordinal into that sentence's span — the grid's run
  // grouping treats consecutive photos in one sentence as a split span.
  for (let ord = 0; ord < photoScenes.length; ord++) {
    if (seen.has(ord)) continue;
    let target = sentences[0];
    for (const s of sentences) {
      if (s.photos.length && Math.min(...s.photos) <= ord) target = s;
    }
    target.photos.push(ord);
    target.photos.sort((a, b) => a - b);
  }

  // v62.17 PRE-FLIGHT CAPACITY CHECK — before spending a cent on TTS.
  // A script too short to carry the photo count produces a grid that drops
  // photos, and runway-job then (correctly) reverts to the legacy voice
  // path — but only AFTER the ElevenLabs call is paid for and its seconds
  // are gone from the render's wall clock. This is the common shape for
  // blackout/fallback plans, whose stock per-scene lines join into 11-25
  // words for a dozen photos. Measured pace across real renders is
  // 2.34-2.80 words/sec; 2.5 is the honest middle. If the speech cannot
  // cover minScene per photo, say so now and let legacy handle it.
  const preflightWords = sentences.map((s) => s.text).join(" ").split(/\s+/).filter(Boolean).length;
  const preflightSpeechSec = preflightWords / 2.5;
  const needSec = photoScenes.length * MIN_SCENE_SEC;
  if (preflightSpeechSec < needSec) {
    console.warn(
      `[voice-first] narration too thin to carry this photoset — ${preflightWords} words ≈ ${preflightSpeechSec.toFixed(1)}s ` +
      `of speech for ${photoScenes.length} photos needing ${needSec.toFixed(1)}s ` +
      `(source=${narration.source || "director"}). Reverting to the legacy voice path BEFORE spending on TTS.`
    );
    return null;
  }

  const cleanFromSentences = sentences.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
  const cleanFromMonologue = stripAudioTags(narration.monologue);
  // Alignment depends on transcript integrity; prefer the sentence join (it
  // is what we map words against) and warn if the monologue diverged.
  if (cleanFromSentences !== cleanFromMonologue) {
    console.warn("[voice-first] monologue/sentences text mismatch — using sentence join as transcript (plan validator should have caught this).");
  }
  const cleanText = cleanFromSentences;

  const voiceId = resolveVoice ? resolveVoice(manifest?.brandKit?.voiceId, manifest?.brandKit?.style) : manifest?.brandKit?.voiceId;

  let audioPath = null;
  let words = null;
  let rung = null;
  const v3Enabled = String(process.env.VOICE_FIRST_V3 || "1") !== "0";
  if (v3Enabled) {
    try {
      audioPath = await synthesizeV3({ monologue: narration.monologue, voiceId, tempDir, jobId });
      words = await forceAlign({ audioPath, cleanText, expectedWords: cleanText.split(/\s+/).filter(Boolean).length });
      rung = "v3+forced-align";
    } catch (err) {
      console.warn(`[voice-first] expressive rung failed (${err.message}) — falling back to ${TIMESTAMP_MODEL} with-timestamps.`);
      // v62.17: unlink the orphaned v3 mp3. It was already synthesized (and
      // already billed) when alignment rejected it; leaving it behind meant
      // two full-length mp3s per fallback render until the 2h temp sweep.
      if (audioPath) await fs.unlink(audioPath).catch(() => {});
      audioPath = null;
      words = null;
    }
  }
  if (!words) {
    const r = await synthesizeWithTimestampsClean({ cleanText, voiceId, tempDir, jobId });
    audioPath = r.audioPath;
    words = r.words;
    rung = `${TIMESTAMP_MODEL}+timestamps`;
  }

  let grid = buildVoiceGrid({ sentences }, words, maxSceneVisible ? { maxSceneVisible } : {});

  /* ── v62.36 DURATION CONTRACT ────────────────────────────────────────
     Everything above is spent; nothing below is. This is the last moment
     the render is still cheap, and the first moment the final length is
     a measured fact rather than a word-count guess. */
  let keepOrdinals = null;
  let orphanedOrdinals = [];
  const targetSec = Number(manifest?.targetDurationSec) || 0;

  /* v62.36 CALIBRATION. The plan side still budgets in words because it has
     to guess before the voice exists, and its divisor (2.5 w/s) is a single
     constant standing in for two independent terms. Every render now reports
     the real ones, so that divisor can eventually be replaced with
     seconds ≈ words·SEC_PER_WORD + (sentences−1)·SEC_PER_STOP + 1.8
     from measured data rather than from a fitted guess. Costs one log line. */
  try {
    const per = wordsToSentences(sentences, words);
    const artic = words.reduce((a, w) => a + (w.end - w.start), 0) / words.length;
    const stopEnds = new Set(per.slice(0, -1).map((r) => r[r.length - 1]?.end).filter((x) => x != null));
    let intraSum = 0, intraN = 0, interSum = 0, interN = 0;
    for (let i = 0; i < words.length - 1; i++) {
      const gap = words[i + 1].start - words[i].end;
      if (stopEnds.has(words[i].end)) { interSum += gap; interN++; } else { intraSum += gap; intraN++; }
    }
    console.info(
      `[voice-first] CALIBRATION: ${words.length}w/${sentences.length}s — ` +
      `articulation ${artic.toFixed(3)}s/word, intra-gap ${(intraN ? intraSum / intraN : 0).toFixed(3)}s x${intraN}, ` +
      `full-stop pause ${(interN ? interSum / interN : 0).toFixed(3)}s x${interN} — ` +
      `implied ${(artic + (intraN ? intraSum / intraN : 0)).toFixed(3)}s/word + ` +
      `${(interN ? (interSum / interN) : 0).toFixed(3)}s/stop (plan divisor assumes a flat 2.5 w/s = 0.400s/word)`
    );
  } catch { /* telemetry only — never let it touch the render */ }

  if (targetSec > 0) {
    const ceiling = targetSec + Math.max(2, targetSec * 0.08);
    console.info(
      `[voice-first] DURATION: ordered ${targetSec}s, voice measures ${grid.videoEndSec.toFixed(1)}s ` +
      `(${sentences.length} sentences, ceiling ${ceiling.toFixed(1)}s) — ` +
      (grid.videoEndSec > ceiling ? "OVER, trimming." : "inside the order.")
    );
    try {
      const perSentence = wordsToSentences(sentences, words);
      const plan = planDurationTrim(perSentence, grid.videoEndSec, targetSec, {
        photosPerSentence: sentences.map((s) => s.photos.length)
      });
      if (plan) {
        const dropped = new Set(plan.drop);
        orphanedOrdinals = plan.drop.flatMap((k) => sentences[k].photos);
        const survivors = sentences.filter((_, i) => !dropped.has(i));
        // Renumber the surviving ordinals to a dense 0..n-1 over the scenes
        // that remain, so the grid's positional contract with photoScenes
        // still holds after runway-job removes the orphans.
        // A dropped LINGER sentence orphans no photos, so the scene list is
        // unchanged — say so with null rather than handing the caller a
        // full-length keep list that makes it log "removed 0 scene(s)".
        keepOrdinals = orphanedOrdinals.length
          ? survivors.flatMap((s) => s.photos).sort((a, b) => a - b)
          : null;
        const renumberFrom = keepOrdinals || survivors.flatMap((s) => s.photos).sort((a, b) => a - b);
        const renumber = new Map(renumberFrom.map((ord, i) => [ord, i]));
        const newSentences = survivors.map((s) => ({
          text: s.text,
          photos: s.photos.map((o) => renumber.get(o)).filter((x) => Number.isInteger(x))
        }));
        const newAudio = await cutAudioSpans({ audioPath, spans: plan.spans, tempDir, jobId });
        let newWords, rebuilt;
        try {
          newWords = shiftWordsAfterCuts(words, plan.spans);
          rebuilt = buildVoiceGrid({ sentences: newSentences }, newWords, maxSceneVisible ? { maxSceneVisible } : {});
          if (rebuilt.stats.droppedPhotos.length) {
            throw new Error(`rebuilt grid would drop photos [${rebuilt.stats.droppedPhotos.join(",")}]`);
          }
        } catch (rebuildErr) {
          // v62.17's lesson, which this new path had not inherited: the cut
          // mp3 was already written and billed CPU. If we are not going to
          // use it, take it with us — otherwise every rejected trim leaves a
          // full-length orphan behind until the 2h temp sweep.
          await fs.unlink(newAudio).catch(() => {});
          throw rebuildErr;
        }
        // Only commit once the rebuild is proven good — a half-applied trim
        // (new audio, old grid) is the desync this whole file exists to
        // prevent. Until this line nothing observable has changed.
        await fs.unlink(audioPath).catch(() => {});
        audioPath = newAudio;
        words = newWords;
        sentences.length = 0;
        sentences.push(...newSentences);
        grid = rebuilt;
        console.warn(
          `[voice-first] DURATION TRIM: dropped ${plan.drop.length} sentence(s) ` +
          `[${plan.drop.map((k) => `s${k + 1}`).join(",")}] and ${orphanedOrdinals.length} scene(s) — ` +
          `${(plan.projectedSec + 0).toFixed(1)}s predicted, ${grid.videoEndSec.toFixed(1)}s actual, ` +
          `against a ${targetSec}s order. Hook and CTA kept.`
        );
      }
    } catch (trimErr) {
      // Fail-open like everything else here: an untrimmed video that runs
      // long is worse than the order, but far better than no video.
      console.warn(`[voice-first] duration trim failed (${trimErr.message}) — shipping the full-length voice.`);
      keepOrdinals = null;
      orphanedOrdinals = [];
    }
    // v62.36a: report the UNDER case AFTER any trim, not before — the old
    // placement measured the pre-trim length, so a trim that undershot the
    // order announced nothing at all. Nothing to do about it here either
    // way (the script floor lives plan-side: v62.7 THIN-UPGRADE, the
    // expansion probe), but the log must say which end of the contract
    // missed and by how much.
    if (grid.videoEndSec < targetSec * 0.8) {
      console.warn(
        `[voice-first] DURATION UNDER: ${grid.videoEndSec.toFixed(1)}s against a ${targetSec}s order` +
        `${keepOrdinals ? " (after the trim)" : ""} — the script is too thin to fill the order and ` +
        `nothing here can add to it without re-synthesizing.`
      );
    }
  }

  // Caption words in VIDEO time, pre-shaped for buildCaptionsAss. Nothing is
  // ever trimmed on this path, so every spoken word is captioned — the m66
  // "highlighted word over silence" class cannot occur here.
  const perSentence = wordsToSentences(sentences, words);
  const captionWords = [];
  for (const run of perSentence) {
    let firstOfLine = true;
    for (const w of run) {
      captionWords.push({
        text: String(w.word).replace(/[.,!?]+$/, ""),
        start: +(w.start + grid.narrationOffsetSec).toFixed(3),
        end: +(w.end + grid.narrationOffsetSec).toFixed(3),
        lineStart: firstOfLine
      });
      firstOfLine = false;
    }
  }

  const st = grid.stats;
  console.info(
    `[voice-first] rung=${rung} voice=${voiceId} source=${narration.source || "director"} — ${st.wordCount} words / ${st.sentenceCount} sentences → ` +
    `${st.sceneCount} scenes, speech ${st.speechSec}s @ ${st.wps} w/s, ` +
    `scene range ${st.minSceneSec}-${st.maxSceneSec}s, video ${grid.videoEndSec}s` +
    (st.droppedPhotos.length ? ` — DROPPED photos [${st.droppedPhotos.join(",")}]` : "")
  );
  // v62.7: the m81-twice incident's "brochure register" render was almost
  // certainly a derived-from-lines monologue — make that unmissable in the
  // render log, not just the plan log (which nobody reads after the fact).
  if (narration.source && narration.source !== "director") {
    console.warn(
      `[voice-first] NOTE: narration source is "${narration.source}" — the Director's monologue failed plan-side validation and the per-scene lines were joined instead. Expect a stiffer read.` +
      (narration.sourceReason
        ? ` Plan-side reason: ${narration.sourceReason}`
        : ` (Reason not carried on this manifest — pre-v62.39 plan; check the [plan] narration logs.)`)
    );
  }
  for (const w of st.warnings) console.warn(`[voice-first] ${w}`);
  // Canary-gate transcript: every sentence with its video-time span.
  grid.sentenceSpansSec.forEach((span, i) => {
    if (span) console.info(`[voice-first] s${i + 1} ${span.start.toFixed(2)}-${span.end.toFixed(2)}s: "${sentences[i].text}"`);
  });

  // keepOrdinals is non-null only when the duration trim fired: it lists the
  // ORIGINAL photo-scene ordinals that survived, in order, and the caller
  // must reduce photoScenes to exactly those before generating anything —
  // the grid's positional contract is with the REDUCED list.
  return { grid, audioPath, words, captionWords, cleanText, sentences, rung, voiceId, keepOrdinals, orphanedOrdinals };
}
