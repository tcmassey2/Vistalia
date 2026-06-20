import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(dirname, "out", "async-verification");
const assetDir = path.join(outDir, "assets");
const workerUrl = (process.env.RENDER_WORKER_URL || "http://localhost:8787").replace(/\/$/, "");

await fs.mkdir(assetDir, { recursive: true });
await createSampleListingImages();
const assetServer = await startAssetServer(assetDir);

try {
  const manifest = createManifest(assetServer.baseUrl);
  const manifestPath = path.join(outDir, "professional-listing-video.manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const submit = await fetch(`${workerUrl}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manifest, requestedFormat: "vertical" })
  });
  const queued = await submit.json();
  if (!submit.ok) throw new Error(queued.error || `Render submit failed with ${submit.status}`);
  if (!queued.jobId) throw new Error("Render worker did not return a jobId.");

  const statusHistory = [queued.status];
  let finalStatus = queued;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await sleep(1500);
    const statusResponse = await fetch(`${workerUrl}/render/status/${encodeURIComponent(queued.jobId)}`);
    finalStatus = await statusResponse.json();
    if (!statusResponse.ok) throw new Error(finalStatus.error || `Status failed with ${statusResponse.status}`);
    statusHistory.push(finalStatus.status);
    if (["completed", "failed"].includes(finalStatus.status)) break;
  }

  if (finalStatus.status !== "completed") {
    throw new Error(finalStatus.error || `Render did not complete. Last status: ${finalStatus.status}`);
  }
  if (!finalStatus.mp4Url) {
    throw new Error("Completed render did not return mp4Url.");
  }

  const downloadedMp4 = await fetch(finalStatus.mp4Url);
  if (!downloadedMp4.ok) throw new Error(`MP4 URL was not downloadable: ${downloadedMp4.status}`);
  const mp4Buffer = Buffer.from(await downloadedMp4.arrayBuffer());
  const downloadedPath = path.join(outDir, "downloaded-professional-listing-video.mp4");
  await fs.writeFile(downloadedPath, mp4Buffer);

  const verification = {
    status: "completed",
    manifestPath,
    downloadedPath,
    jobId: finalStatus.jobId,
    mp4Url: finalStatus.mp4Url,
    thumbnailUrl: finalStatus.thumbnailUrl || "",
    statusHistory: [...new Set(statusHistory)],
    expectedDurationSeconds: expectedDurationSeconds(manifest),
    expectedDurationFrames: Math.round(expectedDurationSeconds(manifest) * 30),
    scenes: manifest.scenes.length,
    photoScenes: manifest.scenes.filter((scene) => scene.type === "photo").length,
    introScene: manifest.scenes.some((scene) => scene.type === "intro"),
    statScene: manifest.scenes.some((scene) => scene.type === "stats"),
    brandedOutro: "Rendered by VistaliaRender end card",
    motions: [...new Set(manifest.scenes.map((scene) => scene.cameraMotion || scene.renderMotion).filter(Boolean))],
    transitions: [...new Set(manifest.scenes.map((scene) => scene.transition).filter(Boolean))],
    downloadedBytes: mp4Buffer.length
  };
  await fs.writeFile(path.join(outDir, "verification.json"), JSON.stringify(verification, null, 2));
  console.log(JSON.stringify(verification, null, 2));
} finally {
  await assetServer.close();
}

