// EstateMotion — create a Stripe Checkout Session for a subscription tier.
// POST /api/create-checkout-session  body: { tier, returnUrl }
// Authorization: Bearer <Supabase user JWT>
//
// Returns: { url } — redirect the user to this URL to complete payment.
//
// Required env vars on Vercel:
//   STRIPE_SECRET_KEY                     - Stripe secret key (sk_live_… or sk_test_…)
//   STRIPE_PRICE_QUICK_REEL              - price_… id for $79/mo
//   STRIPE_PRICE_CINEMATIC_AI            - price_… id for $149/mo
//   STRIPE_PRICE_CINEMATIC_4K            - price_… id for $299/mo
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  - to fetch / update user profile
//   APP_URL                              - your public site URL, e.g. https://estatemotion.vercel.app

import { rateLimit } from "./_lib/rate-limit.js";

const TIER_TO_PRICE_ENV = {
  quick_reel: "STRIPE_PRICE_QUICK_REEL",
  cinematic_ai: "STRIPE_PRICE_CINEMATIC_AI",
  cinematic_4k: "STRIPE_PRICE_CINEMATIC_4K",
  // Brokerage-tier subscription. Set STRIPE_PRICE_BROKERAGE on Vercel
  // to a recurring per-seat price; quantity is set from the request
  // body's `seats` field (default 5, min 3, max 100).
  brokerage: "STRIPE_PRICE_BROKERAGE"
};

export default async function handler(request, response) {
  setCors(response);
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Use POST." });
  }

  // Cap checkout-session creation. Honest users hit this 1-2 times max
  // per upgrade flow; an attacker spamming it would burn Stripe API quota
  // and fill our customers list with junk records.
  const limited = await rateLimit(request, response, {
    bucket: "checkout",
    max: 20,
    windowMs: 60 * 60 * 1000
  });
  if (limited) return;

  if (!process.env.STRIPE_SECRET_KEY) {
    return response.status(503).json({ error: "Billing is not configured. Set STRIPE_SECRET_KEY on Vercel." });
  }

  try {
    const body = parseBody(request.body);
    const tier = String(body.tier || "");
    const priceEnv = TIER_TO_PRICE_ENV[tier];
    const priceId = priceEnv ? process.env[priceEnv] : "";
    if (!priceId) {
      return response.status(400).json({ error: `Unknown or unconfigured tier: ${tier}.` });
    }

    const userId = await verifyUserId(request);
    if (!userId) {
      return response.status(401).json({ error: "Sign in to start a subscription." });
    }

    const profile = await fetchOrCreateProfile(userId, body.email);
    const customerId = profile.stripe_customer_id || (await createStripeCustomer({
      email: body.email || profile.email || "",
      userId
    }));

    if (customerId !== profile.stripe_customer_id) {
      await updateProfile(userId, { stripe_customer_id: customerId });
    }

    const appUrl = process.env.APP_URL || `${request.headers["x-forwarded-proto"] || "https"}://${request.headers.host}`;
    const returnUrl = String(body.returnUrl || `${appUrl}/app`);

    // Brokerage tier is per-seat. Quantity comes from the request; clamp
    // sensibly so a typo can't 100x the bill. Solo tiers stay at qty=1.
    const isBrokerage = tier === "brokerage";
    const seatsRaw = Number(body?.seats || 5);
    const seats = isBrokerage ? Math.max(3, Math.min(100, Math.round(seatsRaw))) : 1;
    const orgId = isBrokerage ? String(body?.organizationId || "").trim() : "";

    const sessionParams = {
      "mode": "subscription",
      "customer": customerId,
      "client_reference_id": userId,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": String(seats),
      "success_url": `${returnUrl}?checkout=success&tier=${encodeURIComponent(tier)}`,
      "cancel_url": `${returnUrl}?checkout=cancelled`,
      "subscription_data[metadata][user_id]": userId,
      "subscription_data[metadata][tier]": tier,
      "allow_promotion_codes": "true"
    };
    if (isBrokerage && orgId) {
      sessionParams["subscription_data[metadata][organization_id]"] = orgId;
      sessionParams["subscription_data[metadata][seats]"] = String(seats);
    }
    const session = await stripe("/v1/checkout/sessions", "POST", sessionParams);

    return response.status(200).json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error("[checkout] error", { message: error.message, stack: error.stack });
    return response.status(500).json({ error: error.message || "Checkout session creation failed." });
  }
}

async function verifyUserId(request) {
  const auth = String(request.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) return "";
  const token = auth.slice(7);
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const anonKey = process.env.SUPABASE_ANON_KEY || "";
  if (!supabaseUrl || !anonKey) return "";
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return "";
  const data = await res.json().catch(() => ({}));
  return data?.id || "";
}

async function fetchOrCreateProfile(userId, email) {
  const res = await supabaseAdmin(`profiles?user_id=eq.${userId}&select=*`, "GET");
  const rows = await res.json().catch(() => []);
  if (Array.isArray(rows) && rows[0]) return rows[0];
  // Trigger should auto-create, but just in case:
  await supabaseAdmin("profiles", "POST", {
    user_id: userId,
    email: email || "",
    tier: "trial",
    monthly_video_quota: 1,
    subscription_status: "trialing"
  });
  const retry = await supabaseAdmin(`profiles?user_id=eq.${userId}&select=*`, "GET");
  const retryRows = await retry.json().catch(() => []);
  return retryRows[0] || { user_id: userId, email, stripe_customer_id: null };
}

async function updateProfile(userId, patch) {
  return supabaseAdmin(`profiles?user_id=eq.${userId}`, "PATCH", patch);
}

async function createStripeCustomer({ email, userId }) {
  const customer = await stripe("/v1/customers", "POST", {
    email,
    "metadata[user_id]": userId
  });
  return customer.id;
}

async function stripe(path, method, params) {
  const url = `https://api.stripe.com${path}`;
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    }
  };
  if (params && method !== "GET") {
    init.body = new URLSearchParams(params).toString();
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Stripe ${method} ${path} failed (${response.status}): ${errorBody.slice(0, 240)}`);
  }
  return response.json();
}

async function supabaseAdmin(pathAndQuery, method, body) {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) throw new Error("Supabase admin env vars missing.");
  const init = {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    }
  };
  if (body && method !== "GET") init.body = JSON.stringify(body);
  return fetch(`${supabaseUrl}/rest/v1/${pathAndQuery}`, init);
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  try { return JSON.parse(body); } catch { return {}; }
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
