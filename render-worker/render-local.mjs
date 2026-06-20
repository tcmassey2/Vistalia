import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderVistaliaJob } from "./src/render-job.mjs";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(dirname, "out", "marketing-os");
const assetDir = path.join(outDir, "assets");

const modes = [
  { id: "listing-reel", name: "Listing Reel", stylePack: "luxury", templateId: "modern-luxury" },
  { id: "seller-lead-magnet", name: "Seller Lead Magnet", stylePack: "personalBrand", templateId: "personal-brand-agent" },
  { id: "investor-breakdown", name: "Investor Deal Breakdown", stylePack: "investor", templateId: "investor-wholesale" },
  { id: "wholesale-opportunity", name: "Wholesale Opportunity", stylePack: "investor", templateId: "investor-wholesale" },
  { id: "neighborhood-spotlight", name: "Neighborhood Spotlight", stylePack: "neighborhood", templateId: "neighborhood-authority" },
  { id: "agent-brand", name: "Agent Brand", stylePack: "personalBrand", templateId: "personal-brand-agent" }
];

const photoScenes = [
  ["Exterior hero", "Exterior slow zoom", "#2c352f", "Exterior"],
  ["Kitchen", "Kitchen lateral pan", "#56473a", "Kitchen"],
  ["Living room", "Living depth zoom", "#3f4548", "Living"],
  ["Backyard / pool", "Exterior slow zoom", "#244657", "Outdoor"]
];

await fs.mkdir(assetDir, { recursive: true });
await createDurableTestImages();
const assetServer = await startAssetServer(assetDir);

const results = [];
try {
  for (const mode of modes) {
    const manifest = createManifest(mode, assetServer.baseUrl);
    const manifestPath = path.join(outDir, `${mode.id}.manifest.json`);
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const result = await renderVistaliaJob({ manifest, requestedFormat: "vertical" });
    const mp4Path = path.join(outDir, `${mode.id}.mp4`);
    const thumbnailPath = path.join(outDir, `${mode.id}.png`);
    if (result.localMp4Path) await fs.copyFile(result.localMp4Path, mp4Path);
    if (result.localThumbnailPath) await fs.copyFile(result.localThumbnailPath, thumbnailPath);
    results.push({
      mode: mode.name,
      manifestPath,
      mp4Path,
      thumbnailPath,
      durationInFrames: result.durationInFrames,
      overlayHeadlines: manifest.scenes.map((scene) => scene.marketingOverlay?.headline).filter(Boolean)
    });
  }
} finally {
  await assetServer.close();
}