async function createSampleListingImages() {
  const rooms = [
    ["exterior-hero", "Exterior Hero", "#28342f"],
    ["front-entry", "Entry", "#3d3328"],
    ["kitchen-island", "Kitchen", "#5a4638"],
    ["kitchen-detail", "Kitchen Detail", "#604b3f"],
    ["living-room", "Living Room", "#3d4648"],
    ["great-room", "Great Room", "#39434d"],
    ["dining-room", "Dining", "#4a3d34"],
    ["primary-bedroom", "Primary Bedroom", "#4b4a45"],
    ["bedroom-two", "Bedroom", "#45464c"],
    ["primary-bathroom", "Bathroom", "#465159"],
    ["bathroom-vanity", "Bath Detail", "#52606a"],
    ["backyard-pool", "Backyard Pool", "#214657"],
    ["covered-patio", "Patio", "#3e4d3e"],
    ["detail-fireplace", "Detail", "#3b3330"],
    ["neighborhood-view", "Neighborhood", "#2d4650"],
    ["twilight-exterior", "Twilight Exterior", "#222a34"]
  ];
  await Promise.all(rooms.map(async ([id, label, color], index) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200" viewBox="0 0 1600 1200">
      <defs>
        <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="${color}"/>
          <stop offset="1" stop-color="#0d0d0d"/>
        </linearGradient>
      </defs>
      <rect width="1600" height="1200" fill="url(#bg)"/>
      <rect x="96" y="110" width="1408" height="790" rx="32" fill="rgba(248,245,239,.13)" stroke="rgba(248,245,239,.42)" stroke-width="7"/>
      <rect x="${150 + (index % 5) * 42}" y="${180 + (index % 4) * 34}" width="520" height="310" rx="22" fill="rgba(255,255,255,.12)"/>
      <rect x="${820 - (index % 4) * 35}" y="${245 + (index % 5) * 24}" width="520" height="420" rx="26" fill="rgba(0,0,0,.15)"/>
      <text x="120" y="1024" fill="#F8F5EF" font-size="92" font-family="Arial" font-weight="900">${label}</text>
      <text x="126" y="1106" fill="#C7A76C" font-size="38" font-family="Arial" font-weight="800">Vistalia verification photo ${index + 1}</text>
    </svg>`;
    await fs.writeFile(path.join(assetDir, `${id}.svg`), svg);
  }));
}

function createManifest(baseUrl) {
  const photoIds = [
    "exterior-hero", "front-entry", "kitchen-island", "kitchen-detail",
    "living-room", "great-room", "dining-room", "primary-bedroom",
    "bedroom-two", "primary-bathroom", "bathroom-vanity", "backyard-pool",
    "covered-patio", "detail-fireplace", "neighborhood-view", "twilight-exterior"
  ];
  const orderedPhotos = photoIds.map((id, index) => {
    const durableUrl = `${baseUrl}/${id}.svg`;
    return {
      id: `photo-${index + 1}`,
      fileName: `${id}.svg`,
      durableUrl,
      publicUrl: durableUrl,
      imageUrl: durableUrl,
      category: categoryForId(id),
      order: index + 1
    };
  });
  let cursor = 0;
  const scenes = [
    cardScene("intro", "9828 E Pinnacle Peak Road", "$1,875,000 · Scottsdale", 3.4, "light_leak"),
    cardScene("stats", "5 Bed | 5.5 Bath | 5,640 Sq Ft", "$1,875,000", 3.2, "blur_wipe"),
    ...orderedPhotos.map((photo, index) => {
      const duration = 2.8;
      const scene = {
        order: index + 3,
        type: "photo",
        photoId: photo.id,
        fileName: photo.fileName,
        durableUrl: photo.durableUrl,
        publicUrl: photo.publicUrl,
        imageUrl: photo.imageUrl,
        sceneType: photo.category,
        duration,
        cameraMotion: cameraMotionForCategory(photo.category, index),
        transition: transitionForIndex(index),
        overlayText: overlayForCategory(photo.category),
        overlaySubline: index === 0 ? "$1,875,000 · Scottsdale" : "Real listing photo",
        beatMarker: `Beat ${index + 1}`,
        beatStart: Number(cursor.toFixed(2)),
        beatCut: Number((cursor + duration).toFixed(2)),
        realismGuardrail: "Use uploaded photos only. Do not hallucinate property features."
      };
      cursor += duration;
      return scene;
    })
  ].map((scene, index) => ({ ...scene, order: index + 1 }));
  cursor = 0;
  scenes.forEach((scene) => {
    scene.beatStart = Number(cursor.toFixed(2));
    cursor += Number(scene.duration || 0);
    scene.beatCut = Number(cursor.toFixed(2));
  });
  return {
    app: "Vistalia",
    product: "Professional real estate listing video renderer",
    project: {
      id: "async-verification",
      title: "Async Verification Listing",
      address: "9828 E Pinnacle Peak Road",
      price: "$1,875,000",
      beds: "5",
      baths: "5.5",
      squareFeet: "5,640",
      city: "Scottsdale",
      cta: "Schedule a private tour"
    },
    brandKit: {
      name: "Troy Massey",
      brokerage: "W & Partners",
      phone: "480-555-0199",
      website: "estatemotion.ai",
      ctaText: "Schedule a private tour"
    },
    template: { id: "modern-luxury", name: "Cinematic Luxury", accentColor: "#C7A76C" },
    stylePack: "luxury",
    music: { id: "none", url: "", fallback: "No music file configured; render uses beat-timed pacing." },
    orderedPhotos,
    scenes,
    compliance: {
      listingCourtesyOf: "Listing courtesy of demo brokerage",
      brokerageDisclaimer: "Information deemed reliable but not guaranteed.",
      equalHousing: true
    }
  };
}

function cardScene(type, headline, subline, duration, transition) {
  return {
    type,
    sceneType: type === "stats" ? "Property stats" : "Address intro",
    duration,
    overlayText: headline,
    overlaySubline: subline,
    transition,
    cameraMotion: type === "stats" ? "pull_out" : "push_in"
  };
}

function categoryForId(id) {
  if (id.includes("exterior") || id.includes("entry")) return "Exterior hero";
  if (id.includes("kitchen")) return "Kitchen";
  if (id.includes("living") || id.includes("great")) return "Living room";
  if (id.includes("dining")) return "Dining";
  if (id.includes("bedroom")) return "Primary bedroom";
  if (id.includes("bath")) return "Bathroom";
  if (id.includes("pool") || id.includes("patio")) return "Backyard / pool";
  if (id.includes("neighborhood")) return "Amenity";
  return "Detail shots";
}

function cameraMotionForCategory(category, index) {
  if (category === "Exterior hero") return "parallax_zoom";
  if (category === "Kitchen") return "lateral_pan";
  if (category === "Living room") return "push_in";
  if (category === "Bathroom") return "vertical_reveal";
  if (category === "Backyard / pool") return "pull_out";
  return index % 2 ? "detail_sweep" : "push_in";
}

function transitionForIndex(index) {
  return ["crossfade", "blur_wipe", "match_cut", "light_leak", "whip_pan"][index % 5];
}

function overlayForCategory(category) {
  return {
    "Exterior hero": "Cinematic curb appeal",
    Kitchen: "Kitchen designed for gathering",
    "Living room": "Open living spaces",
    Dining: "Dedicated dining moment",
    "Primary bedroom": "Private retreat",
    Bathroom: "Clean bath details",
    "Backyard / pool": "Outdoor living",
    Amenity: "Local lifestyle",
    "Detail shots": "Design detail"
  }[category] || "Property detail";
}

function expectedDurationSeconds(manifest) {
  return Number((manifest.scenes.reduce((sum, scene) => sum + Number(scene.duration || 0), 3.5)).toFixed(2));
}

function startAssetServer(root) {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const safeName = path.basename(url.pathname);
      const filePath = path.join(root, safeName);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
