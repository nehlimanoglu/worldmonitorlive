# World Monitor — live news backend

Pulls real-time events from **GDELT** (geolocated world news), **USGS** (earthquakes)
and **CryptoPanic** (crypto), normalizes each to the map's schema, dedups, and streams
them to the front-end.

```
GET /api/events?since=<ms>   → recent events, newest first
GET /api/stream              → Server-Sent Events, one `data: {json}` per new event
GET /health
```

Every event is:

```json
{ "id": 1, "cat": "world", "title": "…", "place": "…", "lon": 12.3, "lat": 45.6, "t": 1788261585000 }
```

`cat` ∈ `crypto · ai · markets · conflict · weather · world` (matches the map).

| Source | Category | Key needed | Coords |
|---|---|---|---|
| USGS earthquakes | `weather` | no | real (feed) |
| GDELT geo news | `world` | no | real (feed) |
| Hacker News (Algolia) | `ai` | no | placed on tech hubs |
| Finnhub news | `markets` | free token | placed on market hubs |
| CryptoPanic | `crypto` | free token | placed on finance hubs |

News without coordinates (crypto/markets/ai) is placed on a rotating list of relevant
world cities so pins spread out; swap for real geodata later if you want.

## Run

```bash
cp .env.example .env      # CryptoPanic token optional; USGS + GDELT need no key
npm install
npm start                 # → http://localhost:4000
curl localhost:4000/api/events | head
```

It fetches on a schedule (USGS 2 min, GDELT 5 min, CryptoPanic 3 min) and pushes
new items to any connected `/api/stream` client immediately.

## Point the map at it

In `wm-livemap.html` set the one config line near the top of the script:

```js
var DATA_API = "https://news.worldmonitor.app";   // where this service is deployed
```

- **Empty string** (default) → the map runs on built-in demo data (needed for the
  sandboxed artifact preview, which can't call an external server).
- **Set** → on load the map does `GET /api/events`, then opens `EventSource(/api/stream)`
  for live updates. All rendering (pins, arcs, globe) stays the same — only the data source changes.

## Deploy

Any Node host (Render, Railway, Fly.io, a VPS). Long-lived process (keeps SSE
connections + in-memory buffer), so **not** a good fit for short-lived serverless
functions — use a always-on service.

- Build `npm install` · Start `npm start`
- Set env vars from `.env.example`
- Set `ALLOWED_ORIGINS` to your site origin(s) so the browser can call it
- Put it behind HTTPS (SSE over http is fine locally, but the site is https)

## Notes & next steps

- **GDELT** titles are parsed from the GEO API's popup HTML; tune `GDELT_QUERY` to
  change what shows up (broader = more pins).
- **Crypto** news has no coordinates, so items are placed on a rotating list of
  financial hubs (NYC, London, Singapore…). Swap for real exchange geodata if you want.
- **Markets / AI** aren't wired yet — add ingestors the same way (Finnhub/Polygon for
  markets → `markets`, TechCrunch/HN RSS for AI → `ai`) and call `addEvent({...})`.
- For scale, move the buffer to Redis and run ingestion as a separate worker; the API
  stays the same.
- Respect each source's rate limits / terms (GDELT is generous; CryptoPanic free tier
  is limited; USGS is public).
