# World Monitor — Stripe Checkout backend

Small Node/Express service that creates **Stripe Checkout Sessions** for the
weekly / monthly / yearly subscriptions and handles Stripe **webhooks**.

The quiz funnel calls `POST /api/create-checkout-session` with `{ plan, email }`,
gets back a `{ url }`, and redirects the visitor to Stripe's hosted checkout.

## 1. Create the products in Stripe

Stripe Dashboard → **Products** → add a product "World Monitor Pro" with **three recurring prices**:

| Plan    | Interval        | Example price |
|---------|-----------------|---------------|
| weekly  | every 1 week    | $2.99         |
| monthly | every 1 month   | $7.99         |
| yearly  | every 1 year    | $49.99        |

Copy each **Price ID** (`price_…`).

## 2. Configure

```bash
cp .env.example .env
# then fill in:
#   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
#   STRIPE_PRICE_WEEKLY / _MONTHLY / _YEARLY
#   SUCCESS_URL, CANCEL_URL, ALLOWED_ORIGINS
```

## 3. Run locally

```bash
npm install
npm start          # → http://localhost:3000
```

Test the webhook locally with the Stripe CLI:

```bash
stripe listen --forward-to localhost:3000/api/webhook
# copy the whsec_... it prints into STRIPE_WEBHOOK_SECRET
stripe trigger checkout.session.completed
```

## 4. Point the quiz at it

In the quiz (`wm-quiz.html`) set:

```js
var CHECKOUT_MODE = "backend";                 // was "payment_link"
var BACKEND_URL   = "https://api.worldmonitor.app";   // where this service is deployed
```

On the confirm screen, **Continue to secure checkout** will now `POST` to
`BACKEND_URL/api/create-checkout-session` and redirect to the returned Stripe URL.
(If the request fails it falls back to the Payment Link in `STRIPE`.)

> Note: the hosted **artifact preview cannot call an external backend** (its sandbox
> blocks cross-origin requests), so keep `CHECKOUT_MODE = "payment_link"` there and
> flip it to `"backend"` on your own deployed site.

## 5. Deploy

Any Node host works (Render, Railway, Fly.io, a VPS). Example (Render):

- New **Web Service** → this folder
- Build: `npm install` · Start: `npm start`
- Add the `.env` values as environment variables
- Set `ALLOWED_ORIGINS` to your site origin(s)
- Add a **webhook endpoint** in Stripe → `https://<your-service>/api/webhook`
  listening for `checkout.session.completed`, `invoice.paid`,
  `invoice.payment_failed`, `customer.subscription.deleted`, and paste its
  signing secret into `STRIPE_WEBHOOK_SECRET`.

### Vercel (serverless) alternative

Prefer functions? Create `api/create-checkout-session.js`:

```js
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const PRICES = { weekly:process.env.STRIPE_PRICE_WEEKLY, monthly:process.env.STRIPE_PRICE_MONTHLY, yearly:process.env.STRIPE_PRICE_YEARLY };
export default async function handler(req, res){
  if(req.method!=='POST') return res.status(405).end();
  const { plan, email } = req.body || {};
  const price = PRICES[plan];
  if(!price) return res.status(400).json({error:'unknown_plan'});
  const session = await stripe.checkout.sessions.create({
    mode:'subscription', line_items:[{price, quantity:1}],
    customer_email: email || undefined, allow_promotion_codes:true,
    success_url: `${process.env.SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: process.env.CANCEL_URL, metadata:{ plan },
  });
  res.json({ url: session.url });
}
```

(The webhook needs the raw body — on Vercel disable the body parser for that route
with `export const config = { api: { bodyParser: false } }` and read the stream.)

## Security

- The **secret key lives only on the server** (env var) — never in the front-end.
- Card entry happens entirely on **Stripe's** hosted page.
- Always **verify the webhook signature** (this service does) before granting access.
