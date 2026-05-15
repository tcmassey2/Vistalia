/* generate-luts.mjs
 *
 * Generates 17³ .cube LUT files for each EstateMotion style pack.
 *
 * Why we generate them instead of shipping pre-made ones:
 *   1. Reproducible — anyone can re-run this script and get identical LUTs.
 *      No "where did luxury_v2.cube come from?" mysteries down the line.
 *   2. Tunable — when we want to push the luxury grade warmer, we change a
 *      number here and re-run. No DaVinci subscription required.
 *   3. Free — purchased LUT packs cost $15-$80; ours are tailored.
 *
 * 17³ = 4913 entries per LUT. ffmpeg's lut3d filter handles 17³, 33³, and 65³.
 * 17³ is the right size for our use case: file is ~110KB, lookup is fast,
 * and the visual quality difference vs 33³ on photo source material is
 * imperceptible. (33³ matters for grading raw video; we're grading 8-bit
 * Runway/Remotion output where the precision floor is 256 levels per channel
 * anyway.)
 *
 * To regenerate after changing the math:
 *   node render-worker/scripts/generate-luts.mjs
 *
 * To audit a LUT visually (preview):
 *   ffmpeg -i any-photo.jpg -vf "lut3d=render-worker/luts/luxury.cube" preview.jpg
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.resolve(__dirname, "..", "luts");
const LUT_SIZE = 17; // 17³ — see header comment for rationale.

/* ----------------------------------------------------------------
   Color math helpers
   ----------------------------------------------------------------
   Everything operates in linear-light [0..1] floats. Final clamp
   is to [0..1] before write-out. Order of operations matters and
   is roughly: WB shift → lift/gamma/gain → saturation → channel
   mixer → contrast curve. This mirrors the order professional
   colorists use in DaVinci.
*/

const clamp = (v, min = 0, max = 1) => Math.min(max, Math.max(min, v));

// Lift / Gamma / Gain — the three primaries of color grading.
// lift moves blacks, gain moves whites, gamma moves the midpoint.
// All three are 3-element [r, g, b] arrays.
function liftGammaGain(rgb, lift, gamma, gain) {
  return rgb.map((c, i) => {
    const g = Math.max(0.001, gamma[i]); // avoid divide-by-zero on gamma
    const lifted = (c * (gain[i] - lift[i])) + lift[i];
    return clamp(Math.pow(Math.max(0, lifted), 1 / g));
  });
}

// HSL-style saturation — pull each channel toward (or away from)
// the per-pixel luminance. sat=1 is identity, sat=0 is greyscale,
// sat>1 amplifies. Uses Rec.709 luma weights.
function adjustSaturation(rgb, sat) {
  const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return rgb.map((c) => clamp(luma + (c - luma) * sat));
}

// Channel mixer — lets us push one channel toward another.
// Used for split-toning (push shadows toward teal, highlights toward orange).
// Weights are a 3×3 matrix; identity is [[1,0,0],[0,1,0],[0,0,1]].
function channelMix(rgb, matrix) {
  return [
    clamp(matrix[0][0] * rgb[0] + matrix[0][1] * rgb[1] + matrix[0][2] * rgb[2]),
    clamp(matrix[1][0] * rgb[0] + matrix[1][1] * rgb[1] + matrix[1][2] * rgb[2]),
    clamp(matrix[2][0] * rgb[0] + matrix[2][1] * rgb[1] + matrix[2][2] * rgb[2])
  ];
}

// Smooth S-curve for contrast — gentler than a straight gamma.
// strength=0 is identity, strength=1 is moderate, strength>1 is strong.
function sCurve(rgb, strength) {
  if (strength === 0) return rgb;
  return rgb.map((c) => {
    // Tanh-based S-curve, normalized so input/output range stays [0..1].
    const k = 4 * strength;
    const centered = c - 0.5;
    const curved = Math.tanh(k * centered) / Math.tanh(k * 0.5);
    return clamp(curved * 0.5 + 0.5);
  });
}

// Split-tone: warm highlights, cool shadows (or vice versa).
// shadow/highlight are 3-element tint colors, balance is 0..1.
function splitTone(rgb, shadowTint, highlightTint, balance) {
  const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  // Smoothstep weighting around the midpoint
  const t = clamp(luma);
  const shadowWeight = (1 - t) * balance;
  const highlightWeight = t * balance;
  return [
    clamp(rgb[0] + shadowTint[0] * shadowWeight + highlightTint[0] * highlightWeight),
    clamp(rgb[1] + shadowTint[1] * shadowWeight + highlightTint[1] * highlightWeight),
    clamp(rgb[2] + shadowTint[2] * shadowWeight + highlightTint[2] * highlightWeight)
  ];
}

/* ----------------------------------------------------------------
   The four style transforms
   ----------------------------------------------------------------
   Each function takes a normalized linear [r,g,b] and returns the
   transformed [r,g,b]. These are the actual "looks" — change the
   numbers here to tune the grades.
*/

// v23.1 — LUT math softened ~40% across all styles after Troy reported
// exteriors (bright sky + green grass) looked "strange" with v23.0
// luxury LUT. The original math was tuned for warm interior real estate
// shots; on bright outdoor scenes the warm push + split-tone produced
// odd shifts in greens and skies. The new math is closer to "subtle
// grade" than "signature look" — still elevates the footage but plays
// nicer across mixed scene types (interior + exterior in same render).

