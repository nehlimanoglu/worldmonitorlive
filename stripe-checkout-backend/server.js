// World Monitor — Stripe Checkout Session backend
// Creates subscription Checkout Sessions for weekly / monthly / yearly plans,
// and handles Stripe webhooks to provision/revoke access.
//
// Setup: copy .env.example -> .env, fill in your keys, then `npm install && npm start`.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_WEEKLY,
  STRIPE_PRICE_MONTHLY,
  STRIPE_PRICE_YEARLY,
  SUCCESS_URL = 'http://localhost:3000/success.html',
  CANCEL_URL = 'http://localhost:3000/cancel.html',
  ALLOWED_ORIGINS = '*',
  PORT = 3000,
} = process.env;

if (!STRIPE_SECRET_KEY) {
  console.error('✗ Missing STRIPE_SECRET_KEY — copy .env.example to .env and fill it in.');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY);

// plan -> recurring Price ID (create these in Stripe: one recurring price per interval)
const PRICES = {
  weekly: STRIPE_PRICE_WEEKLY,
  monthly: STRIPE_PRICE_MONTHLY,
  yearly: STRIPE_PRICE_YEARLY,
};

const app = express();

const origins = ALLOWED_ORIGINS.split(',').map((s) => s.trim());
app.use(
  cors({
    origin: origins.includes('*') ? true : origins,
    methods: ['GET', 'POST'],
  })
);

// --- Stripe webhook (MUST be before express.json, needs the raw body) ---
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('✗ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object;
      // TODO: provision access for the customer in your database.
      console.log('✅ paid:', s.customer_email, '· plan:', s.metadata?.plan, '· sub:', s.subscription);
      break;
    }
    case 'invoice.paid': {
      // recurring renewal succeeded — keep access on
      break;
    }
    case 'customer.subscription.deleted':
    case 'invoice.payment_failed': {
      const obj = event.data.object;
      // TODO: revoke / pause access.
      console.log('⚠️  access should end for customer:', obj.customer);
      break;
    }
    default:
      break;
  }
  res.json({ received: true });
});

// JSON parser for the rest
app.use(express.json());

// static success/cancel pages (optional)
app.use(express.static('public'));

app.get('/health', (_req, res) => res.json({ ok: true }));

// --- Create a Checkout Session for the chosen plan ---
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { plan, email } = req.body || {};
    const price = PRICES[plan];
    if (!price) return res.status(400).json({ error: 'unknown_plan' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      customer_email: email || undefined,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      success_url: `${SUCCESS_URL}${SUCCESS_URL.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: CANCEL_URL,
      metadata: { plan },
      subscription_data: { metadata: { plan } },
    });

    return res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('✗ create-checkout-session failed:', err.message);
    return res.status(500).json({ error: 'checkout_failed' });
  }
});

app.listen(PORT, () => {
  console.log(`World Monitor Stripe backend on :${PORT}`);
  console.log('Plans configured:', Object.entries(PRICES).filter(([, v]) => v).map(([k]) => k).join(', ') || '(none — set price IDs in .env)');
});
