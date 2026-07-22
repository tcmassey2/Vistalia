// Branded HTML for transactional emails (trial-ending, payment-failed,
// render-complete). Same visual language as the Supabase auth templates
// in supabase/email-templates/ so the entire Vistalia email
// experience feels consistent.
//
// Each template returns { subject, html }. The html is a self-contained
// table-layout email that survives Gmail/Outlook/Apple Mail rendering.

const APP_URL = process.env.APP_URL || "https://vistalia.ai";

function shell({ eyebrow, headline, body, ctaLabel, ctaUrl, footer }) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0E0E10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#E8E2D6;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0E0E10;padding:40px 20px;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#15151A;border:1px solid #2A2A30;border-radius:16px;overflow:hidden;">
      <tr><td style="padding:32px 40px 24px 40px;border-bottom:1px solid #1F1F25;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding-right:10px;">
              <div style="display:inline-block;width:32px;height:32px;border-radius:8px;background:#0B0B0D;border:1.5px solid #C7A76C;text-align:center;line-height:29px;font-weight:600;color:#E6CE8E;font-size:18px;font-family:Georgia,serif;">V</div>
            </td>
            <td style="font-size:16px;font-weight:600;letter-spacing:-0.01em;color:#E8E2D6;">Vistalia</td>
          </tr>
        </table>
      </td></tr>
      <tr><td style="padding:36px 40px 8px 40px;">
        <p style="margin:0 0 8px 0;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#C7A76C;font-family:'JetBrains Mono','Menlo',monospace;">${escape(eyebrow)}</p>
        <h1 style="margin:0 0 18px 0;font-size:26px;line-height:1.2;letter-spacing:-0.025em;font-weight:600;color:#F5F0E2;">${escape(headline)}</h1>
        <div style="margin:0 0 24px 0;font-size:15px;line-height:1.55;color:#B5AC9A;">${body}</div>
      </td></tr>
      ${ctaUrl ? `<tr><td style="padding:0 40px 32px 40px;" align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr><td bgcolor="#C7A76C" style="border-radius:10px;">
            <a href="${escape(ctaUrl)}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#0E0E10;text-decoration:none;letter-spacing:-0.005em;">${escape(ctaLabel || "Open Vistalia")}</a>
          </td></tr>
        </table>
      </td></tr>` : ""}
      ${footer ? `<tr><td style="padding:0 40px 28px 40px;border-top:1px solid #1F1F25;padding-top:20px;">
        <p style="margin:0;font-size:12px;color:#7A7164;line-height:1.6;">${footer}</p>
      </td></tr>` : ""}
    </table>
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin-top:20px;">
      <tr><td style="padding:0 40px;font-size:11px;color:#5B5448;line-height:1.6;text-align:center;">
        Vistalia · The listing video that speaks.<br>
        <a href="${APP_URL}/app/" style="color:#7A7164;text-decoration:underline;">Sign in</a>
        &nbsp;·&nbsp;
        <a href="${APP_URL}/help" style="color:#7A7164;text-decoration:underline;">Help</a>
        &nbsp;·&nbsp;
        <a href="${APP_URL}/legal/privacy.html" style="color:#7A7164;text-decoration:underline;">Privacy</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function escape(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ============================================================
   Free-video ladder (v54.1) — replaces the retired trial-expiry
   ladder. HARD RULES for these two templates, learned the hard way
   (Fox & Roach complaint, Jul 2026): never claim a deadline, an
   expiry, or a feature lockout that the product does not enforce.
   Nothing expires under q6 pricing; these emails say so out loud —
   the anti-deadline IS the trust pitch. Two touches, then silence.
   Every send carries a one-click opt-out.
   ============================================================ */
export function freeVideoWaiting({ email, magicLink, optOutUrl }) {
  return {
    subject: "Your free listing video is still waiting",
    html: shell({
      eyebrow: "First video free",
      headline: "Your free video is still here.",
      body: `Hi there,<p>You grabbed a Vistalia account a few days ago — your first listing video is still free, and still waiting.</p><p>Upload the listing photos you already have and a narrated, MLS-safe video comes back in about ten minutes, ready for Reels, TikTok, and the listing page.</p><p style="margin-top:14px;color:#C9C0AE;">No deadline, no card, nothing that renews — the free video simply stays on your account until you use it.</p>`,
      ctaLabel: "Make my free video",
      ctaUrl: magicLink || `${APP_URL}/app/`,
      footer: `Sent to ${escape(email)} because this account's free video hasn't been used. One more note comes if that stays true — or <a href="${escape(optOutUrl || "")}" style="color:#7A7164;text-decoration:underline;">stop these emails</a> with one click.`
    })
  };
}

export function freeVideoLastNote({ email, magicLink, optOutUrl }) {
  return {
    subject: "Last note from us",
    html: shell({
      eyebrow: "We'll leave you to it",
      headline: "This is our last email.",
      body: `Hi there,<p>We won't keep showing up in your inbox — this is the last one we'll send.</p><p>Your free listing video stays on your account with no expiry, whenever a listing needs it: twelve photos in, a narrated MLS-safe video out, about ten minutes.</p>`,
      ctaLabel: "Use my free video",
      ctaUrl: magicLink || `${APP_URL}/app/`,
      footer: `Sent to ${escape(email)}. No more emails after this one either way — or <a href="${escape(optOutUrl || "")}" style="color:#7A7164;text-decoration:underline;">opt out now</a> and we stop immediately.`
    })
  };
}

/* ============================================================
   Payment failed
   ============================================================ */
export function paymentFailed({ email, planLabel }) {
  return {
    subject: "Action needed: payment failed for Vistalia",
    html: shell({
      eyebrow: "Payment failed",
      headline: "We couldn't charge your card.",
      body: `Hi there,<p>Stripe couldn't process the renewal payment for your <strong style="color:#E8E2D6;">${escape(planLabel || "Vistalia")}</strong> subscription. Your account is in a grace period — renders are paused until the card is updated.</p><p style="margin-top:14px;">Common fixes: update an expired card, switch to a different card, or check that your bank isn't blocking the charge.</p>`,
      ctaLabel: "Update payment method",
      ctaUrl: `${APP_URL}/app/#settings`,
      footer: `Sent to ${escape(email)} because Stripe reported a payment failure. If this is wrong, reply and we'll dig in.`
    })
  };
}

/* ============================================================
   Render complete
   ============================================================ */
// v55: sent by the Stripe webhook the moment a $39 purchase lands.
// Non-legacy: the clean master already exists — the library now serves it.
// Legacy (pre-v55 render): honest re-render path, credit already granted.
export function cleanUnlocked({ email, title, legacy }) {
  const safeTitle = escape(title || "your listing");
  return {
    subject: legacy
      ? "Your credit is in — one step to your watermark-free video"
      : `Your watermark-free video is ready — ${safeTitle}`,
    html: shell({
      eyebrow: "Purchase confirmed",
      headline: legacy ? "Credit added — almost there." : "It's yours. Watermark gone.",
      body: legacy
        ? `<p>Thanks for your purchase — a video credit is in your account. Your existing video was rendered before our instant-unlock update, so it needs one quick re-render to come back watermark-free: open your library, hit <strong style="color:#E8E2D6;">Re-render</strong> on <strong style="color:#E8E2D6;">${safeTitle}</strong>, and it's yours in about ten minutes.</p><p style="margin-top:14px;">Your credit also covers your next listing whenever it's ready.</p>`
        : `<p>The watermark-free master of <strong style="color:#E8E2D6;">${safeTitle}</strong> is live in your library right now — same video, just yours. Download it and post it.</p><p style="margin-top:14px;">Your purchase also left a video credit in your account for your next listing. Sellers pick the agent with the better marketing — now you're that agent twice.</p>`,
      ctaLabel: legacy ? "Open my library" : "Download my video",
      ctaUrl: `${APP_URL}/app/`,
      footer: `Sent to ${escape(email)} because a Vistalia purchase just completed. Reply to this email and it reaches the founder directly.`
    })
  };
}

export function renderComplete({ email, listingTitle, mp4Url, thumbnailUrl, jobId, magicLink, certificateUrl }) {
  const safeTitle = escape(listingTitle || "Your listing video");
  // v51: the MLS-Safe Certificate line — forwardable proof that every scene
  // was verified against the source photos. Only rendered when a token
  // exists for this job.
  const certBlock = certificateUrl
    ? `<p style="margin-top:14px;">Need to show a broker, seller, or compliance desk that nothing was invented? <a href="${escape(certificateUrl)}" style="color:#C7A76C;">View the verification certificate</a> — every scene beside its source photo.</p>`
    : "";
  const previewBlock = thumbnailUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 24px auto;border-radius:10px;overflow:hidden;">
         <tr><td><a href="${escape(magicLink || mp4Url)}"><img src="${escape(thumbnailUrl)}" alt="" width="280" style="display:block;max-width:280px;height:auto;border:1px solid #2A2A30;border-radius:10px;"></a></td></tr>
       </table>`
    : "";
  return {
    subject: `Your video is ready — ${safeTitle}`,
    html: shell({
      eyebrow: "Render complete",
      headline: "Your video is ready.",
      body: `${previewBlock}<p>The render for <strong style="color:#E8E2D6;">${safeTitle}</strong> just finished. One tap below signs you in and opens your library — watch it and download every format you selected.</p>${certBlock}<p style="margin-top:14px;">Ready to post it? <strong style="color:#E8E2D6;">$39 makes this video watermark-free</strong> — just your name, headshot, and brand on it. Listing regularly? Pro is 5 videos a month for $69. Both are one tap from your library.</p><p style="margin-top:14px;">Post it and tag <strong style="color:#E8E2D6;">@vistalia.ai</strong> on Instagram — we feature our favorite listings.</p><p style="margin-top:14px;font-size:12px;color:#7A7164;">Job ID: <span style="font-family:'JetBrains Mono','Menlo',monospace;">${escape(jobId)}</span></p>`,
      ctaLabel: "Watch your video",
      // One-tap magic link (24h). Plain /app/ fallback if link generation
      // failed — signed-in devices sail through either way.
      ctaUrl: magicLink || `${APP_URL}/app/`,
      footer: `The button signs you in automatically and expires within a day — after that, open <a href="${APP_URL}/app/" style="color:#C7A76C;">vistalia.ai/app</a> and sign in as usual. Sent to ${escape(email)} because a render you started just finished.`
    })
  };
}

/* ============================================================
   Welcome (signup) — v46: email confirmation no longer gates signin,
   so Supabase sends nothing at signup. This is the first-touch email,
   sent by /api/welcome-email right after account creation.
   ============================================================ */
export function welcomeEmail({ email }) {
  return {
    subject: "Welcome to Vistalia — your first listing video is on us",
    html: shell({
      eyebrow: "Welcome",
      headline: "Your first video is on us.",
      body: `<p>You're in. Upload the listing photos you already have, pick a style, and Vistalia turns them into a cinematic vertical tour — AI camera motion, on-beat music, professional narration, every scene verified against your photos.</p><p style="margin-top:14px;">Your first video is free. No credit card.</p>`,
      ctaLabel: "Make your first video",
      ctaUrl: `${APP_URL}/app/`,
      footer: `Sent to ${escape(email)} because this address just created a Vistalia account. If that wasn't you, reply and we'll remove it.`
    })
  };
}

