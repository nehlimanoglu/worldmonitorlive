// World Monitor — ingestion Edge Function (Deno).
// Pulls USGS + GDELT + Hacker News + crypto RSS + (optional) Finnhub, normalizes to
// the events schema, and upserts into the `events` table. Triggered by pg_cron.
//
// Deploy:  supabase functions deploy ingest
// Secrets: supabase secrets set FINNHUB_TOKEN=...            (optional, for markets)
//          (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically)
// Schedule: run supabase-cron.sql once in the SQL editor.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Row = { cat: string; title: string; place: string; lon: number; lat: number; t: string; key: string };

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const CRYPTO_HUBS: [number, number, string][] = [
  [-74, 40.7, "New York"], [-0.1, 51.5, "London"], [103.8, 1.35, "Singapore"],
  [139.7, 35.7, "Tokyo"], [8.5, 47.4, "Zurich"], [121.5, 25, "Taipei"],
  [-122.4, 37.8, "San Francisco"], [55.3, 25.2, "Dubai"],
];
const MARKET_HUBS: [number, number, string][] = [
  [-74, 40.7, "New York"], [-0.1, 51.5, "London"], [139.7, 35.7, "Tokyo"],
  [114.2, 22.3, "Hong Kong"], [8.7, 50.1, "Frankfurt"], [121.5, 31.2, "Shanghai"],
  [72.8, 19.1, "Mumbai"], [151.2, -33.9, "Sydney"],
];
const TECH_HUBS: [number, number, string][] = [
  [-122.4, 37.8, "San Francisco"], [-122.3, 47.6, "Seattle"], [-97.7, 30.3, "Austin"],
  [-0.1, 51.5, "London"], [77.6, 12.97, "Bangalore"], [116.4, 39.9, "Beijing"],
  [34.8, 32.1, "Tel Aviv"], [-79.4, 43.7, "Toronto"],
];

function extractTitle(html?: string): string | null {
  if (!html) return null;
  const m = String(html).match(/<a[^>]*>([^<]{6,})<\/a>/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

function parseRSS(xml: string): { title: string; ts: number }[] {
  const out: { title: string; ts: number }[] = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  for (const b of blocks) {
    let t = (b.match(/<title>([\s\S]*?)<\/title>/i) ?? [])[1] ?? "";
    t = t.replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").replace(/&amp;/g, "&")
         .replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const d = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) ?? [])[1] ?? "";
    const ts = d ? Date.parse(d) : Date.now();
    if (t) out.push({ title: t.slice(0, 180), ts: isNaN(ts) ? Date.now() : ts });
  }
  return out;
}

async function usgs(): Promise<Row[]> {
  try {
    const feed = Deno.env.get("USGS_FEED") ?? "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson";
    const min = Number(Deno.env.get("USGS_MIN_MAG") ?? "2.5");
    const j = await (await fetch(feed)).json();
    return (j.features ?? [])
      .filter((f: any) => (f.properties?.mag ?? 0) >= min && f.geometry?.coordinates)
      .map((f: any) => ({
        cat: "weather",
        title: `M${f.properties.mag ?? "?"} earthquake — ${f.properties.place ?? "unknown location"}`,
        place: f.properties.place ?? "",
        lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
        t: new Date(f.properties.time ?? Date.now()).toISOString(),
        key: `usgs|${f.id}`,
      }));
  } catch (e) { console.error("usgs", (e as Error).message); return []; }
}

async function gdelt(): Promise<Row[]> {
  try {
    const q = encodeURIComponent(Deno.env.get("GDELT_QUERY") ?? "(protest OR clash OR strike OR election OR earthquake OR flood OR wildfire OR outage OR attack OR ceasefire)");
    const span = encodeURIComponent(Deno.env.get("GDELT_TIMESPAN") ?? "30min");
    const url = `https://api.gdeltproject.org/api/v2/geo/geo?query=${q}&mode=PointData&format=GeoJSON&timespan=${span}`;
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 15000);
    let txt: string;
    try {
      txt = await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 WorldMonitor/1.0" }, signal: ac.signal })).text();
    } finally { clearTimeout(to); }
    let j: any; try { j = JSON.parse(txt); } catch { return []; }
    return (j.features ?? []).slice(0, 40)
      .filter((f: any) => f.geometry?.coordinates)
      .map((f: any) => {
        const pr = f.properties ?? {};
        const title = extractTitle(pr.html) ?? (pr.name ? `${pr.name} — developing` : "Breaking activity");
        return {
          cat: "world", title, place: pr.name ?? "",
          lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
          t: new Date().toISOString(), key: `gdelt|${pr.name ?? ""}|${title.slice(0, 60)}`,
        };
      });
  } catch (e) { console.error("gdelt", (e as Error).message); return []; }
}

