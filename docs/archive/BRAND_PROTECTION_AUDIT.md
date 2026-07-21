# EstateMotion — Brand Protection Audit

June 18, 2026. Scope: all levels — legal/trademark, domains & handles, email/site
security, reputation/search. Approach: audit first, nothing purchased without Troy's
approval. Primary domain is **estatemotion.ai** (confirmed).

Findings are ordered by severity. **Read item #1 first — it affects whether the rest is
even worth doing under the current name.**

---

## 🔴 CRITICAL #1 — There is already an "Estate Motion" in your exact industry

**Finding.** `estatemotion.com` is not a parked domain or a squatter. It's an active,
established business: **Estate Motion LLC**, 819 Dwyer Ave, Arlington Heights, IL
(Chicagoland). They do **real estate photography, videography, drone, 3D tours, and
virtual staging** — the same listing-content space you're in. Evidence:

- Site live now, content dating back to 2018 (logo file stamped 2018-09), posts through late 2024, listed as "Updated March 2026" on Yelp — i.e., still operating.
- Registered entity "Estate Motion LLC"; profiles on Yelp, Alignable, ZoomInfo.
- Owns the handles too: Instagram **@estate.motion**, Facebook **/estateinmotion**, **vimeo.com/estatemotion**, a YouTube channel, and a client portal at **cloud.estatemotion.com**.
- Separate mail system (MX `mail.5gaps.com`), their own SPF — a real operation, not a shell.

**Why this matters.** In U.S. trademark law the spacing doesn't save you: *"Estate
Motion"* and *"EstateMotion"* are treated as essentially the same mark (same sound, same
meaning, same appearance), and you're both selling **real estate listing videos**. That's
a textbook "likelihood of confusion." And they are the **senior user** — using the name in
commerce since ~2018, years before EstateMotion LLC was formed. You are the **junior
user**. This flips the usual script: the brand you're trying to protect may, in the eyes
of trademark law, substantially belong to someone else in your field.

**Concrete risks, pre-launch:**
- You likely **cannot get a clean federal trademark** on "EstateMotion" for real estate
  video services — an examiner could refuse it, or the senior user could oppose.