/* ============================================================
   Meta Instant Form lead — account provisioned, magic-link entry.
   The lead never saw our signup page: their account was created FOR
   them from the form submission, so this email IS the product's front
   door. The magic link signs them straight in; fallbacks are spelled
   out because Supabase action links expire.
   ============================================================ */
export function leadWelcomeEmail({ email, firstName, magicLink }) {
  const hi = firstName ? `${escape(firstName)}, your` : "Your";
  return {
    subject: "Your Vistalia studio is ready — first listing video free",
    html: shell({
      eyebrow: "Studio access",
      headline: `${hi} studio is ready.`,
      body: `<p>Thanks for raising your hand. We've set up your Vistalia account — one tap below signs you in, no password needed.</p><p style="margin-top:14px;">Best on a computer: drop in the listing photos you already have, pick a style, and your first cinematic, narrated tour renders free. Every scene is verified against your photos, so nothing is invented.</p>`,
      ctaLabel: "Open your studio",
      ctaUrl: magicLink || `${APP_URL}/app/`,
      footer: `The button signs you in automatically and expires after a short while — if it's stale, open <a href="${APP_URL}/app/" style="color:#C7A76C;">vistalia.ai/app</a> and continue with Google or Facebook using this same email, or use &ldquo;Forgot password&rdquo;. Sent to ${escape(email)} because this address was submitted on our Facebook/Instagram form. Not you? Reply and we'll remove it.`
    })
  };
}

