// Vistalia — Stripe webhook handler.
// Mounted at POST /api/stripe-webhook
// Configure in Stripe Dashboard → Developers → Webhooks → Endpoint URL:
//   https://YOUR-DOMAIN/api/stripe-webhook
// Events to listen for:
//   - checkout.session.completed
//   - customer.subscription.created
//   - customer.subscription.updated
//   - customer.subscription.deleted
//   - invoice.payment_failed
//
// IMPORTANT: This endpoint must receive the RAW request body to verify the
// Stripe signature. On Vercel, that means disabling automatic body parsing
// for this route.

import crypto from "node:crypto";

export const config = {
  api: { bodyParser: false }
};

// v26.5: tiers map by PRODUCT id (covers monthly + annual prices with one
// entry, survives price edits). Defaults are the live June 2026 products;
// env vars override for test mode. Legacy price-id mapping retained for
// any subscriber still on a pre-v26 price.
const PRODUCT_TIERS = {
  [process.env.STRIPE_PRODUCT_LAUNCH || "prod_UWBRgVofDDfSGD"]: "launch",
  [process.env.STRIPE_PRODUCT_PRO || "prod_UnjP2x6bU76sCR"]: "pro",
  [process.env.STRIPE_PRODUCT_STUDIO || "prod_UnjRqWSQ0zJd4m"]: "studio"
};

const TIER_FROM_PRICE = (priceId, productId) => {
  if (productId && PRODUCT_TIERS[productId]) return PRODUCT_TIERS[productId];
  if (priceId === process.env.STRIPE_PRICE_QUICK_REEL) return "quick_reel";
  if (priceId === process.env.STRIPE_PRICE_CINEMATIC_AI) return "cinematic_ai";
  if (priceId === process.env.STRIPE_PRICE_CINEMATIC_4K) return "cinematic_4k";
  return null;
};

const QUOTA_FOR_TIER = {
  trial: 1,        // one free first video
  // q7 lineup (docs/PRICING_Q7.md) — quotas unchanged from q6, prices raised:
  pro: 5,          // $69/mo ($490/yr) — 5 credits / month
  studio: 10,      // $149/mo ($990/yr) — 10 credits / month
  // Legacy tiers — retired from sale, honored until existing subs lapse.
  launch: 8,       // old $99/mo, 8 renders
  quick_reel: 10,
  cinematic_ai: 25,
  cinematic_4k: 60
};

export default async function handler(request, response) {
  if (request.method !== "POST") {
    return response.status(405).end();
  }

  const sig = request.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
  if (!webhookSecret) {
    console.warn("[stripe-webhook] STRIPE_WEBHOOK_SECRET not set; rejecting.");
    return response.status(503).end();
  }

  let raw = "";
  for await (const chunk of request) raw += chunk;

  if (!verifySignature(raw, sig, webhookSecret)) {
    console.warn("[stripe-webhook] signature verification failed");
    return response.status(400).send("Invalid signature");
  }

  let event;
  try { event = JSON.parse(raw); } catch {
    return response.status(400).send("Invalid JSON");
  }

  // v26: idempotency. Stripe retries webhooks on any non-2xx (and sometimes
  // on timeouts even after a 2xx). Replayed subscription.updated events
  // re-run updateProfile — including the videos_used_this_month: 0 reset,
  // which makes an old replayed event a quota-reset bug. Dedupe by event ID.
  // In-memory only: fine for single-region Vercel today; a durable
  // stripe_events table is queued for the next Supabase migration.
  if (event.id) {
    if (seenEvents.has(event.id)) {
      return response.status(200).json({ received: true, duplicate: true });
    }
    rememberEvent(event.id);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await onCheckoutCompleted(event.data.object);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await onSubscriptionChanged(event.data.object);
        break;
      case "customer.subscription.deleted":
        await onSubscriptionCanceled(event.data.object);
        break;
      case "invoice.payment_failed":
        await onPaymentFailed(event.data.object);
        break;
      default:
        // Ignore unrecognized event types
        break;
    }
    return response.status(200).json({ received: true });
  } catch (error) {
    console.error("[stripe-webhook] handler error", { type: event.type, message: error.message });
    return response.status(500).send("Webhook handler error");
  }
}