- The senior user could send a **cease-and-desist** once you have visibility (e.g., once
  ads are running and you're ranking for "estate motion"). The more you spend building the
  brand, the more painful a forced change becomes.
- You can't stop *them* from using it either — they were there first.
- **Search collision (marketing cost):** Google "estate motion" today and the Chicago
  company owns the results (their site, Yelp, Alignable, ZoomInfo). Your brand will be
  fighting an incumbent for its *own name* — a real drag on the brand-SEO plan.

**What I did and didn't confirm.** A public search turned up **no federal trademark
registration** for either party — meaning the Chicago firm likely holds *common-law*
rights, not a registered mark. Common-law rights are narrower (often geographic) but are
still real and still senior. I am **not a lawyer**, and this is the one item in this audit
where you should not act on my read alone.

**Recommendation (the high-value move while you're still pre-launch):**
1. **Spend ~$300–600 on a trademark attorney clearance search + opinion** before you put
   another dollar into the EstateMotion brand. This is the cheapest it will ever be to find
   out where you stand. Pre-launch, with no ad spend sunk and no equity built, your options
   are wide open; post-launch they narrow fast.
2. Based on that opinion, you'll choose among: (a) **proceed** if counsel thinks the risk
   is low (e.g., they're purely local common-law and you can federally register first in a
   way that coexists), (b) **differentiate** — keep "EstateMotion" but anchor the brand to a
   distinctive, registrable wordmark/logo + tagline that's clearly yours, or (c) **rebrand**
   now, while it costs a domain and a logo instead of a launched business.
3. I can prep everything to make that consult fast and cheap: a one-page conflict brief
   (their evidence, dates, services), your use dates, and the classes you'd file in — so
   you're not paying an attorney to do discovery I can do for free.

**Cost:** clearance search + attorney opinion ≈ **$300–600**. Federal application later
(if cleared) ≈ **$350/class** USPTO fee + attorney filing (~$500–1,000) — *don't spend
this until the clearance comes back clean.*

---

## 🔴 HIGH #2 — Anyone can send email *as you* right now (free fix)

**Finding.** `estatemotion.ai` has Google Workspace DKIM configured (good), but is
**missing both SPF and DMARC**:
- Root TXT contains only a `google-site-verification` string — **no `v=spf1` SPF record.**
- `_dmarc.estatemotion.ai` — **no record at all.**

**Risk.** Without SPF + DMARC, a scammer can spoof `you@estatemotion.ai` and email your
agents, leads, or Stripe/vendors as you — phishing under your brand, with nothing to
reject it. It also **hurts deliverability**: Google and Yahoo now require SPF+DKIM+DMARC
for senders, so your launch emails to agents are more likely to land in spam. This is the
highest-value free fix in the audit, and it matters *this week* because you're about to
start emailing agents.

**Fix (two DNS TXT records at your registrar/Cloudflare — I'll give exact values):**
- **SPF:** `v=spf1 include:_spf.google.com ~all`
- **DMARC** (start in monitor mode): `_dmarc` TXT → `v=DMARC1; p=none; rua=mailto:dmarc@estatemotion.ai; fo=1`
  Then tighten to `p=quarantine` and later `p=reject` once you've confirmed legit mail passes.

**Cost:** $0. **Who acts:** you add 2 DNS records (5 minutes); I'll hand you the exact
records and where to paste them.

---

## 🟡 MEDIUM #3 — Domains & social handles

**Finding.**
- `estatemotion.ai` — yours ✓ (Google Workspace, Cloudflare-adjacent hosting, CAA records present).
- `estatemotion.com` — **the Chicago company's** (see #1). Effectively unobtainable.
- **Open / unregistered:** `estatemotion.co`, `.io`, `.net`, `.app`, plus misspellings
  like `estate-motion.com`, `estatemotionapp.com`.
- **Social handles:** the clean ones (`@estate.motion`, `/estateinmotion`,
  `vimeo.com/estatemotion`, the YT channel) are **taken by the Chicago firm.** You'll need
  a distinct, *consistent* handle across platforms.

**Risk / nuance.** Normally I'd say "buy the defensive TLDs." Here it's secondary to #1 —
and registering names confusingly similar to a senior user isn't a real shield anyway. The
**handle consistency** problem is the practical one: you need one handle you can get
everywhere (IG/TikTok/X/YT/FB/LinkedIn) before a squatter takes it, and it has to read as
*you*, not them (e.g., `@estatemotion.ai` / `@getestatemotion` / `@estatemotionhq` — TBD
once #1 resolves).

**Recommendation.** **Hold non-essential domain/handle spend until the trademark question
in #1 is answered** — if the brand shifts, you don't want to have bought handles twice.
The one thing worth doing immediately regardless: **reserve a single consistent handle**
on the big platforms so it's not sniped. Cheap insurance, reversible.

**Cost:** handles = $0 (just claim them). Defensive TLDs ≈ $10–40/yr each (.ai ≈ $70–100/yr)
— *deferred pending #1.*

---

## 🟢 GOOD — already in decent shape

- **CAA records** lock TLS-cert issuance to Sectigo / Google / Let's Encrypt — blocks rogue certs. Nice; most small sites don't have this.
- **DKIM** is properly configured on Google Workspace.
- **google-site-verification** present → Search Console is (or can easily be) set up, which you'll want for the SEO pages anyway.
- Primary domain `.ai` is yours and behind a sane hosting/DNS setup.

---

## Reputation & search (folds into #1)

There's no separate review-profile crisis — the issue is that your brand name's search
results are **owned by the Chicago Estate Motion**. Standing up a Google Business Profile,
a Trustpilot you control, and brand monitoring (a free Google Alert for "EstateMotion" +
"estate motion") is worth doing — but *which* name you're defending depends entirely on
#1. Setting up monitoring now is free and smart either way; I'd do that today so you hear
the moment anyone (the Chicago firm, Reel-E, a squatter) references the name.

---

## Recommended order of operations

1. **Today, free, no dependencies:** add SPF + DMARC (#2); set a Google Alert for the
   brand name; reserve one consistent social handle.
2. **This week, ~$300–600:** trademark attorney clearance + opinion (#1). I'll prep the
   conflict brief so the consult is fast.
3. **After the opinion:** decide proceed / differentiate / rebrand — *then* spend on
   defensive domains, handles, and the federal filing. Not before.

**Bottom line:** the real threat to your brand isn't Ori or a squatter — it's that an
established company in your own industry has been "Estate Motion" since 2018. That's very
fixable, and finding it *now*, pre-launch, before ad spend and brand equity, is the best
possible time. Everything else here is cheap or free once that question is settled.

---

### Sources
- [estatemotion.com — Estate Motion (Chicago real estate photography/video)](https://estatemotion.com/)
- [Estate Motion — Yelp (Arlington Heights, IL)](https://www.yelp.com/biz/estate-motion-arlington-heights)
- [Estate Motion — Alignable](https://www.alignable.com/arlington-heights-il/estate-motion)
- [Estate Motion LLC — ZoomInfo](https://www.zoominfo.com/c/estate-motion-llc/481367660)
- [USPTO Trademark Search](https://tmsearch.uspto.gov/) · [USPTO TSDR](https://tsdr.uspto.gov/)
- DNS findings (SPF/DMARC/MX/CAA) collected directly via `dig` against estatemotion.ai, June 18 2026.
