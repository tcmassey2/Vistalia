// Vistalia — /api/billing-portal
//
// Creates a Stripe Customer Portal session for the signed-in user and
// returns the redirect URL. The Customer Portal is Stripe's hosted UI
// for: managing payment method, viewing invoices, switching plans,
// canceling subscription. Configured at:
//   https://dashboard.stripe.com/settings/billing/portal
//
// Auth: requires Supabase JWT. Looks up the user's stripe_customer_id
// from profiles; returns 404 if they've never checked out (free trial
// users with no Stripe customer record).

const STRIPE_API_BASE = "https://api.stripe.com/v1";

export default async function handler(request, response) {
  setCors(response);
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Use POST /api/billing-portal." });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return response.status(503).json({
      error: "Billing portal isn't configured. STRIPE_SECRET_KEY missing on the server."
    });
  }

  const userId = await verifyUserId(request);
  if (!userId) return response.status(401).json({ error: "Sign in to manage billing." });

  try {
    const customerId = await getStripeCustomerId(userId);
    if (!customerId) {
      return response.status(404).json({
        error: "No Stripe customer on file yet. Pick a paid plan first to set up billing.",
        needsCheckout: true
      });
    }

    const returnUrl = inferReturnUrl(request);
    const params = new URLSearchParams({
      customer: customerId,
      return_url: returnUrl
    });
    const stripeRes = await fetch(`${STRIPE_API_BASE}/billing_portal/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    const payload = await stripeRes.json().catch(() => ({}));
    if (!stripeRes.ok) {
      const message = payload?.error?.message || `Stripe portal error (${stripeRes.status})`;
      console.warn("[billing-portal] Stripe rejected:", message);
      return response.status(stripeRes.status).json({ error: message });
    }
    if (!payload?.url) {
      return response.status(500).json({ error: "Stripe portal returned no URL." });
    }
    return response.status(200).json({ url: payload.url });
  } catch (error) {
    console.error("[billing-portal] threw:", error.message || error);
    return response.status(500).json({ error: error.message || "Billing portal request failed." });
  }
}

async function getStripeCustomerId(userId) {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) return "";
  const res = await fetch(
    `${supabaseUrl}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=stripe_customer_id&limit=1`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`
      }
    }
  );
  if (!res.ok) return "";
  const rows = await res.json().catch(() => []);
  const row = Array.isArray(rows) && rows.length ? rows[0] : null;
  return row?.stripe_customer_id || "";
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

// Where Stripe should redirect the user back to after they're done in the
// portal. We use the request's Origin header so localhost dev, preview
// deploys, and prod all work without env var configuration.
function inferReturnUrl(request) {
  const origin = String(request.headers.origin || request.headers.referer || "").split("?")[0];
  if (origin) return origin.replace(/\/$/, "") + "/app/";
  return "https://vistalia.ai/app/";
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
