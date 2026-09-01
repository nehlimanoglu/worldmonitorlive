# World Monitor — Supabase + Vercel + Render setup

Architecture:

```
pg_cron ─every 3 min─▶ Edge Function `ingest` ─fetch sources─▶ Supabase (events table)
                                                                 │
                                                   Realtime push ▼
Vercel (static site: index/map/quiz) ◀──reads──────────────  the map (supabase-js)
```

- **Supabase** — Postgres `events` table + **Edge Function** (ingestion) + **pg_cron**
  (scheduler) + **Realtime** (live push). Everything server-side lives here — no
  always-on server needed. Later: Auth + subscriptions.
- **Vercel** — hosts `site/` (index.html, map.html, quiz.html, config.js).
- **Map** — reads recent events + subscribes to Realtime; demo fallback if unconfigured.

> The old Render `news-backend` is now **optional** — the Edge Function replaces it.
> You can leave Render off (or delete the service). It still works if you prefer it.

---

## 1. Supabase project

1. https://supabase.com → **New project** (pick a region near your users).
2. **SQL Editor → New query** → paste `supabase-schema.sql` → **Run**.
   (Creates the `events` table, RLS read policy, and adds it to Realtime.)
3. **Project Settings → API** — copy three values:
   - **Project URL** → `https://xxxx.supabase.co`
   - **anon public** key → for the front-end (safe to expose)
   - **service_role** key → for the ingester only (SECRET)

## 2. Ingestion — Edge Function + pg_cron (no server)

Install the Supabase CLI once (`brew install supabase/tap/supabase`), then from this
project folder:

```bash
supabase login
supabase link --project-ref <PROJECT_REF>          # the xxxx in xxxx.supabase.co
supabase functions deploy ingest                    # deploys supabase/functions/ingest
supabase secrets set FINNHUB_TOKEN=<your key>        # optional (markets); others need no key
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into the function
automatically — you don't set those.

Test it once by hand:

```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/ingest" \
  -H "Authorization: Bearer <ANON_KEY>"
# → {"ok":true,"fetched":N,"byCat":{...}}
```

Then schedule it: **SQL Editor** → paste `supabase-cron.sql` (replace `<PROJECT_REF>`
and `<ANON_KEY>`) → **Run**. It calls the function every 3 minutes via pg_cron + pg_net.

Verify data is landing: **Table editor → events** fills up; check runs with
`select * from cron.job_run_details order by start_time desc limit 5;`

## 3. Front-end config

Edit `site/config.js`:

```js
window.WM_SUPABASE = {
  url:  "https://xxxx.supabase.co",
  anon: "<anon public key>"     // NOT the service role
};
```

The map prefers Supabase when this is filled; otherwise it falls back to the Render
REST/SSE, otherwise to demo data.

## 4. Vercel (host the site)

Easiest (no git): https://vercel.com → **Add New → Project → deploy** the `site/`
folder (or drag-drop). Vercel serves `index.html` at `/`, and `map.html` / `quiz.html`
at those paths.

Then **Project → Settings → Domains → Add** `worldmonitorlive.app`, and in
**Namecheap → Advanced DNS** add the records Vercel shows (usually an A record
`76.76.21.21` for the apex and a CNAME `cname.vercel-dns.com` for `www`). Vercel
provisions HTTPS automatically (required for `.app`).

## 5. Verify

- Open `https://worldmonitorlive.app/map.html` → pins should be **real** events,
  and new ones appear live (Realtime) without reload.
- New event in Supabase → shows on the map within a second.

---

## Notes

- **Keys:** `anon` is public (fine in `config.js`); `service_role` is secret (Render env only).
- **Render free tier sleeps** when idle → ingestion pauses. For continuous data use a
  small paid instance, or move ingestion into a **Supabase Edge Function + pg_cron**
  (keeps everything inside Supabase). Ask and I'll port the ingester to an Edge Function.
- **Auth / subscriptions (next):** enable Supabase Auth for login, and have the Stripe
  webhook write the customer's plan into a `subscriptions` table — the site can then
  gate Pro features by the logged-in user.
