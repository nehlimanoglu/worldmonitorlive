# World Monitor — static site (worldmonitorlive.app)

Three self-contained pages, ready to deploy to any static host:

- `index.html` — landing (hero globe, live-map preview, pricing → quiz)
- `map.html`   — full live map (Map/Globe, zoom/pan, connects to the news backend)
- `quiz.html`  — onboarding funnel → Stripe

Links between them are relative (`quiz.html`, `map.html`), so no config needed.
The map reads live data from the Render backend (`DATA_API` inside `map.html`).

---

## Deploy — easiest path (Netlify Drop, ~2 min, no git)

1. Go to **https://app.netlify.com/drop**
2. Drag this whole `site/` folder onto the page → it deploys instantly to a
   temporary `*.netlify.app` URL (test it).
3. **Site settings → Domain management → Add custom domain** → `worldmonitorlive.app`
4. Netlify shows the DNS records to add. In **Namecheap → Domain List →
   worldmonitorlive.app → Manage → Advanced DNS**, add them:
   - apex `worldmonitorlive.app` → the **A / ALIAS** record Netlify gives
     (Netlify's load-balancer IP `75.2.60.5`, or use Netlify DNS nameservers)
   - `www` → **CNAME** → `<your-site>.netlify.app`
5. Wait for DNS + auto HTTPS (`.app` requires HTTPS — Netlify provisions it free).

### Alternative: Cloudflare Pages
- Cloudflare → **Workers & Pages → Create → Pages → Direct Upload** → upload `site/`
- Add custom domain `worldmonitorlive.app` (simplest if you move the domain's
  nameservers to Cloudflare — it wires DNS + HTTPS automatically).

### Alternative: Vercel
- `vercel` CLI in this folder, or drag-drop; add the domain in the dashboard and
  set the Namecheap DNS records it shows.

---

## Backend (already live on Render)

`map.html` calls `https://worldmonitor-news.onrender.com` for live events.
CORS is `*`, so it works from your new domain out of the box.

**Optional polish:**
- Tighten CORS: Render → env `ALLOWED_ORIGINS=https://worldmonitorlive.app`
- Custom API subdomain: Render → Settings → Custom Domain → `api.worldmonitorlive.app`,
  add the CNAME it gives in Namecheap, then change `DATA_API` in `map.html` to
  `https://api.worldmonitorlive.app` and redeploy the site.

## Stripe (quiz checkout)

In `quiz.html` set your real Stripe Payment Links (or switch `CHECKOUT_MODE` to
`"backend"` and point `BACKEND_URL` at the stripe-checkout-backend). See
`../stripe-checkout-backend/README.md`.
