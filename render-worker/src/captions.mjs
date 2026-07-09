// Vistalia — word-synced narration captions (v38.2, brand skins).
//
// Two skins share one engine (grouping, fixed-slot layout, word timing):
//
//   "luxury" (DEFAULT — Cinematic / Investor / MLS Clean): Playfair Display
//   SemiBold shipped as "Vistalia Serif", letterspaced uppercase, no stroke,
//   soft blurred shadow. Words fade in as a page; each word turns brand
//   gold (#C7A76C) as it is spoken and stays gilded until the page ends —
//   a quiet karaoke that reads Sotheby's, not TikTok. Troy 7/7: "add our
//   luxury style class to it."
//
//   "bold" (Modern Social): the Captions-app grammar — Poppins ExtraBold
//   as "Vistalia Caption", white with heavy stroke, active word on a
//   rounded gold box in ink with a pop. Verified frame-by-frame 7/7.
//
// Skin selection lives in runway-job (same style regex the music slotter
// uses) and flows through the voice mixer as `variant`.
//
// Engine invariants:
//   • Every word is its own ASS event at a FIXED, pre-measured position
//     (advance tables inlined below) — the line never reflows.
//   • Pages are ≤3 words, ≤1.4s, split on gaps >0.45s and on narration-
//     line boundaries (w.lineStart — pages never straddle sentences).
//   • ASS Fontsize is the font's WIN cell, not the em (VSFilter rule):
//     per-face cellPerEm multipliers below, layout math in real em px.
//   • Fonts ship in assets/fonts under families only we own — a system
//     "Poppins"/"Playfair Display" would hijack the match (bench 7/7).

import path from "node:path";
import { fileURLToPath } from "node:url";

/** Directory holding the shipped caption fonts — pass as the burn filter's
 *  fontsdir so libass finds them on any host. */
export const CAPTIONS_FONTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "fonts"
);

const UNIT = 1000; // both advance tables measured at 1000px em

// Poppins ExtraBold ("Vistalia Caption").
const ADV_BOLD = { "A": 755, "B": 671, "C": 758, "D": 735, "E": 548, "F": 561, "G": 757, "H": 743, "I": 308, "J": 584, "K": 726, "L": 491, "M": 935, "N": 765, "O": 787, "P": 636, "Q": 788, "R": 661, "S": 620, "T": 604, "U": 712, "V": 747, "W": 1076, "X": 739, "Y": 701, "Z": 613, "0": 657, "1": 387, "2": 569, "3": 610, "4": 691, "5": 655, "6": 635, "7": 523, "8": 653, "9": 606, " ": 191, "'": 243, "’": 346, "-": 578, ".": 301, ",": 314, "!": 423, "?": 538, "&": 814, "%": 904, "$": 661, "#": 919, "@": 1104, ":": 302, ";": 366, "/": 426, "(": 470, ")": 470, "+": 589, "\"": 451 };

// Cinzel SemiBold ("Vistalia Serif"), instanced wght=600. Cinzel replaced
// Playfair 7/7 ("make both look cleaner"): Playfair is high-contrast and
// its hairline strokes shimmer over moving video at caption size; Cinzel
// is inscriptional with even stroke weight — the estate/Trajan register,
// designed for display caps.
const ADV_SERIF = { "A": 715, "B": 645, "C": 773, "D": 821, "E": 613, "F": 577, "G": 824, "H": 845, "I": 370, "J": 364, "K": 724, "L": 598, "M": 946, "N": 857, "O": 865, "P": 630, "Q": 867, "R": 724, "S": 544, "T": 650, "U": 809, "V": 732, "W": 975, "X": 707, "Y": 689, "Z": 658, "0": 634, "1": 376, "2": 596, "3": 543, "4": 607, "5": 536, "6": 607, "7": 530, "8": 586, "9": 607, " ": 250, "'": 190, "’": 227, "-": 380, ".": 208, ",": 215, "!": 256, "?": 445, "&": 753, "%": 722, "$": 528, "#": 562, "@": 986, ":": 208, ";": 215, "/": 419, "(": 395, ")": 395, "+": 481, "\"": 347 };