async function onCheckoutCompleted(session) {
  const userId = session.client_reference_id || session.metadata?.user_id;
  if (!userId) return;

  // v26.6: one-off credit-pack purchase (mode=payment). Grant credits and
  // stop — there's no subscription to activate. Idempotent per session id
  // via grant_render_credits (credit_grants unique constraint).
  if (session.mode === "payment") {
    const credits = Number(session.metadata?.credits || 0);
    if (credits > 0 && session.payment_status === "paid") {
      await grantCredits(userId, credits, session.id);
    }
    // Make sure we have the customer id on file for future purchases.
    if (session.customer) {
      await updateProfile(userId, { stripe_customer_id: session.customer });
    }
    return;
  }

  await updateProfile(userId, {
    stripe_customer_id: session.customer || null,
    stripe_subscription_id: session.subscription || null,
    subscription_status: "active"
  });
}

async function grantCredits(userId, credits, sessionId) {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) return;
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/grant_render_credits`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ p_user_id: userId, p_credits: credits, p_session_id: sessionId })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[stripe-webhook] grant_render_credits failed (${res.status}): ${body.slice(0, 200)}`);
  } else {
    console.info(`[stripe-webhook] granted ${credits} credits to ${userId} (session ${sessionId}).`);
  }
}

async function onSubscriptionChanged(subscription) {
  // Brokerage path — when subscription metadata names an org, update the
  // organization (not the individual user's profile). Members of the org
  // inherit the team plan via a Supabase RLS join (see migration 10).
  const orgId = subscription.metadata?.organization_id || "";
  if (orgId) {
    await updateOrganizationSubscription(orgId, subscription);
    return;
  }

  const userId = subscription.metadata?.user_id || (await findUserByCustomer(subscription.customer));
  if (!userId) return;
  const item = subscription.items?.data?.[0];
  const priceId = item?.price?.id;
  const productId = typeof item?.price?.product === "string" ? item.price.product : item?.price?.product?.id;
  const tier = TIER_FROM_PRICE(priceId, productId) || "trial";
  const patch = {
    stripe_subscription_id: subscription.id,
    subscription_status: subscription.status,
    tier,
    monthly_video_quota: QUOTA_FOR_TIER[tier],
    cancel_at_period_end: !!subscription.cancel_at_period_end,
    current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null
  };
  // Launch-audit fix: only reset monthly usage when the billing PERIOD
  // actually advanced. Stripe fires subscription.updated on cancel-at-
  // period-end toggles, plan switches, etc. — the old unconditional
  // `videos_used_this_month: 0` let any subscriber refill their quota by
  // toggling cancellation in the billing portal (and Stripe event replays
  // did the same silently). Renewals still reset: current_period_start
  // advances → mismatch → reset.
  const newCycleStart = subscription.current_period_start
    ? new Date(subscription.current_period_start * 1000).toISOString()
    : null;
  const existing = await fetchProfileColumns(userId, "billing_cycle_start");
  const storedCycleStart = existing?.billing_cycle_start || null;
  if (newCycleStart && newCycleStart !== storedCycleStart) {
    patch.billing_cycle_start = newCycleStart;
    patch.videos_used_this_month = 0;
  }
  await updateProfile(userId, patch);
}

