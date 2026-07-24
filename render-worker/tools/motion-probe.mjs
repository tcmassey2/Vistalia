// Vistalia — Kling motion-prompt probe (v60.5 forensics, Jul 24 2026).
//
// Why this exists: the first Kling production canary shipped a slideshow —
// near-still clips (YDIF 0.70-1.13 vs the Veo hero's 2.18; a deterministic
// homography floor measures 0.72) that passed every fidelity gate, because
// QC and the sweep reward stillness. This probe isolated the levers:
//
//   v1ctl    avg 2.62 — CURRENT prompt shape (fidelity suffix intact) but
//                       duration "4" instead of the "3" floor. Duration
//                       alone restored hero-level motion.
//   v2kling  avg 3.34 — explicit dolly language + fidelity in the negative
//                       prompt. Fidelity intact on all 4 scenes. SHIPPED
//                       as KLING_MOTION_SUFFIX + the duration-4 floor.
//   v3strong avg 4.45 — "pronounced" tracking language. Hit 9.96 on one
//                       scene but traveled into an invented fireplace
//                       close-up. Too hot for MLS-safe claims. Benched.
//
// Head-slice check (production ships the first ~2.8s after trim): v2kling
// head-2.8s measured 2.01-2.97 — healthy without any trim-offset games.
//
// Run from /app on the Render worker (needs FAL_KEY, SUPABASE_* env):
//   node tools/motion-probe.mjs
// Clips upload to generated-videos/bakeoff/motion-probe/ (public bucket).

import { fal } from "@fal-ai/client";
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MODEL = "fal-ai/kling-video/v3/standard/image-to-video";
const NEG = "new objects, added furniture, removed furniture, morphing, warping, melting, texture boil, flickering, people, animals, text, captions, watermarks, logos";
const SUFFIX = " Photorealistic. Do not add, remove, or alter any object, surface, fixture, or architectural feature. No people, no animals. Absolutely NO text, captions, words, letters, numbers, signage, watermarks, on-screen UI, or graphic overlays of any kind anywhere in the frame. Every piece of furniture and every object is bolted in place in world space: nothing slides, drifts, follows, or travels with the camera - only the camera moves, with correct perspective parallax, through a completely static scene. The scene must remain exactly as photographed apart from the camera motion described.";

const SCENES = [
  { id: "greatroom", img: "03-great-room.jpg", subj: "the fireplace and the tall arched window wall" },
  { id: "kitchen", img: "04-kitchen.jpg", subj: "the kitchen island and the arched windows" },
  { id: "bedroom", img: "06-primary-bedroom.jpg", subj: "the bed and the kiva fireplace" },
  { id: "courtyard", img: "09-courtyard.jpg", subj: "the stone fountain" }
];
const VARIANTS = [
  ["v1ctl", (s) => "Slow cinematic push-in." + SUFFIX],
  ["v2kling", (s) => "Slow, steady cinematic dolly-in toward " + s.subj + ", smooth gliding camera with natural perspective parallax, luxury interior architecture film. Photorealistic and faithful to the source photo; all furniture and architecture unchanged."],
  ["v3strong", (s) => "Smooth cinematic tracking shot: the camera glides forward and gently sideways toward " + s.subj + ", pronounced but graceful camera movement, strong natural parallax, luxury real-estate film look."]
];

const OUT = "/tmp/motion-probe";
fs.mkdirSync(OUT, { recursive: true });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function ydif(file) {
  const o = execFileSync("ffprobe", ["-v","error","-f","lavfi","-i","movie="+file+",scale=270:480,signalstats","-show_entries","frame_tags=lavfi.signalstats.YDIF","-of","csv=p=0"]).toString().trim().split("\n").map(Number).filter(Number.isFinite);
  return o.reduce((a,b)=>a+b,0)/Math.max(1,o.length);
}

async function one(scene, vn, mk) {
  const t0 = Date.now();
  const res = await fal.subscribe(MODEL, { input: { prompt: mk(scene), image_url: "https://vistalia.ai/showcase/canary/"+scene.img, duration: "4", negative_prompt: NEG, generate_audio: false } });
  const url = res?.data?.video?.url;
  if (url === undefined || url === "") throw new Error("no video url");
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const f = path.join(OUT, scene.id+"-"+vn+".mp4");
  fs.writeFileSync(f, buf);
  const m = ydif(f);
  const key = "bakeoff/motion-probe/"+scene.id+"-"+vn+".mp4";
  await sb.storage.from("generated-videos").upload(key, buf, { contentType: "video/mp4", upsert: true });
  console.log("[probe] "+scene.id+" "+vn+" YDIF="+m.toFixed(2)+" "+Math.round((Date.now()-t0)/1000)+"s");
  return { scene: scene.id, vn, ydif: m };
}

const rows = [];
for (const scene of SCENES) {
  const r = await Promise.all(VARIANTS.map(([vn,mk]) => one(scene,vn,mk).catch((e)=>{ console.log("[probe] FAIL "+scene.id+" "+vn+": "+(e.message||e)); return {scene:scene.id,vn,ydif:NaN}; })));
  rows.push(...r);
}
console.log("=== SUMMARY (Veo hero=2.18; Kling prod 0.70-1.13; floor 0.72) ===");
for (const [vn] of VARIANTS) {
  const xs = rows.filter((r)=>r.vn===vn && Number.isFinite(r.ydif));
  console.log(vn+" avg="+(xs.reduce((a,b)=>a+b.ydif,0)/Math.max(1,xs.length)).toFixed(2)+" ["+xs.map((x)=>x.scene+":"+x.ydif.toFixed(2)).join(" ")+"]");
}
