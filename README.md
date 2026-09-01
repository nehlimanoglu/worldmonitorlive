# World Monitor — worldmonitorlive.app

Static site lives at the **repo root** (so Vercel needs no Root Directory setting).

```
index.html                 landing (hero globe, live-map preview, pricing → quiz)
map.html                   live map (Map/Globe) — reads Supabase Realtime
quiz.html                  onboarding funnel → Stripe
config.js                  Supabase url + anon (public)

supabase/functions/ingest/ Edge Function: USGS/GDELT/HN/crypto/Finnhub → events
supabase-schema.sql        events table + RLS + Realtime (run once)
supabase-cron.sql          pg_cron schedule for the ingest function
news-backend/              (optional) standalone Node ingester — replaced by the Edge Function
stripe-checkout-backend/   Stripe Checkout Session backend for the quiz
SUPABASE-SETUP.md          full setup guide
```

## Vercel
Connect this repo → **Framework: Other**, **Root Directory: empty (repo root)**,
no build/output/install commands. It serves the static files as-is.
Push to `main` → auto-deploy.
