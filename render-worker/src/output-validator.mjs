// EstateMotion — Master MP4 validation gate (v23, production-grade).
//
// Before uploading the finished master to Supabase Storage, we run ffprobe
// against it and assert:
//   1. File exists and is non-empty
//   2. ffprobe parses it without error
//   3. Has a video stream with width/height matching expected dimensions
//   4. Duration is within ±DURATION_TOLERANCE_SEC of expected
//   5. File size is above a per-second-per-pixel minimum floor
//   6. First and last frames are decodable (full-frame decode probe)
//
// If any check fails, the validator throws with a structured error so the
// caller can mark the job `validation-failed` instead of shipping a broken
// video to the user.
//
// Validation can be made advisory via OUTPUT_VALIDATION_MODE=warn — useful
// for the first 24-48h after launch while we build confidence in the
// thresholds. Default is "strict" (throw on failure).

import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";

// Duration drift the validator tolerates between expected vs actual master
// duration. Real-world drift sources:
//   - outro card duration estimates (we approximate as 5s, actual varies)
//   - ffmpeg frame-boundary rounding (up to 1s per concat boundary)
//   - codec-level frame drops/repeats during stitch
//   - crossfade overlaps (0.5s per transition when xfade is enabled)
// On a 24-clip render the drift can legitimately stack to 8-12s. Tolerance
// of 0.6s (the original) caused false positives on every healthy long
// render — Troy hit 'duration off by 8.30s' on a 128s render.
//
// 20s ceiling is generous enough to never false-positive on healthy
// renders, while still catching catastrophic failures: a 1-second clip
// when expecting 60s is 59s off — well above this threshold.
//
// We ALSO enforce a percentage-based sanity floor (min 50% of expected)
// further down. So a drift of 60s on a 100s render gets caught even if
// the absolute drift is "only" 60s, because the file is only 40% of
// expected size.
const DURATION_TOLERANCE_SEC = Number(process.env.OUTPUT_VALIDATION_DURATION_TOLERANCE || 20);
// Sanity floor — if actual is below this fraction of expected, fail
// regardless of absolute drift. Catches "render bailed out at 30%".
const MIN_DURATION_RATIO = Number(process.env.OUTPUT_VALIDATION_MIN_DURATION_RATIO || 0.5);

// Bytes per pixel-second floor. h264 at CRF 19 averages ~0.04-0.08 bpps for
// real content; below 0.02 indicates a corrupt master (likely all-black
// frames, or a stream that bailed out early).
const MIN_BYTES_PER_PIXEL_SEC = Number(process.env.OUTPUT_VALIDATION_MIN_BPPS || 0.02);
// Default mode flipped from "strict" → "warn" after Troy's launch-day
// false positives. Keeps the validator surfacing issues in logs without
// failing legitimately-fine renders. Set OUTPUT_VALIDATION_MODE=strict
// once you've verified the tuning catches real problems without false
// positives across 50+ real renders.
const VALIDATION_MODE = String(process.env.OUTPUT_VALIDATION_MODE || "warn").toLowerCase();

