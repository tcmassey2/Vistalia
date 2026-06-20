import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderVistaliaJob } from "./src/render-job.mjs";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(dirname, "out", "openai-motion-director");
const assetDir = path.join(outDir, "assets");

await fs.mkdir(assetDir, { recursive: true });
await createListingImageAssets();
const assetServer = await startAssetServer(assetDir);

try {
  const manifest = createOpenAiDirectedManifest(assetServer.baseUrl);
  const manifestPath = path.join(outDir, "openai-edit-plan.manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const result = await renderVistaliaJob({ manifest, requestedFormat: "vertical" });
  const mp4Path = path.join(outDir, "openai-motion-director.mp4");
  const thumbnailPath = path.join(outDir, "openai-motion-director.png");
  if (result.localMp4Path) await fs.copyFile(result.localMp4Path, mp4Path);
  if (result.localThumbnailPath) await fs.copyFile(result.localThumbnailPath, thumbnailPath);

  const verification = {
    status: "complete",
    manifestPath,
    mp4Path,
    thumbnailPath,
    durationInFrames: result.durationInFrames,
    motions: manifest.scenes.map((scene) => scene.cameraMotion),
    transitions: manifest.scenes.map((scene) => scene.directorTransition)
  };
  await fs.writeFile(path.join(outDir, "verification.json"), JSON.stringify(verification, null, 2));
  console.log(JSON.stringify(verification, null, 2));
} finally {
  await assetServer.close();
}

async function createListingImageAssets() {
  const assets = [
    ["scottsdale-exterior-hero", "#272b25", "Exterior Hero"],
    ["scottsdale-kitchen-island", "#554635", "Kitchen"],
    ["scottsdale-living-room", "#34383a", "Living Room"],
    ["scottsdale-primary-bedroom", "#4b423b", "Primary Bedroom"],
    ["scottsdale-bathroom", "#d9d2c4", "Bathroom"],
    ["scottsdale-backyard-pool", "#1f4654", "Outdoor Living"]
  ];
  await Promise.all(assets.map(async ([slug, color, label], index) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200" viewBox="0 0 1600 1200">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="${color}"/>
          <stop offset="1" stop-color="#0D0D0D"/>
        </linearGradient>
      </defs>
      <rect width="1600" height="1200" fill="url(#g)"/>
      <rect x="96" y="110" width="1408" height="820" rx="36" fill="rgba(248,245,239,.13)" stroke="rgba(199,167,108,.55)" stroke-width="8"/>
      <circle cx="${260 + index * 58}" cy="${250 + index * 24}" r="72" fill="rgba(248,245,239,.18)"/>
      <text x="132" y="1036" fill="#F8F5EF" font-size="92" font-family="Arial" font-weight="900">${label}</text>
      <text x="136" y="1116" fill="#C7A76C" font-size="38" font-family="Arial" font-weight="700">OpenAI Motion Director verification asset</text>
    </svg>`;
    await fs.writeFile(path.join(assetDir, `${slug}.svg`), svg);
  }));
}

function createOpenAiDirectedManifest(baseUrl) {
  const project = {
    id: "openai-motion-director-demo",
    title: "OpenAI Motion Director Test",
    address: "9828 E Pinnacle Peak Road",
    price: "$2,850,000",
    beds: "5",
    baths: "5.5",
    squareFeet: "5,640",
    city: "Scottsdale",
    neighborhood: "Silverleaf",
    cta: "Schedule a private tour"
  };
  const brandKit = {
    name: "Troy Massey",
    brokerage: "W & Partners",
    phone: "480-555-0199",
    website: "estatemotion.ai",
    instagram: "@troymassey",
    ctaText: "Schedule a private tour"
  };
  const editPlan = {
    id: "saved-openai-motion-director-plan",
    source: "openai-motion-director",
    heroPhotoId: "photo-1",
    exportFormat: "vertical",
    selectedStyle: "Cinematic Luxury",
    musicMood: "slow cinematic luxury",
    introCard: {
      headline: project.address,
      subline: `${project.price} · ${project.beds} BD · ${project.baths} BA · ${project.squareFeet} SQ FT`
    },
    outroCard: {
      headline: brandKit.name,
      subline: `${brandKit.brokerage} · ${brandKit.phone}`
    },
    scenes: [
      scene("photo-1", 1, "exterior", "Exterior arrival", "Scottsdale curb appeal", "parallax_zoom", "crossfade", 2.8, ["exterior", "desert modern shape"]),
      scene("photo-2", 2, "kitchen", "Kitchen", "Open prep space and island focus", "lateral_pan", "blur_wipe", 2.5, ["kitchen", "island"]),
      scene("photo-3", 3, "living", "Living space", "Open gathering area", "push_in", "match_cut", 2.4, ["living area", "natural light"]),
      scene("photo-4", 4, "bedroom", "Primary retreat", "Private bedroom scene", "pull_out", "crossfade", 2.2, ["bedroom"]),
      scene("photo-5", 5, "bathroom", "Bath", "Clean bath detail", "vertical_reveal", "blur_wipe", 2.0, ["bathroom"]),
      scene("photo-6", 6, "outdoor", "Outdoor living", "Backyard lifestyle finish", "detail_sweep", "light_leak", 2.6, ["outdoor living"])
    ]
  };
  const orderedPhotos = editPlan.scenes.map((item, index) => {
    const fileName = [
      "scottsdale-exterior-hero.svg",
      "scottsdale-kitchen-island.svg",
      "scottsdale-living-room.svg",
      "scottsdale-primary-bedroom.svg",
      "scottsdale-bathroom.svg",
      "scottsdale-backyard-pool.svg"
    ][index];
    const durableUrl = `${baseUrl}/${fileName}`;
    return {
      id: item.photoId,
      fileName,
      durableUrl,
      publicUrl: durableUrl,
      imageUrl: durableUrl,
      sceneType: roomLabel(item.roomType)
    };
  });
  return {
    app: "Vistalia",
    project,
    brandKit,
    template: { id: "modern-luxury", name: "Cinematic Luxury", accentColor: "#C7A76C" },
    stylePack: "luxury",
    renderer: {
      engine: "Remotion",
      editPlanSource: "openai-motion-director",
      noHallucinatedPropertyFeatures: true
    },
    editPlan,
    music: { id: "luxury", url: "", fallback: "No music file configured; silent beat-timed pacing used." },
    copy: { hook: project.address },
    orderedPhotos,
    scenes: editPlan.scenes.map((item, index) => {
      const photo = orderedPhotos[index];
      return {
        order: item.order,
        type: "photo",
        photoId: item.photoId,
        fileName: photo.fileName,
        durableUrl: photo.durableUrl,
        imageUrl: photo.imageUrl,
        sceneType: roomLabel(item.roomType),
        roomType: item.roomType,
        visibleFeatures: item.visibleFeatures,
        qualityScore: item.qualityScore,
        duration: item.duration,
        cameraMotion: item.cameraMotion,
        renderMotion: renderMotionFor(item.cameraMotion),
        motionStyle: motionLabel(item.cameraMotion),
        transition: transitionLabel(item.transition),
        directorTransition: item.transition,
        beatMarker: `Beat ${index + 1}`,
        overlayText: item.overlay.headline,
        overlaySubline: item.overlay.subline,
        editPlanOverlay: item.overlay,
        introCard: index === 0 ? editPlan.introCard : null,
        outroCard: index === editPlan.scenes.length - 1 ? editPlan.outroCard : null,
        realismGuardrail: "Use only the uploaded photo. Do not hallucinate rooms, views, features, or objects."
      };
    })
  };
}

function scene(photoId, order, roomType, headline, subline, cameraMotion, transition, duration, visibleFeatures) {
  return {
    photoId,
    order,
    roomType,
    visibleFeatures,
    qualityScore: 88,
    duration,
    cameraMotion,
    transition,
    overlay: { headline, subline }
  };
}

function roomLabel(roomType) {
  return {
    exterior: "Exterior hero",
    kitchen: "Kitchen",
    living: "Living room",
    bedroom: "Primary bedroom",
    bathroom: "Bathroom",
    outdoor: "Backyard / pool"
  }[roomType] || "Detail shots";
}

function motionLabel(cameraMotion) {
  return {
    push_in: "Push-in",
    pull_out: "Pull-out",
    lateral_pan: "Lateral pan",
    vertical_reveal: "Vertical reveal",
    parallax_zoom: "Parallax zoom",
    detail_sweep: "Detail sweep"
  }[cameraMotion] || "Push-in";
}

function renderMotionFor(cameraMotion) {
  return {
    push_in: "Push-in",
    pull_out: "Pull-out",
    lateral_pan: "Slow pan",
    vertical_reveal: "Vertical social framing",
    parallax_zoom: "Depth zoom",
    detail_sweep: "Orbit simulation"
  }[cameraMotion] || "Push-in";
}

function transitionLabel(transition) {
  return {
    crossfade: "soft dissolve",
    blur_wipe: "blur wipe",
    whip_pan: "whip pan",
    match_cut: "match cut",
    light_leak: "light leak"
  }[transition] || "soft dissolve";
}

function startAssetServer(root) {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const filePath = path.join(root, path.basename(url.pathname));
      const body = await fs.readFile(filePath);
      response.writeHead(200, { "Content-Type": "image/svg+xml" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}