await fs.writeFile(path.join(outDir, "render-results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ outDir, results }, null, 2));

async function createDurableTestImages() {
  await Promise.all(photoScenes.map(async ([sceneType, , color, label], index) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200" viewBox="0 0 1600 1200">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="${color}"/>
          <stop offset="1" stop-color="#111111"/>
        </linearGradient>
      </defs>
      <rect width="1600" height="1200" fill="url(#g)"/>
      <rect x="110" y="120" width="1380" height="810" rx="34" fill="rgba(248,245,239,.12)" stroke="rgba(248,245,239,.42)" stroke-width="8"/>
      <text x="130" y="1040" fill="#F8F5EF" font-size="98" font-family="Arial" font-weight="900">${label}</text>
      <text x="134" y="1120" fill="#C7A76C" font-size="38" font-family="Arial" font-weight="700">Vistalia durable test image ${index + 1}</text>
    </svg>`;
    await fs.writeFile(path.join(assetDir, `${slug(sceneType)}.svg`), svg);
  }));
}

function createManifest(mode, baseUrl) {
  const orderedPhotos = photoScenes.map(([sceneType], index) => {
    const durableUrl = `${baseUrl}/${slug(sceneType)}.svg`;
    return {
      id: `photo-${index + 1}`,
      fileName: `${slug(sceneType)}.svg`,
      durableUrl,
      publicUrl: durableUrl,
      imageUrl: durableUrl,
      sceneType
    };
  });
  const project = mode.id === "neighborhood-spotlight"
    ? { title: "Arcadia Lifestyle Spotlight", address: "", price: "$725,000", beds: "3", baths: "2", squareFeet: "1,950", city: "Phoenix", neighborhood: "" }
    : { title: "Marketing OS Test Listing", address: "123 Demo Lane", price: "$725,000", beds: "3", baths: "2", squareFeet: "1,950", city: "Phoenix", neighborhood: "Arcadia", cta: mode.id === "seller-lead-magnet" ? "Book a seller consultation" : "Schedule a private tour" };
  const brandKit = mode.id === "agent-brand"
    ? { name: "", brokerage: "", phone: "", website: "", instagram: "", ctaText: "" }
    : { name: "Troy Massey", brokerage: "W & Partners", phone: "480-555-0199", website: "vistalia.ai", instagram: "@troymassey", ctaText: "Schedule a private tour" };
  const marketingOS = {
    contentMode: mode.id,
    conversionGoal: mode.id === "investor-breakdown" ? "Investor details" : mode.id === "wholesale-opportunity" ? "Join waitlist" : mode.id === "seller-lead-magnet" ? "Seller consultation" : "Schedule showing",
    investorEstimateSummary: mode.id.includes("investor") || mode.id.includes("wholesale")
      ? { arv: mode.id === "wholesale-opportunity" ? "" : 850000, rehab: mode.id === "wholesale-opportunity" ? "" : 95000, assignment: 15000, projectedSpread: 740000, dealStructure: "Assignment-style estimate" }
      : {}
  };
  return {
    app: "Vistalia",
    project,
    brandKit,
    compliance: {
      enabled: true,
      listingCourtesyOf: "Listing courtesy of demo brokerage",
      brokerageDisclaimer: "Information deemed reliable but not guaranteed.",
      equalHousing: true,
      mlsDisclaimer: mode.templateId === "mls-clean" ? "MLS-safe clean export." : ""
    },
    marketingOS,
    template: { id: mode.templateId, name: mode.name, accentColor: "#C7A76C" },
    stylePack: mode.stylePack,
    music: { id: "none", url: "", fallback: "No music file configured" },
    copy: { hook: `${mode.name} demo`, highlights: ["Uses uploaded photos", "MLS-safe captions", "Editable before export"] },
    orderedPhotos,
    scenes: photoScenes.map(([sceneType, motionStyle], index) => ({
      order: index + 1,
      type: "photo",
      photoId: orderedPhotos[index].id,
      fileName: orderedPhotos[index].fileName,
      durableUrl: orderedPhotos[index].durableUrl,
      imageUrl: orderedPhotos[index].imageUrl,
      sceneType,
      duration: 1.25,
      motionStyle,
      renderMotion: motionStyle,
      transition: index % 2 === 0 ? "cinematic fade" : "clean slide",
      beatMarker: `Beat ${index + 1}`,
      overlayText: `${mode.name}: ${sceneType}`,
      marketingOverlay: marketingOverlayForMode(mode.id, index, sceneType),
      featureCard: sceneType,
      realismGuardrail: "Use uploaded photos only. Do not hallucinate property features."
    }))
  };
}

function marketingOverlayForMode(mode, index, sceneType) {
  if (mode === "seller-lead-magnet") {
    return { label: "Seller Preview", headline: index === 0 ? "See what your home could look like online" : "Premium listing marketing preview", lines: ["Your photos", "Personal Brand Agent", "Seller consultation"], disclaimer: "Marketing preview only. No sale price or outcome is guaranteed.", variant: "seller" };
  }
  if (mode === "investor-breakdown") {
    return { label: "Investor Estimate", headline: "Deal snapshot", lines: ["ARV est. $850,000", "Rehab est. $95,000", "Projected spread est. $740,000"], disclaimer: "All figures are estimates and require independent verification.", variant: "investor" };
  }
  if (mode === "wholesale-opportunity") {
    return { label: "Wholesale Opportunity", headline: "Assignment-style deal summary", lines: ["ARV est. Estimate needed", "Rehab est. Estimate needed", "Assignment est. $15,000"], disclaimer: "Wholesale/investor figures are estimates, not guarantees or financial advice.", variant: "wholesale" };
  }
  if (mode === "neighborhood-spotlight") {
    return { label: "Neighborhood Spotlight", headline: index === 0 ? "Phoenix lifestyle" : `${sceneType} lifestyle angle`, lines: ["Phoenix living", "Local context", "Ask me about this area"], disclaimer: "Lifestyle captions are based on listing location and uploaded photos.", variant: "neighborhood" };
  }
  if (mode === "agent-brand") {
    return { label: "Agent Authority", headline: "Your agent can help you move next", lines: ["Real Estate Advisor", "Schedule showing"], disclaimer: "Agent contact CTA card.", variant: "agent" };
  }
  return null;
}

function startAssetServer(root) {
  const mime = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const safeName = path.basename(url.pathname);
      const filePath = path.join(root, safeName);
      const body = await fs.readFile(filePath);
      response.writeHead(200, { "Content-Type": mime[path.extname(filePath)] || "application/octet-stream" });
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

function slug(value) {
  return String(value || "asset").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "asset";
}
