// EstateMotion — Property auto-fill via RentCast public-records API.
//
// Agent types an address, we hit RentCast, return normalized listing facts
// the form can populate. This is what eliminates AI-hallucination liability:
// every fact in the rendered video traces back to a verifiable public
// record source rather than something the AI imagined from a photo.
//
// Switching to a real MLS feed (Trestle by CoreLogic) is a one-file swap
// later — same response shape, different upstream URL + auth header. Until
// the LLC is set up, public records are 90% as good with 0% of the
// regulatory friction.
//
// RentCast pricing reminder: free tier covers 50 lookups/month, paid
// plans start at $49/mo for 1k+ lookups. At our render volume (one
// auto-fill per project), we'll stay on the free tier well into 4-5
// figure ARR.

const RENTCAST_BASE = "https://api.rentcast.io/v1";

export default async function handler(request, response) {
  setCorsHeaders(response);
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  if (request.method !== "GET" && request.method !== "POST") {
    response.status(405).json({ status: "failed", error: "Use GET or POST." });
    return;
  }

  if (!process.env.RENTCAST_API_KEY) {
    response.status(503).json({
      status: "failed",
      error: "Property lookup not configured. Set RENTCAST_API_KEY in Vercel env vars.",
      errorCategory: "missing_api_key"
    });
    return;
  }

  try {
    const address = extractAddress(request);
    if (!address) {
      response.status(400).json({ status: "failed", error: "address parameter required." });
      return;
    }

    const params = new URLSearchParams({ address });
    const apiResponse = await fetchWithTimeout(
      `${RENTCAST_BASE}/properties?${params}`,
      {
        method: "GET",
        headers: {
          "X-Api-Key": process.env.RENTCAST_API_KEY,
          Accept: "application/json"
        }
      },
      15000
    );

    if (!apiResponse.ok) {
      const errBody = await apiResponse.text().catch(() => "");
      const reason = parseRentcastError(errBody) || `RentCast returned ${apiResponse.status}.`;
      // 404 = address not found in their database. Bubble up as a friendly
      // message rather than a generic error so the agent knows to fall
      // back to manual entry.
      if (apiResponse.status === 404) {
        response.status(200).json({
          status: "not_found",
          message: "We couldn't find this address in public records. Fill in the details manually — it'll still render."
        });
        return;
      }
      response.status(502).json({
        status: "failed",
        error: `Property lookup failed: ${reason}`
      });
      return;
    }

    const payload = await apiResponse.json().catch(() => null);
    const property = normalizeRentcastResponse(payload);
    if (!property) {
      response.status(200).json({
        status: "not_found",
        message: "Public records returned no usable details for this address."
      });
      return;
    }

    response.status(200).json({
      status: "ok",
      source: "rentcast_public_records",
      property
    });
  } catch (error) {
    response.status(500).json({
      status: "failed",
      error: error.message || "Property lookup failed."
    });
  }
}

/* ============================================================
   Normalize RentCast response → EstateMotion ListingDetails shape
   ============================================================ */

// RentCast's /properties endpoint returns either a single object or an
// array, depending on whether they got an exact match. Handle both.
function normalizeRentcastResponse(payload) {
  if (!payload) return null;
  const record = Array.isArray(payload) ? payload[0] : payload;
  if (!record || typeof record !== "object") return null;
  if (!record.formattedAddress && !record.addressLine1) return null;

  const beds = record.bedrooms != null ? String(record.bedrooms) : "";
  const baths = record.bathrooms != null ? String(record.bathrooms) : "";
  const sqft = record.squareFootage != null ? formatNumber(record.squareFootage) : "";
  const lotSqft = record.lotSize != null ? Number(record.lotSize) : null;
  const yearBuilt = record.yearBuilt ? String(record.yearBuilt) : "";

  const lastSale = record.lastSalePrice != null
    ? `$${formatNumber(record.lastSalePrice)}`
    : "";

  return {
    // The fields below map 1:1 onto the existing ListingDetails type.
    // The renderer doesn't care where they came from — only that they're
    // populated and accurate.
    address: cleanText(record.formattedAddress || record.addressLine1, 120),
    city: cleanText([record.city, record.state].filter(Boolean).join(", "), 80),
    beds,
    baths,
    squareFeet: sqft,
    // Bonus fields the agent can show off in the listing or use as
    // overlay material — also surface them in the lookup result so the
    // UI can display "verified facts" alongside the auto-fill.
    extras: {
      yearBuilt,
      lotSize: lotSqft != null ? formatLotSize(lotSqft) : "",
      propertyType: cleanText(record.propertyType || "", 40),
      lastSalePrice: lastSale,
      lastSaleDate: cleanText(record.lastSaleDate || "", 24),
      latitude: typeof record.latitude === "number" ? record.latitude : null,
      longitude: typeof record.longitude === "number" ? record.longitude : null,
      county: cleanText(record.county || "", 40),
      apn: cleanText(record.assessorID || "", 40)
    }
  };
}

function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-US");
}

// RentCast returns lot size in square feet. Convert to a human label:
// > 5,000 sqft → acres with one decimal, otherwise sqft.
function formatLotSize(sqft) {
  if (!Number.isFinite(sqft) || sqft <= 0) return "";
  if (sqft >= 5000) {
    const acres = sqft / 43560;
    return `${acres.toFixed(2)} acres`;
  }
  return `${formatNumber(sqft)} sqft`;
}

function cleanText(value, maxLength = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function extractAddress(request) {
  if (request.method === "GET") {
    const url = new URL(request.url || "", "http://localhost");
    return cleanText(url.searchParams.get("address") || "", 200);
  }
  const body = parseBody(request.body);
  return cleanText(body.address || "", 200);
}

function parseRentcastError(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.message || parsed?.error || parsed?.detail || "";
  } catch {
    return text.slice(0, 200);
  }
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
