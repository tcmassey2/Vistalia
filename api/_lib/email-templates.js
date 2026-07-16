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
   Trial — 3 days remaining
   ============================================================ */
export function trialEndingThreeDays({ email }) {
  return {
    subject: "Your Vistalia trial ends in 3 days",
    html: shell({
      eyebrow: "Trial reminder",
      headline: "Three days left in your trial.",
      body: `Hi there,<p>Your Vistalia free trial wraps up in <strong style="color:#E8E2D6;">three days</strong>. Pick a plan now and your work — brand kit, library, scene-by-scene fixes — keeps right on going without an interruption.</p>`,
      ctaLabel: "Pick a plan",
      ctaUrl: `${APP_URL}/app/#settings`,
      footer: `Sent to ${escape(email)} because your trial is winding down. You can cancel auto-emails by deleting your account at any time.`
    })
  };
}

/* ============================================================
   Trial — 1 day remaining (more urgent tone)
   ============================================================ */
export function trialEndingOneDay({ email }) {
  return {
    subject: "Last day of your Vistalia trial",
    html: shell({
      eyebrow: "Final day",
      headline: "Last day to lock in your plan.",
      body: `Hi there,<p>Your Vistalia free trial ends <strong style="color:#E8E2D6;">tomorrow</strong>. After that, the Generate button stops responding until you pick a plan.</p><p style="margin-top:14px;">It takes 30 seconds and the videos you've already rendered stay in your library either way.</p>`,
      ctaLabel: "Choose a plan",
      ctaUrl: `${APP_URL}/app/#settings`,
      footer: `Sent to ${escape(email)} because your trial expires within 24 hours.`
    })
  };
}

/* ============================================================
   Trial — expired
   ============================================================ */
export function trialExpired({ email }) {
  return {
    subject: "Your Vistalia trial has ended",
    html: shell({
      eyebrow: "Trial ended",
      headline: "Pick a plan when you're ready.",
      body: `Hi there,<p>Your seven-day free trial has wrapped. Your library, brand kit, and rendered videos are safe in your account — pick a plan whenever you're ready and you can keep going from exactly where you left off.</p>`,
      ctaLabel: "View plans",
      ctaUrl: `${APP_URL}/app/#settings`,
      footer: `Sent to ${escape(email)} on the day your trial ended. We won't keep emailing — but if you ever want a recap of what's new, just sign back in.`
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
export function renderComplete({ email, listingTitle, mp4Url, thumbnailUrl, jobId, magicLink }) {
  const safeTitle = escape(listingTitle || "Your listing video");
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
      body: `${previewBlock}<p>The render for <strong style="color:#E8E2D6;">${safeTitle}</strong> just finished. One tap below signs you in and opens your library — watch it and download every format you selected.</p><p style="margin-top:14px;font-size:12px;color:#7A7164;">Job ID: <span style="font-family:'JetBrains Mono','Menlo',monospace;">${escape(jobId)}</span></p>`,
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