// LUXURY — Kodak 2383 print emulation (subtle).
// Goal: warm, slightly desaturated, lifted blacks. v23.1 dialed back
// from v23.0's "filmic stylize" toward "natural grade" so backyards and
// hero exteriors don't pick up weird color casts.
function luxuryTransform(rgb) {
  let c = rgb;
  // Smaller warm WB push (was 1.04, now 1.02)
  c = [c[0] * 1.02, c[1] * 1.003, c[2] * 0.98];
  // Lighter shadow lift, less aggressive gamma
  c = liftGammaGain(c, [0.015, 0.012, 0.012], [1.025, 1.02, 1.015], [0.99, 0.99, 0.995]);
  // Softer S-curve (was 0.45, now 0.25)
  c = sCurve(c, 0.25);
  // Tiny desat — was 0.94 (-6%), now 0.97 (-3%)
  c = adjustSaturation(c, 0.97);
  // Gentle split-tone — half the v23.0 strength
  c = splitTone(c, [-0.008, 0.003, 0.012], [0.012, 0.006, -0.009], 0.40);
  return c;
}

// VIRAL — Modern teal-orange short-form look.
// Goal: punchy, social-native. v23.1 still distinctly teal-orange but
// less intense so exteriors don't go neon.
function viralTransform(rgb) {
  let c = rgb;
  // Smaller saturation bump (was 1.12, now 1.06)
  c = adjustSaturation(c, 1.06);
  // Softer contrast S-curve (was 0.85, now 0.50)
  c = sCurve(c, 0.50);
  // Light shadow lift
  c = liftGammaGain(c, [0.01, 0.012, 0.02], [1.0, 1.0, 0.99], [1.0, 1.0, 1.0]);
  // Lighter split-tone — half the v23.0 strength
  c = splitTone(c, [-0.02, 0.003, 0.03], [0.03, 0.012, -0.025], 0.55);
  // Smaller final sat kick
  c = adjustSaturation(c, 1.02);
  return c;
}

// MLS CLEAN — Rec.709 neutral.
// Goal: faithful, accurate, no "look." v23.1 essentially identity — only
// the unsharp pass adds anything visible. Compliance-grade.
function mlsCleanTransform(rgb) {
  let c = rgb;
  // Effectively identity WB (was 1.01, now 1.005)
  c = [c[0] * 1.005, c[1] * 1.002, c[2] * 0.998];
  // Microscopic gamma lift only
  c = liftGammaGain(c, [0.003, 0.003, 0.003], [1.01, 1.01, 1.01], [1.0, 1.0, 1.0]);
  // Tiny saturation lift (was 1.03, now 1.015)
  c = adjustSaturation(c, 1.015);
  return c;
}

// INVESTOR — Desaturated film stock.
// Goal: serious, slightly muted. v23.1 less aggressive desat so footage
// doesn't read as "color graded too much."
function investorTransform(rgb) {
  let c = rgb;
  // Smaller cool shift
  c = [c[0] * 0.992, c[1] * 1.0, c[2] * 1.008];
  // Lighter lift/gain
  c = liftGammaGain(c, [0.01, 0.01, 0.012], [1.01, 1.015, 1.02], [0.98, 0.985, 0.99]);
  // Was 0.78 (-22%), now 0.88 (-12%) — still distinctly muted but less so
  c = adjustSaturation(c, 0.88);
  // Lighter S-curve
  c = sCurve(c, 0.20);
  // Lighter split-tone
  c = splitTone(c, [-0.01, 0.005, 0.01], [0.003, 0.003, 0.003], 0.40);
  return c;
}

const STYLES = [
  { slug: "luxury", title: "EstateMotion Luxury — Kodak 2383 emulation (warm, filmic)", fn: luxuryTransform },
  { slug: "viral", title: "EstateMotion Viral — Teal-Orange (punchy, social-native)", fn: viralTransform },
  { slug: "mls", title: "EstateMotion MLS Clean — Rec.709 neutral (compliance-safe)", fn: mlsCleanTransform },
  { slug: "investor", title: "EstateMotion Investor — Desaturated film stock", fn: investorTransform }
];

/* ----------------------------------------------------------------
   .cube file writer
   ----------------------------------------------------------------
   Format spec: Adobe .cube v1.0
   Header lines start with `TITLE`, `LUT_3D_SIZE`, `DOMAIN_MIN`, `DOMAIN_MAX`.
   Body is N³ lines of "R G B" floats (space-separated, [0..1]),
   ordered with R varying fastest, then G, then B.
*/
function writeCubeContent(title, size, transformFn) {
  const lines = [];
  lines.push(`# Generated by render-worker/scripts/generate-luts.mjs`);
  lines.push(`# Do not hand-edit — re-run the script and let math win.`);
  lines.push(`TITLE "${title}"`);
  lines.push(`LUT_3D_SIZE ${size}`);
  lines.push(`DOMAIN_MIN 0.0 0.0 0.0`);
  lines.push(`DOMAIN_MAX 1.0 1.0 1.0`);
  lines.push(``);

  // Iteration order per .cube spec: R fastest, then G, then B.
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const input = [r / (size - 1), g / (size - 1), b / (size - 1)];
        const output = transformFn(input);
        lines.push(
          `${output[0].toFixed(6)} ${output[1].toFixed(6)} ${output[2].toFixed(6)}`
        );
      }
    }
  }
  return lines.join("\n") + "\n";
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  for (const style of STYLES) {
    const filePath = path.join(OUTPUT_DIR, `${style.slug}.cube`);
    const content = writeCubeContent(style.title, LUT_SIZE, style.fn);
    await fs.writeFile(filePath, content, "utf8");
    const sizeKb = Math.round(content.length / 1024);
    console.log(`✓ ${style.slug}.cube (${sizeKb}KB, ${LUT_SIZE}³ entries)`);
  }
  console.log(`\nWrote ${STYLES.length} LUTs to ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
