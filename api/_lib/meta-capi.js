// Vistalia — Meta Conversions API (server-side events).
//
// v62.85: the URL-to-listing funnel lives in Meta INSTANT FORMS + our own
// backend — the browser pixel never sees it. The last campaign ran with no
// proper measurement at all. These server events give Ads Manager the real
// funnel: Lead when a form lead lands in meta_leads, RenderDelivered when
// the finished video email goes out. Purchase stays client-side (pixel.ts
// fires it on the Stripe return in the app); adding a server Purchase
// without a shared event_id would double-count — upgrade path is passing
// the Stripe session id through success_url, then dedupe on it.
//
// Fail-open by design: no META_CAPI_ACCESS_TOKEN env → every call is a
// silent no-op; any network/API error logs one warn and never blocks the
// funnel. Match keys: SHA-256 email (Meta requirement) + lead_id when the
// event came from a lead form. event_id makes clock-driven sync retries
// idempotent (Meta dedupes on event_name + event_id).
//
// PRIVACY: never send the listing URL or address to Meta — custom_data
// carries booleans and ids only. The no-address rule applies to ad
// platforms the same as to public assets.

import crypto from "node:crypto";

const GRAPH_VERSION = "v21.0";
const DEFAULT_DATASET_ID = "984226387946970"; // same dataset as the browser pixel

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

/**
 * Send one server event to the Meta dataset. Resolves to
 * { sent: boolean, reason?: string } and NEVER throws.
 *
 * @param {object} p
 * @param {string} p.eventName  e.g. "Lead", "RenderDelivered"
 * @param {string} p.email      plaintext; hashed here before sending
 * @param {string} [p.eventId]  idempotency key (lead id, job id)
 * @param {string} [p.leadId]   Meta leadgen id — best match key for form leads
 * @param {object} [p.customData]  small, non-PII payload (booleans/ids only)
 */
export async function sendMetaCapiEvent({ eventName, email, eventId, leadId, customData }) {
  // v62.86: fall back to META_PAGE_ACCESS_TOKEN — Troy: that token was
  // "originally pulled for pixel info", so it likely carries events
  // permission already. Explicit META_CAPI_ACCESS_TOKEN always wins. If the
  // page token turns out not to have dataset access, the first lead logs
  // "[capi] Lead rejected: 401/403 …" in Vercel — then generate the
  // dedicated token in Events Manager and set META_CAPI_ACCESS_TOKEN.
  const token = (
    process.env.META_CAPI_ACCESS_TOKEN ||
    process.env.META_PAGE_ACCESS_TOKEN ||
    ""
  ).trim();
  if (!token) return { sent: false, reason: "no_token" };
  const datasetId = (process.env.META_DATASET_ID || DEFAULT_DATASET_ID).trim();
  const cleanEmail = String(email || "").toLowerCase().trim();
  if (!eventName || !cleanEmail.includes("@")) return { sent: false, reason: "bad_input" };

  const userData = { em: [sha256(cleanEmail)] };
  if (leadId) userData.lead_id = String(leadId);

  const event = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    // Lead-form + CRM-milestone events; there is no website session to claim.
    action_source: "system_generated",
    user_data: userData
  };
  if (eventId) event.event_id = String(eventId);
  if (customData && Object.keys(customData).length) event.custom_data = customData;

  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(datasetId)}/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: [event], access_token: token }),
        signal: AbortSignal.timeout(4000)
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[capi] ${eventName} rejected: ${res.status} ${body.slice(0, 160)}`);
      return { sent: false, reason: `http_${res.status}` };
    }
    console.info(`[capi] ${eventName} sent (event_id=${eventId || "none"}).`);
    return { sent: true };
  } catch (err) {
    console.warn(`[capi] ${eventName} failed open: ${err?.message || err}`);
    return { sent: false, reason: "network" };
  }
}
