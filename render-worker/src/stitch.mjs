// Vistalia — shared stitcher.
//
// Extracted from runway-job.mjs so both the Runway engine and the new
// Depth engine (depth-job.mjs) use exactly the same crossfade/concat
// logic. Behavior identical to the v22 runway stitcher — same memory
// management, same XFADE_BATCH_SIZE, same encoding params.
//
// PUBLIC ENTRYPOINTS
//   stitchWithCrossfades({ clips, outroClip, output, crossfadeDurationSec })
//   stitchWithSimpleConcat({ clips, outroClip, output, tempDir })
//
// `clips` is an array of { clipPath, duration, sceneIndex } objects;
// each clipPath is a local mp4 ready for concatenation.

import fs from "node:fs/promises";
import path from "node:path";
import { runFFmpeg } from "./ffmpeg-runner.mjs";

// Encoding params — kept identical to the v22 runway-job constants so
// switching engines produces byte-comparable output and no regression on
// master quality.
const ENCODE_PRESET = "superfast";
const ENCODE_CRF_MASTER = "19";
const X264_PARAMS = "rc-lookahead=10:ref=2:bframes=2:keyint=60:scenecut=0";
const BUFSIZE = "2M";

// Batch threshold — at or below (this + 2) clips, do a single xfade pass.
// Above it, chunk into XFADE_BATCH_SIZE groups, xfade each, simple-concat
// the batch outputs. Keeps codec-context memory bounded on Render Pro 4GB.
const XFADE_BATCH_SIZE = 4;

/* ============================================================
   stitchWithCrossfades
   ============================================================
   Smooth-crossfade stitcher. Default for both engines.

   v22 — BATCHED to keep memory bounded. xfade with all clips in one
   filter_complex opens N codec contexts simultaneously, peaking
   ~150-200 MB per input. At 24+ inputs that's 4 GB+ of decoder state
   alone, which OOM-killed the 4 GB Render instance.
*/
export async function stitchWithCrossfades({ clips, outroClip, output, crossfadeDurationSec = 0.5 }) {
  const allClips = outroClip
    ? [...clips, { clipPath: outroClip, duration: 5, sceneIndex: 9999 }]
    : [...clips];
  if (allClips.length === 0) throw new Error("stitchWithCrossfades called with no clips.");
  if (allClips.length === 1) {
    await runFFmpeg(
      ["-y", "-threads", "1", "-i", allClips[0].clipPath, "-c", "copy", output],
      { timeoutMs: 30000, label: "stitch:single-clip-copy" }
    );
    return;
  }

  if (allClips.length <= XFADE_BATCH_SIZE + 2) {
    await xfadeSingleBatch(allClips, output, crossfadeDurationSec);
    return;
  }

  const tempDir = path.dirname(output);
  const batches = [];
  for (let i = 0; i < allClips.length; i += XFADE_BATCH_SIZE) {
    batches.push(allClips.slice(i, i + XFADE_BATCH_SIZE));
  }
  console.info(
    `[stitch:xfade] batched ${allClips.length} clips into ${batches.length} groups of ≤${XFADE_BATCH_SIZE} ` +
    `(memory-safe: ~600-800 MB per batch instead of ~${Math.round(allClips.length * 175)} MB single-pass)`
  );

  const batchOutputs = [];
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const batchOut = path.join(tempDir, `xfade-batch-${String(bi).padStart(2, "0")}.mp4`);
    if (batch.length === 1) {
      await runFFmpeg(
        ["-y", "-threads", "1", "-i", batch[0].clipPath, "-c", "copy", batchOut],
        { timeoutMs: 30000, label: `stitch:xfade-batch-${bi}-passthrough` }
      );
    } else {
      await xfadeSingleBatch(batch, batchOut, crossfadeDurationSec);
    }
    batchOutputs.push(batchOut);
  }

  const concatList = path.join(tempDir, "xfade-batch-concat.txt");
  await fs.writeFile(
    concatList,
    batchOutputs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")
  );
  await runFFmpeg([
    "-y",
    "-threads", "1",
    "-f", "concat",
    "-safe", "0",
    "-i", concatList,
    "-c", "copy",
    output
  ], { timeoutMs: 60000, label: "stitch:xfade-batch-concat" });

  await fs.unlink(concatList).catch(() => {});
  for (const p of batchOutputs) await fs.unlink(p).catch(() => {});
}

// Single-pass xfade for a small group of clips. Used directly for short
// renders and as the inner step of the batched path.
async function xfadeSingleBatch(clipsInBatch, output, crossfadeDurationSec) {
  if (clipsInBatch.length === 1) {
    await runFFmpeg(
      ["-y", "-threads", "1", "-i", clipsInBatch[0].clipPath, "-c", "copy", output],
      { timeoutMs: 30000, label: "stitch:xfade-single" }
    );
    return;
  }
  const f = crossfadeDurationSec;
  const inputs = [];
  clipsInBatch.forEach((clip) => { inputs.push("-i", clip.clipPath); });

  let cumulativeOffset = 0;
  const xfadeSteps = [];
  let lastLabel = "[0:v]";
  for (let i = 1; i < clipsInBatch.length; i++) {
    const prevDuration = Number(clipsInBatch[i - 1].duration || 5);
    cumulativeOffset += prevDuration - f;
    const isLast = i === clipsInBatch.length - 1;
    const outLabel = isLast ? "[vout]" : `[v${String(i).padStart(2, "0")}]`;
    xfadeSteps.push(
      `${lastLabel}[${i}:v]xfade=transition=fade:duration=${f}:offset=${cumulativeOffset.toFixed(3)}${outLabel}`
    );
    lastLabel = outLabel;
  }
  const filterComplex = xfadeSteps.join(";");

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
    output
  ], { timeoutMs: 4 * 60 * 1000, label: `stitch:xfade-batch-${clipsInBatch.length}clips` });
}

/* ============================================================
   stitchWithSimpleConcat
   ============================================================
   Reliability fallback for stitchWithCrossfades. ffmpeg concat demuxer
   with -c copy — no re-encode, no filter_complex, no boundary math.
   Visually less polished (hard cuts) but bulletproof.
*/
export async function stitchWithSimpleConcat({ clips, outroClip, output, tempDir }) {
  const allClips = outroClip
    ? [...clips, { clipPath: outroClip }]
    : clips;
  if (allClips.length === 0) throw new Error("stitchWithSimpleConcat called with no clips.");
  const concatList = path.join(tempDir, "concat-fallback.txt");
  await fs.writeFile(
    concatList,
    allClips.map((c) => `file '${c.clipPath.replace(/'/g, "'\\''")}'`).join("\n")
  );
  await runFFmpeg([
    "-y",
    "-threads", "1",
    "-f", "concat",
    "-safe", "0",
    "-i", concatList,
    "-c", "copy",
    output
  ], { timeoutMs: 60000, label: "stitch:simple-concat" });
  await fs.unlink(concatList).catch(() => {});
}