/* ============================================================
   Lead nudge — ~20h after the welcome, only if they never rendered.
   One send, ever. Fresh magic link because the welcome's expired.
   ============================================================ */
export function leadNudgeEmail({ email, firstName, magicLink }) {
  const hi = firstName ? `${escape(firstName)} — your` : "Your";
  return {
    subject: "Your free listing video is still waiting",
    html: shell({
      eyebrow: "Still yours",
      headline: `${hi} first video is still free.`,
      body: `<p>Yesterday you asked about turning listing photos into video — your studio's been sitting ready since. Drop in the photos from any listing you already have and about ten minutes later you get a narrated, captioned, cinematic vertical tour. Every scene is checked against your photos, so nothing is invented.</p><p style="margin-top:14px;"><strong style="color:#E8E2D6;">Tip: open this on your computer.</strong> That's where your listing photos live — MLS downloads, your photographer's folder — and uploading them takes about a minute there.</p><p style="margin-top:14px;">No card, nothing to set up — the button below signs you in. <a href="${APP_URL}/examples" style="color:#C7A76C;">See a 30-second example first</a> if you'd rather look before you leap.</p>`,
      ctaLabel: "Open your studio",
      ctaUrl: magicLink || `${APP_URL}/app/`,
      footer: `The sign-in button expires after a short while — if it's stale, open <a href="${APP_URL}/app/" style="color:#C7A76C;">vistalia.ai/app</a> and continue with Google or Facebook using this same email. This is the only reminder we'll send. Sent to ${escape(email)} from your Facebook/Instagram request.`
    })
  };
}

