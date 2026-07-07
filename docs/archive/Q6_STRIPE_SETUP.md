# q6 Pricing — Stripe Setup (your 15-minute checklist)

The code, migration, pricing page, and ToS are done. The only thing I can't do
is touch Stripe — so here's exactly what to create there and where the IDs go.
The app resolves each tier by its **Stripe product** and pulls the **price** from
that product's `default_price`, so once these exist, prices flow through with no
code change.

## 1. Create / update products in Stripe (Dashboard → Products)

You already have `pro` and `studio` products (the webhook maps them by product ID).
**Reuse them — just re-price.** Confirm the product IDs match what's in
`api/stripe-webhook.js` (`PRODUCT_TIERS`), or set the env vars in step 3.

| Product | Monthly price | Annual price (2 months free) | One-time |
|---|---|---|---|
| **Pro** | $49.00 / month (recurring) | $490.00 / year (recurring) | — |
| **Studio** | $99.00 / month (recurring) | $990.00 / year (recurring) | — |
| **Single video** | — | — | $39.00 (one-time) |

- Set the **monthly price as each product's default price** (Pro → $49/mo, Studio → $99/mo).
- Add the **annual price** as a second price on the same product.
- For the one-off, create a **one-time** price of $39 (or reuse your existing single-video product and change it to $39).
- Retire the old $99/$249/$499 prices from sale (archive them — existing subs, if any, keep working).

## 2. Stripe → make sure these are on
- **Customer portal** enabled (Settings → Billing → Customer portal) so "Manage subscription" works.
- **Webhook** pointed at `https://vistalia.ai/api/stripe-webhook` for events: `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.payment_failed`.

## 3. Set these env vars in Vercel (Project → Settings → Environment Variables)

Only set the ones that differ from the defaults already in the code.

```
STRIPE_PRODUCT_PRO       = prod_…   (your Pro product id)
STRIPE_PRODUCT_STUDIO    = prod_…   (your Studio product id)
STRIPE_PRICE_ONE_OFF     = price_…  (the $39 one-time price)   ← if your one-off flow uses an env price
STRIPE_WEBHOOK_SECRET    = whsec_…  (from the webhook you created in step 2)
STRIPE_SECRET_KEY        = sk_live_… (live key for launch)
```

Set them for **Production, Preview, and Development** so previews work too.

## 4. After it's set
- Run migration `supabase/migrations/22_q6_pricing_tiers.sql` in the Supabase SQL editor.
- Do one real test checkout on Pro (use a Stripe test card first, then a $1 live test if you want), confirm your profile flips to `tier=pro`, `monthly_video_quota=5`, `subscription_status=active`, and that a render goes through.
- Confirm "Manage subscription" opens the Stripe customer portal.

That's it — once the products/prices exist and the env vars are set, the live
pricing page, checkout, quotas, and webhook all line up with q6.
