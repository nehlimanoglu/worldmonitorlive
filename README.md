# World Monitor (worldmonitorlive.app)

Monorepo. Everything for the live product in one place.

```
site/                     Static site → deploy on Vercel (set Root Directory = "site")
  index.html                landing (hero globe, live-map preview, pricing → quiz)
  map.html                  live map (Map/Globe) — reads Supabase Realtime
  quiz.html                 onboarding funnel → Stripe
  config.js                 Supabase url + anon (public)
supabase/functions/ingest/  Edge Function that ingests USGS/GDELT/HN/crypto/Finnhub
supabase-schema.sql         events table + RLS + Realtime  (run once in SQL editor)
supabase-cron.sql           pg_cron schedule for the ingest function
news-backend/               (optional) standalone Node ingester — replaced by the Edge Function
stripe-checkout-backend/    Stripe Checkout Session backend for the quiz
SUPABASE-SETUP.md           full setup guide
```

## Deploy the site (Vercel)
Import this repo in Vercel → **Root Directory: `site`** → Deploy → add domain worldmonitorlive.app.

## Backend
Ingestion runs entirely inside Supabase (Edge Function + pg_cron). See SUPABASE-SETUP.md.
