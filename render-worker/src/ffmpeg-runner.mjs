// EstateMotion — Shared ffmpeg runner with timeouts and structured logging.
//
// The single biggest source of "frozen at 80%" reports has been ffmpeg
// invocations that hang indefinitely — complex filter graphs, network
// inputs, codec edge cases. Without a kill timeout, the entire render
// pipeline waits forever.
//
// Every ffmpeg call in the worker MUST go through this module. The default
// 5-minute timeout catches genuine hangs while leaving headroom for legit
// long operations (re-encoding a 2-minute video at ultrafast). Callers
// should pass a tighter timeout where appropriate so failures surface fast.

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// runFFmpeg(args, { timeoutMs, label })
//   args     — array of ffmpeg CLI arguments (without the "ffmpeg" itself)
//   timeoutMs — kill the process if it exceeds this. Defaults to 5 min.
//   label     — short string for logs ("runway:stitch", "voice:mix", etc.)
//
// Resolves on exit code 0. Rejects with a descriptive Error otherwise,
// including the case where we SIGKILL the process for taking too long.
export function runFFmpeg(args, { timeoutMs = DEFAULT_TIMEOUT_MS, label = "ffmpeg" } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let timedOut = false;

    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      // Truncate to last 4KB so a verbose ffmpeg session doesn't pile RAM.
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      console.warn(`[ffmpeg:${label}] timed out after ${timeoutMs}ms — killing process. last stderr: ${stderr.slice(-300).replace(/\n/g, " | ")}`);
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const elapsedMs = Date.now() - start;
      if (timedOut) {
        return reject(new Error(`ffmpeg ${label} hung — killed after ${timeoutMs}ms timeout`));
      }
      if (code === 0) {
        // Log slow operations so we can spot trends in production.
        if (elapsedMs > 30000) {
          console.info(`[ffmpeg:${label}] completed slowly in ${elapsedMs}ms`);
        }
        return resolve();
      }
      reject(new Error(`ffmpeg ${label} exit ${code} after ${elapsedMs}ms: ${stderr.slice(-500).replace(/\n/g, " | ")}`));
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg ${label} spawn failed: ${err.message}`));
    });
  });
}

// Wrapper that emits start/end timing logs around any async operation.
// Use it on every major pipeline step so we can pinpoint hangs from logs.
//
//   await timed("runway:stitch", () => stitchWithCrossfades({...}));
export async function timed(label, fn) {
  const start = Date.now();
  console.info(`[${label}] starting`);
  try {
    const result = await fn();
    console.info(`[${label}] done in ${Date.now() - start}ms`);
    return result;
  } catch (err) {
    console.error(`[${label}] failed after ${Date.now() - start}ms: ${err.message}`);
    throw err;
  }
}
