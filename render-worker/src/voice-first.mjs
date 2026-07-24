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
  for (let guard = 0; guard < runs.length * 2 && runs.length > 1; guard++) {
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
async function forceAlign({ audioPath, cleanText }) {
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
  return words;
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
  if (!process.env.ELEVENLABS_API_KEY) {
    console.warn("[voice-first] ELEVENLABS_API_KEY not set — legacy voice path will run.");
    return null;
  }

  // Map sentence photo IDs → photo-scene ordinals. Unknown/dropped ids are
  // skipped (a photo the plan mapped but the worker filtered must not sink
  // the whole render); a sentence left with no known photos becomes a linger.
  const ordinalByPhotoId = new Map(photoScenes.map((s, i) => [String(s.photoId), i]));
  const sentences = narration.sentences.map((s) => ({
    text: String(s.text || "").trim(),
    photos: (Array.isArray(s.photos) ? s.photos : [])
      .map((id) => ordinalByPhotoId.get(String(id)))
      .filter((x) => Number.isInteger(x))
  })).filter((s) => s.text);
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
      words = await forceAlign({ audioPath, cleanText });
      rung = "v3+forced-align";
    } catch (err) {
      console.warn(`[voice-first] expressive rung failed (${err.message}) — falling back to ${TIMESTAMP_MODEL} with-timestamps.`);
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

  const grid = buildVoiceGrid({ sentences }, words, maxSceneVisible ? { maxSceneVisible } : {});

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
    `[voice-first] rung=${rung} voice=${voiceId} — ${st.wordCount} words / ${st.sentenceCount} sentences → ` +
    `${st.sceneCount} scenes, speech ${st.speechSec}s @ ${st.wps} w/s, ` +
    `scene range ${st.minSceneSec}-${st.maxSceneSec}s, video ${grid.videoEndSec}s` +
    (st.droppedPhotos.length ? ` — DROPPED photos [${st.droppedPhotos.join(",")}]` : "")
  );
  for (const w of st.warnings) console.warn(`[voice-first] ${w}`);
  // Canary-gate transcript: every sentence with its video-time span.
  grid.sentenceSpansSec.forEach((span, i) => {
    if (span) console.info(`[voice-first] s${i + 1} ${span.start.toFixed(2)}-${span.end.toFixed(2)}s: "${sentences[i].text}"`);
  });

  return { grid, audioPath, words, captionWords, cleanText, sentences, rung, voiceId };
}