// Minimal profile read for the period-change comparison above.
async function fetchProfileColumns(userId, columns) {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) return null;
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=${encodeURIComponent(columns)}&limit=1`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch {
    return null;
  }
}

// Brokerage subscriptions update the organizations row (introduced by
// migration 04_brokerages.sql). Per-seat quantity and cancellation state
// are tracked here so the brokerage-admin UI can show the seat count and
// renewal date without round-tripping to Stripe.
async function updateOrganizationSubscription(orgId, subscription) {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) return;
  const seats = Number(subscription.items?.data?.[0]?.quantity || 1);
  const patch = {
    stripe_subscription_id: subscription.id,
    stripe_customer_id: subscription.customer || null,
    subscription_status: subscription.status,
    seats,
    agent_seat_cap: seats,
    current_period_end: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null,
    cancel_at_period_end: !!subscription.cancel_at_period_end
  };
  try {
    await fetch(
      `${supabaseUrl}/rest/v1/organizations?id=eq.${encodeURIComponent(orgId)}`,
      {
        method: "PATCH",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify(patch)
      }
    );
  } catch (err) {
    console.warn("[stripe-webhook] org update threw:", err.message);
  }
}

async function onSubscriptionCanceled(subscription) {
  const userId = subscription.metadata?.user_id || (await findUserByCustomer(subscription.customer));
  if (!userId) return;
  await updateProfile(userId, {
    subscription_status: "canceled",
    tier: "trial",
    monthly_video_quota: 1
  });
}

async function onPaymentFailed(invoice) {
  if (!invoice.customer) return;
  const userId = await findUserByCustomer(invoice.customer);
  if (!userId) return;
  await updateProfile(userId, { subscription_status: "past_due" });

  // Notify the user. Without this, they'd discover the failed charge by
  // hitting Generate days later and getting "subscription past_due".
  // Fire-and-forget — webhook ack to Stripe must NOT block on email.
  notifyPaymentFailed(userId, invoice).catch((err) => {
    console.warn("[stripe-webhook] payment-failed notify threw:", err.message);
  });
}

async function notifyPaymentFailed(userId, invoice) {
  const { sendTransactionalEmail } = await import("./_lib/email.js");
  const { paymentFailed } = await import("./_lib/email-templates.js");
  // Look up the user's email + tier label.
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) return;
  const res = await fetch(
    `${supabaseUrl}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=email,tier`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  if (!res.ok) return;
  const rows = await res.json().catch(() => []);
  const profile = Array.isArray(rows) && rows.length ? rows[0] : null;
  if (!profile?.email) return;
  const planLabel = TIER_LABELS[profile.tier] || "your Vistalia subscription";
  const tpl = paymentFailed({ email: profile.email, planLabel });
  await sendTransactionalEmail({
    to: profile.email,
    subject: tpl.subject,
    html: tpl.html,
    tags: ["payment-failed"]
  });
}

const TIER_LABELS = {
  trial: "Free Trial",
  launch: "Vistalia Launch",
  pro: "Vistalia Pro",
  studio: "Vistalia Studio",
  // Legacy (retired from sale June 2026)
  quick_reel: "Quick Reel",
  cinematic_ai: "Cinematic AI",
  cinematic_4k: "Cinematic AI 4K"
};

/* -------------------- Stripe signature verification -------------------- */

// v26: replay-attack tolerance. Stripe signs `${timestamp}.${body}`; without
// checking the timestamp, a captured webhook payload verifies forever.
// Stripe's own SDK default is 300s — match it.
const SIGNATURE_TOLERANCE_SEC = 300;

// v26: in-memory event-ID dedupe (see handler). Bounded FIFO.
const seenEvents = new Set();
const SEEN_EVENTS_MAX = 1000;
function rememberEvent(id) {
  seenEvents.add(id);
  if (seenEvents.size > SEEN_EVENTS_MAX) {
    const oldest = seenEvents.values().next().value;
    seenEvents.delete(oldest);
  }
}

function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const parts = String(signatureHeader).split(",").reduce((acc, part) => {
    const [k, v] = part.split("=");
    if (k && v) acc[k] = v;
    return acc;
  }, {});
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;
  const ageSec = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSec) || ageSec > SIGNATURE_TOLERANCE_SEC) {
    console.warn("[stripe-webhook] signature timestamp outside tolerance", { ageSec: Math.round(ageSec) });
    return false;
  }
  const payload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  // Constant-time compare
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* -------------------- Supabase admin -------------------- */

async function findUserByCustomer(customerId) {
  if (!customerId) return null;
  const res = await supabaseAdmin(`profiles?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=user_id`, "GET");
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows[0] ? rows[0].user_id : null;
}

async function updateProfile(userId, patch) {
  await supabaseAdmin(`profiles?user_id=eq.${encodeURIComponent(userId)}`, "PATCH", patch);
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
      Prefer: "return=minimal"
    }
  };
  if (body && method !== "GET") init.body = JSON.stringify(body);
  return fetch(`${supabaseUrl}/rest/v1/${pathAndQuery}`, init);
}