async function hn(): Promise<Row[]> {
  try {
    const q = encodeURIComponent(Deno.env.get("AI_QUERY") ?? 'AI OR "artificial intelligence" OR LLM OR OpenAI OR chatbot OR "machine learning"');
    const j = await (await fetch(`https://hn.algolia.com/api/v1/search_by_date?tags=story&query=${q}&hitsPerPage=25`)).json();
    return (j.hits ?? []).filter((h: any) => h.title).map((h: any, i: number) => {
      const hub = TECH_HUBS[i % TECH_HUBS.length];
      return {
        cat: "ai", title: h.title, place: hub[2], lon: hub[0], lat: hub[1],
        t: new Date((h.created_at_i ? h.created_at_i * 1000 : Date.now())).toISOString(),
        key: `hn|${h.objectID}`,
      };
    });
  } catch (e) { console.error("hn", (e as Error).message); return []; }
}

async function cryptoRss(): Promise<Row[]> {
  const feeds = (Deno.env.get("CRYPTO_RSS") ?? "https://www.coindesk.com/arc/outboundfeeds/rss/,https://cointelegraph.com/rss")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const rows: Row[] = []; let i = 0;
  for (const f of feeds) {
    try {
      const xml = await (await fetch(f, { headers: { "User-Agent": "Mozilla/5.0 WorldMonitor/1.0" } })).text();
      for (const it of parseRSS(xml).slice(0, 15)) {
        const hub = CRYPTO_HUBS[i++ % CRYPTO_HUBS.length];
        rows.push({ cat: "crypto", title: it.title, place: hub[2], lon: hub[0], lat: hub[1], t: new Date(it.ts).toISOString(), key: `rss|${it.title.slice(0, 70)}` });
      }
    } catch (e) { console.error("rss", f, (e as Error).message); }
  }
  return rows;
}

async function finnhub(): Promise<Row[]> {
  const token = Deno.env.get("FINNHUB_TOKEN");
  if (!token) return [];
  try {
    const arr = await (await fetch(`https://finnhub.io/api/v1/news?category=general&token=${token}`)).json();
    return (Array.isArray(arr) ? arr : []).slice(0, 25).filter((p: any) => p.headline).map((p: any, i: number) => {
      const hub = MARKET_HUBS[i % MARKET_HUBS.length];
      return {
        cat: "markets", title: p.headline, place: hub[2], lon: hub[0], lat: hub[1],
        t: new Date(p.datetime ? p.datetime * 1000 : Date.now()).toISOString(),
        key: `fh|${p.id || p.url || p.headline.slice(0, 60)}`,
      };
    });
  } catch (e) { console.error("finnhub", (e as Error).message); return []; }
}

async function ingestAll(): Promise<number> {
  const results = await Promise.allSettled([usgs(), gdelt(), hn(), cryptoRss(), finnhub()]);
  const rows: Row[] = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (rows.length) {
    const { error } = await supa.from("events").upsert(rows, { onConflict: "key", ignoreDuplicates: true });
    if (error) console.error("upsert", error.message);
  }
  console.log("ingested", rows.length);
  return rows.length;
}

Deno.serve(() => {
  // Return immediately so pg_net (5s default timeout) succeeds; finish the work in the
  // background. Fetching all sources (GDELT/RSS) takes longer than 5s.
  // @ts-ignore EdgeRuntime is provided by the Supabase Edge runtime
  EdgeRuntime.waitUntil(ingestAll());
  return new Response(JSON.stringify({ ok: true, started: true }), {
    headers: { "content-type": "application/json" },
  });
});