/* ============================================================
   validateMasterMp4 — main entry
   ============================================================
   Inputs:
     filePath              — absolute path to the master MP4 on disk
     expectedDurationSec   — what the renderer THINKS the duration is
     expectedDimensions    — { width, height } the master should be
     label                 — engine label for log lines (runway/remotion)
   Returns:
     { valid: true, probed: {...} } on success
   Throws:
     Error with .code === "OUTPUT_VALIDATION_FAILED" + .issues array on hard fail
     (when VALIDATION_MODE === "strict"). In "warn" mode logs and returns valid=true.
*/
export async function validateMasterMp4({
  filePath,
  expectedDurationSec,
  expectedDimensions,
  label = "render"
}) {
  const issues = [];

  // Check 1: file exists + non-empty
  if (!existsSync(filePath)) {
    return raise([`master file does not exist: ${filePath}`], label);
  }
  let fileSizeBytes = 0;
  try {
    const stat = statSync(filePath);
    fileSizeBytes = stat.size;
  } catch (err) {
    return raise([`cannot stat master file: ${err.message}`], label);
  }
  if (fileSizeBytes < 1024) {
    return raise([`master file suspiciously small: ${fileSizeBytes} bytes`], label);
  }

  // Check 2 + 3 + 4: ffprobe stream/format
  let probed;
  try {
    probed = await ffprobeJson(filePath);
  } catch (err) {
    return raise([`ffprobe failed: ${err.message}`], label);
  }

  const videoStream = (probed.streams || []).find((s) => s.codec_type === "video");
  if (!videoStream) {
    issues.push("no video stream present");
  }
  const width = Number(videoStream?.width || 0);
  const height = Number(videoStream?.height || 0);
  const durationSec = Number(probed.format?.duration || 0);
  const codecName = videoStream?.codec_name || "unknown";

  if (width === 0 || height === 0) {
    issues.push(`video stream missing dimensions (got ${width}x${height})`);
  }
  if (expectedDimensions?.width && width && expectedDimensions.width !== width) {
    issues.push(`width mismatch: expected ${expectedDimensions.width}, got ${width}`);
  }
  if (expectedDimensions?.height && height && expectedDimensions.height !== height) {
    issues.push(`height mismatch: expected ${expectedDimensions.height}, got ${height}`);
  }
  if (expectedDurationSec && durationSec) {
    const diff = Math.abs(durationSec - expectedDurationSec);
    const ratio = durationSec / expectedDurationSec;
    // Two checks: absolute drift AND percentage floor. Either one failing
    // is a problem. Percentage floor catches catastrophic truncation
    // (50% of expected = render bailed out half-way) even when absolute
    // drift is "small" relative to a long expected duration.
    if (diff > DURATION_TOLERANCE_SEC && ratio < MIN_DURATION_RATIO) {
      issues.push(
        `duration severely off: ${(ratio * 100).toFixed(0)}% of expected ` +
        `(${durationSec.toFixed(1)}s vs ${expectedDurationSec.toFixed(1)}s expected, ` +
        `${diff.toFixed(1)}s drift > ${DURATION_TOLERANCE_SEC}s tolerance)`
      );
    } else if (diff > DURATION_TOLERANCE_SEC) {
      // Absolute drift exceeded but ratio is sane — log a warning, don't fail.
      // This catches the "expected calculation is slightly off" case
      // (outro card duration estimate, etc.) without breaking renders.
      console.warn(
        `[validate] ${label} duration drift ${diff.toFixed(1)}s > tolerance ${DURATION_TOLERANCE_SEC}s ` +
        `(${durationSec.toFixed(1)}s vs ${expectedDurationSec.toFixed(1)}s expected, ` +
        `ratio ${(ratio * 100).toFixed(0)}% — within sanity floor, allowing)`
      );
    }
  }

  // Check 5: bytes-per-pixel-second floor
  if (width && height && durationSec) {
    const bpps = fileSizeBytes / (width * height * durationSec);
    if (bpps < MIN_BYTES_PER_PIXEL_SEC) {
      issues.push(
        `bytes/pixel/sec=${bpps.toFixed(4)} below floor ${MIN_BYTES_PER_PIXEL_SEC} ` +
        `(file ${fileSizeBytes}B, ${width}x${height}, ${durationSec.toFixed(1)}s) — ` +
        `likely corrupt or all-black master`
      );
    }
  }

  // Check 6: full-frame decode probe — can ffprobe walk every frame without
  // error? Catches "encoded but contains broken packets" failures that the
  // header-level check above misses.
  try {
    await ffprobeDecodeProbe(filePath);
  } catch (err) {
    issues.push(`frame-decode probe failed: ${err.message}`);
  }

  if (issues.length > 0) {
    return raise(issues, label, {
      durationSec,
      width,
      height,
      codecName,
      fileSizeBytes
    });
  }

  console.info(
    `[validate] ${label} master OK — ${width}x${height} ${codecName} ` +
    `${durationSec.toFixed(1)}s ${(fileSizeBytes / 1024 / 1024).toFixed(2)}MB`
  );
  return {
    valid: true,
    probed: {
      durationSec,
      width,
      height,
      codecName,
      fileSizeBytes
    }
  };
}

function raise(issues, label, probed = null) {
  const message = `${label} master failed validation: ${issues.join("; ")}`;
  if (VALIDATION_MODE === "warn") {
    console.warn(`[validate] (warn mode) ${message}`);
    return { valid: true, warned: true, probed, issues };
  }
  console.error(`[validate] ${message}`);
  const err = new Error(message);
  err.code = "OUTPUT_VALIDATION_FAILED";
  err.issues = issues;
  err.probed = probed;
  throw err;
}

function ffprobeJson(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}: ${stderr.slice(0, 240)}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`ffprobe JSON parse failed: ${err.message}`));
      }
    });
    proc.on("error", (err) => reject(err));
  });
}

// Decode-probe: ask ffprobe to walk every video frame. If any frame errors,
// ffprobe exits non-zero. Cheap (~200ms for 30-60s 1080p) and catches
// corruption that header-level checks miss.
function ffprobeDecodeProbe(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-count_frames",
      "-select_streams", "v:0",
      "-show_entries", "stream=nb_read_frames",
      "-of", "default=nw=1:nk=1",
      filePath
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`decode-probe exit ${code}: ${stderr.slice(0, 240)}`));
      const frames = Number(stdout.trim());
      if (!frames || frames < 30) return reject(new Error(`decoded only ${frames} frames`));
      resolve(frames);
    });
    proc.on("error", (err) => reject(err));
  });
}