/* ============================================================
   Post-first-render upsell — T+20h after a trial user's first render.
   The moment: they made one video, loved it (or at least kept it), and
   have a NEXT listing coming. Sell per-listing first ($39), graduate to
   Pro. One send, ever (app_metadata.upsell_sent).
   ============================================================ */
export function firstRenderUpsellEmail({ email, magicLink }) {
  return {
    subject: "Your next listing deserves the same video",
    html: shell({
      eyebrow: "Your studio",
      headline: "One listing down. What about the next one?",
      body: `<p>Your first Vistalia video is in your library — and your next listing deserves the same treatment. Drop in the photos and it's rendered, narrated, and captioned in about ten minutes.</p><p style="margin-top:14px;"><strong style="color:#E8E2D6;">$39 for a single video</strong>, or <strong style="color:#E8E2D6;">5 a month for $69</strong> — and paid videos carry no watermark, just your name, headshot, and brand.</p><p style="margin-top:14px;">Sellers pick the agent with the better marketing. Be the agent with film.</p>`,
      ctaLabel: "Make your next video",
      ctaUrl: magicLink || `${APP_URL}/app/`,
      footer: `The button signs you in automatically and expires within a day — after that, open <a href="${APP_URL}/app/" style="color:#C7A76C;">vistalia.ai/app</a> as usual. Sent to ${escape(email)} because your first render finished yesterday. We won't send this twice.`
    })
  };
}

/* ============================================================
   Desktop handoff — user tapped "email me a link for my computer"
   on their phone. Fresh magic link so the desktop session is one
   click; requested by the signed-in user themselves seconds ago.
   ============================================================ */
export function desktopLinkEmail({ email, magicLink }) {
  return {
    subject: "Your Vistalia sign-in link — open on your computer",
    html: shell({
      eyebrow: "Desktop handoff",
      headline: "Pick up where you left off — at your desk.",
      body: `<p>You asked for a link to continue on your computer. One click below signs you in — no password.</p><p style="margin-top:14px;">Have your listing photos ready (MLS downloads or your photographer's folder), drop them in, and your first cinematic tour renders free.</p>`,
      ctaLabel: "Open my studio",
      ctaUrl: magicLink || `${APP_URL}/app/`,
      footer: `You requested this link from inside Vistalia moments ago. It signs you in automatically and expires within a day. Sent to ${escape(email)}.`
    })
  };
}

// Contact-form notification to support@ — same shell as everything else,
// so the support inbox looks like the brand from day one.
export function contactNotification({ name, email, subject, message }) {
  const safeMsg = escape(message).replace(/\n/g, "<br>");
  const html = shell({
    eyebrow: "Contact form",
    headline: subject || "New message",
    body:
      `<p style="margin:0 0 14px 0;"><strong style="color:#E8E2D6;">${escape(name || "Someone")}</strong> ` +
      `&lt;<a href="mailto:${escape(email)}" style="color:#C7A76C;text-decoration:none;">${escape(email)}</a>&gt; wrote:</p>` +
      `<div style="padding:16px 18px;background:#101014;border:1px solid #26262C;border-radius:10px;color:#C2C2BC;line-height:1.6;">${safeMsg}</div>`,
    ctaLabel: "Reply",
    ctaUrl: `mailto:${email}`,
    footer: "Sent from the vistalia.ai contact form. Reply-to is set to the sender."
  });
  return { subject: `[Contact] ${subject || "New message"}`, html };
}