// Colors in ASS &HBBGGRR& order.
const COL_WHITE = "&H00FFFFFF";
const COL_INK = "&H141414&";       // bold skin: active word text on gold
const COL_GOLD = "&H6CA7C7&";      // #C7A76C brand gold (BGR)
const COL_GOLD_LIT = "&H82BCD8&";  // #D8BC82 lifted gold — glyphs on scrim
const COL_OUTLINE = "&H00000000";  // solid black — transparent strokes read fuzzy

const VARIANTS = {
  luxury: {
    family: "Vistalia Serif",
    cellPerEm: 1.348,   // Cinzel-600 OS/2 win cell, verified via fontTools
    adv: ADV_SERIF,
    fallbackAdv: 715,
    emFrac: 0.037,
    trackingEm: 0.10,   // Cinzel carries generous natural spacing
    gapEm: 0.60,
    lineWextraEm: 0,
    active: "gild",     // spoken word fades to gold and stays gold
    pageAnim: "fade"
  },
  bold: {
    family: "Vistalia Caption",
    cellPerEm: 1.762,
    adv: ADV_BOLD,
    fallbackAdv: 765,
    emFrac: 0.040,
    trackingEm: 0,
    gapEm: 0.50,
    lineWextraEm: 0.40, // active box padding participates in line-fit
    active: "box",      // rounded gold box + ink text + pop
    pageAnim: "pop"
  }
};

function assTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(Math.min(cs, 99)).padStart(2, "0")}`;
}

function assEscape(text) {
  return String(text).replace(/\\/g, "").replace(/[{}]/g, "").replace(/\n/g, " ");
}

/** Captions-app "hide punctuation": strip terminal punctuation, keep
 *  apostrophes/hyphens/numbers ("3-CAR", "AGENT'S"). */
function displayWord(text) {
  return String(text).toUpperCase().replace(/[.,!?;:"()]/g, "").trim();
}

/** Measured pixel width of a display word at the given em, incl. tracking. */
function wordWidth(text, em, v) {
  let u = 0;
  for (const ch of text) u += v.adv[ch] ?? v.fallbackAdv;
  const chars = [...text].length;
  return (u / UNIT) * em + v.trackingEm * em * Math.max(0, chars - 1);
}

/** Group word timings into caption pages: ≤3 words, ≤1.4s span, split on
 *  gaps >0.45s and on narration-line boundaries (w.lineStart — set by the
 *  voice mixer so a page never straddles two sentences: "GATHERING A
 *  KITCHEN" reads broken even when the timing gap is tiny).
 *  words: [{ text, start, end, lineStart? }] in video seconds. */
export function groupWords(words) {
  const groups = [];
  let cur = null;
  for (const w of words) {
    if (!w.text || w.end <= w.start) continue;
    const startNew =
      !cur ||
      w.lineStart === true ||
      cur.words.length >= 3 ||
      w.start - cur.end > 0.45 ||
      w.end - cur.start > 1.4;
    if (startNew) {
      if (cur) groups.push(cur);
      cur = { start: w.start, end: w.end, lineStart: w.lineStart === true, words: [{ text: w.text, start: w.start, end: w.end }] };
    } else {
      cur.words.push({ text: w.text, start: w.start, end: w.end });
      cur.end = w.end;
    }
  }
  if (cur) groups.push(cur);
  // Rebalance orphans (masters 19+22): a 1-word page following a page in
  // the same narration line never ships alone —
  //   3+1 → 2+2   ("DEFINE THIS" / "LIVING ROOM")
  //   2+1 → 3     ("ENHANCE THE OPENNESS", when the merged span stays tight)
  for (let i = 1; i < groups.length; i++) {
    const g = groups[i], p = groups[i - 1];
    if (g.lineStart === true || g.words.length !== 1) continue;
    if (p.words.length === 3) {
      const moved = p.words.pop();
      g.words.unshift(moved);
      g.start = moved.start;
      p.end = p.words[p.words.length - 1].end;
    } else if (p.words.length <= 2 && (g.words[0].end - p.words[0].start) <= 1.8) {
      p.words.push(g.words[0]);
      p.end = g.words[0].end;
      groups.splice(i, 1);
      i--;
    }
  }
  // enforce a minimum on-screen time and no overlap with the next group
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    g.end = Math.max(g.end + 0.12, g.start + 0.35);
    if (i + 1 < groups.length && g.end > groups[i + 1].start) {
      g.end = Math.max(g.start + 0.2, groups[i + 1].start - 0.02);
    }
  }
  return groups;
}

/** Rounded-rect ASS drawing (\p1) spanning 0..w × 0..h. Positive
 *  coordinates only: libass anchors drawings by their bounding box, and
 *  negative-origin paths land offset (verified in bench 7/7). */
function roundedRect(w, h, r) {
  const x1 = 0, y1 = 0, x2 = w, y2 = h;
  const k = r * 0.55; // bezier circle approximation
  const f = (n) => n.toFixed(1);
  return (
    `m ${f(x1 + r)} ${f(y1)} ` +
    `l ${f(x2 - r)} ${f(y1)} ` +
    `b ${f(x2 - r + k)} ${f(y1)} ${f(x2)} ${f(y1 + r - k)} ${f(x2)} ${f(y1 + r)} ` +
    `l ${f(x2)} ${f(y2 - r)} ` +
    `b ${f(x2)} ${f(y2 - r + k)} ${f(x2 - r + k)} ${f(y2)} ${f(x2 - r)} ${f(y2)} ` +
    `l ${f(x1 + r)} ${f(y2)} ` +
    `b ${f(x1 + r - k)} ${f(y2)} ${f(x1)} ${f(y2 - r + k)} ${f(x1)} ${f(y2 - r)} ` +
    `l ${f(x1)} ${f(y1 + r)} ` +
    `b ${f(x1)} ${f(y1 + r - k)} ${f(x1 + r - k)} ${f(y1)} ${f(x1 + r)} ${f(y1)}`
  );
}

/** Build a complete .ass document for the given canvas geometry and skin. */
export function buildCaptionsAss({ words, playW = 1080, playH = 1920, variant = "luxury" }) {
  const v = VARIANTS[variant] || VARIANTS.luxury;
  const baseEm = Math.round(playH * v.emFrac);
  const baseFontSize = Math.round(baseEm * v.cellPerEm);
  const baseSpacing = +(v.trackingEm * baseEm).toFixed(1);
  const yC = Math.round(playH * 0.70);
  const maxLineW = playW * 0.86;
  const groups = groupWords(words);
  // Cleanliness pass 7/7: thin SOLID stroke (bold) beats a thick soft one;
  // luxury glyphs sit on the scrim so they need only a whisper of shadow.
  const outline = v.active === "box" ? Math.max(2, Math.round(baseEm / 16)) : 0;
  const shadow = v.active === "box"
    ? Math.max(2, Math.round(baseEm / 26))
    : Math.max(2, Math.round(baseEm / 24));

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playW}
PlayResY: ${playH}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${v.family},${baseFontSize},${COL_WHITE},${COL_WHITE},${COL_OUTLINE},&H50000000,0,0,0,0,100,100,${baseSpacing},0,1,${outline},${shadow},5,0,0,0,1
Style: Box,${v.family},${baseFontSize},${COL_GOLD},${COL_GOLD},&H00000000,&H78000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = [];

  for (const g of groups) {
    const texts = g.words.map((w) => displayWord(w.text)).map(assEscape);
    if (texts.every((t) => !t)) continue;
    const durMs = Math.round((g.end - g.start) * 1000);

    // Layout in em pixels: measure at base size, shrink per-page if wide.
    let em = baseEm;
    const widthsAt = (size) => texts.map((t) => wordWidth(t, size, v));
    const lineW = (ws, size) =>
      ws.reduce((a, b) => a + b, 0) + v.gapEm * size * (texts.length - 1) + v.lineWextraEm * size;
    let widths = widthsAt(em);
    if (lineW(widths, em) > maxLineW) {
      em = Math.max(18, Math.floor(em * (maxLineW / lineW(widths, em))));
      widths = widthsAt(em);
    }
    const total = widths.reduce((a, b) => a + b, 0) + v.gapEm * em * (texts.length - 1);
    const centers = [];
    let xCursor = playW / 2 - total / 2;
    for (let k = 0; k < texts.length; k++) {
      centers.push(xCursor + widths[k] / 2);
      xCursor += widths[k] + v.gapEm * em;
    }
    const sizeTags = em !== baseEm
      ? `\\fs${Math.round(em * v.cellPerEm)}${v.trackingEm ? `\\fsp${+(v.trackingEm * em).toFixed(1)}` : ""}`
      : "";

    // Page-entrance/exit tags (event-relative times — all layer-1 events of
    // a page start together, so the animation stays in lockstep).
    const pageIn = v.pageAnim === "pop"
      ? "\\fscx88\\fscy88\\t(0,100,\\fscx100\\fscy100)"
      : `\\alpha&HFF&\\t(0,140,\\alpha&H00&)\\t(${Math.max(0, durMs - 100)},${durMs},\\alpha&HFF&)`;

    // Luxury layer 0: smoked-glass scrim pill behind the line. White serif
    // with no stroke dies on bright listing photos (oak cabinetry, white
    // sofas — verified on frames 7/7); a soft ink pill at ~40% is the
    // film-credit answer and matches the webapp's dark-surface + gold UI.
    if (v.active === "gild") {
      const pillW = total + em * 1.4;
      const pillH = em * 2.0;
      // Clean glass, not smudge (7/7 cleanliness pass): crisp edge with
      // \blur1 only, ~53% ink fill, and a hairline gold rim — the same
      // dark-surface + gold accent language as the webapp and outro.
      // Gold glyphs need this dark ground: gold-on-oak is tone-on-tone.
      const fadeTags = `\\alpha&HFF&\\t(0,140,\\alpha&H78&)\\t(${Math.max(0, durMs - 100)},${durMs},\\alpha&HFF&)`;
      events.push(
        `Dialogue: 0,${assTime(g.start)},${assTime(g.end)},Box,,0,0,0,,` +
        `{\\an5\\pos(${(playW / 2).toFixed(1)},${yC})\\1c&H0A0A0A&\\bord2\\3c${COL_GOLD}\\shad0\\blur1${fadeTags}\\p1}` +
        roundedRect(pillW, pillH, em * 0.5) + `{\\p0}`
      );
    }

    // Layer 1: base white words for the whole page.
    for (let k = 0; k < texts.length; k++) {
      if (!texts[k]) continue;
      events.push(
        `Dialogue: 1,${assTime(g.start)},${assTime(g.end)},Cap,,0,0,0,,` +
        `{\\an5\\pos(${centers[k].toFixed(1)},${yC})${sizeTags}${pageIn}}${texts[k]}`
      );
    }

    // Active-word treatment.
    for (let k = 0; k < g.words.length; k++) {
      if (!texts[k]) continue;
      const wStart = Math.max(g.start, g.words[k].start);
      if (g.end - wStart < 0.04) continue;

      if (v.active === "box") {
        // Bold skin: gold rounded box + ink text while the word is spoken.
        const wEnd = k + 1 < g.words.length
          ? Math.max(wStart + 0.06, g.words[k + 1].start)
          : g.end;
        if (wEnd - wStart < 0.04) continue;
        const boxW = widths[k] + em * 0.36;
        const boxH = em * 1.30;
        const rad = em * 0.24;
        const POP_IN = `\\fscx94\\fscy94\\t(0,80,\\fscx106\\fscy106)`;
        events.push(
          `Dialogue: 2,${assTime(wStart)},${assTime(wEnd)},Box,,0,0,0,,` +
          `{\\an5\\pos(${centers[k].toFixed(1)},${yC})${POP_IN}\\p1}` +
          roundedRect(boxW, boxH, rad) + `{\\p0}`
        );
        events.push(
          `Dialogue: 3,${assTime(wStart)},${assTime(wEnd)},Cap,,0,0,0,,` +
          `{\\an5\\pos(${centers[k].toFixed(1)},${yC})${sizeTags}\\1c${COL_INK}\\bord0\\shad0${POP_IN}}` +
          texts[k]
        );
      } else {
        // Luxury skin: the word crossfades to gold as it is spoken and
        // stays gilded until the page leaves — quiet progressive karaoke.
        const oDurMs = Math.round((g.end - wStart) * 1000);
        events.push(
          `Dialogue: 2,${assTime(wStart)},${assTime(g.end)},Cap,,0,0,0,,` +
          `{\\an5\\pos(${centers[k].toFixed(1)},${yC})${sizeTags}\\1c${COL_GOLD_LIT}\\bord0\\shad0` +
          `\\alpha&HFF&\\t(0,120,\\alpha&H00&)\\t(${Math.max(0, oDurMs - 100)},${oDurMs},\\alpha&HFF&)}` +
          texts[k]
        );
      }
    }
  }

  return header + events.join("\n") + "\n";
}

/** Escape a filesystem path for ffmpeg's subtitles filter argument. */
export function subtitlesFilterPath(p) {
  return String(p).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}
