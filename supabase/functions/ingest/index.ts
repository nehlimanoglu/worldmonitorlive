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

// country name -> rough centroid [lon, lat] (GDELT DOC API gives sourcecountry, no coords)
const COUNTRY_COORDS: Record<string, [number, number]> = {
  "United States": [-98, 39], "United Kingdom": [-1.5, 52.5], "France": [2.3, 46.6],
  "Germany": [10.4, 51.2], "Spain": [-3.7, 40.4], "Italy": [12.5, 42.8], "Russia": [90, 61],
  "China": [104, 35], "India": [78, 22], "Japan": [138, 36], "Brazil": [-51, -10],
  "Canada": [-106, 56], "Australia": [134, -25], "Turkey": [35, 39], "Ukraine": [31, 49],
  "Israel": [35, 31.5], "Iran": [53, 32], "Iraq": [43.7, 33], "Saudi Arabia": [45, 24],
  "United Arab Emirates": [54, 24], "Egypt": [30, 27], "Nigeria": [8, 9], "Kenya": [37.9, 0.2],
  "South Africa": [24, -29], "Mexico": [-102, 23], "Argentina": [-64, -34], "Colombia": [-73, 4],
  "Chile": [-71, -30], "Peru": [-75, -10], "Venezuela": [-66, 7], "Nepal": [84, 28],
  "Pakistan": [69, 30], "Bangladesh": [90, 24], "Indonesia": [113, -2], "Philippines": [122, 12],
  "Vietnam": [106, 16], "Thailand": [101, 15], "Malaysia": [102, 4], "Singapore": [103.8, 1.35],
  "South Korea": [128, 36], "North Korea": [127, 40], "Taiwan": [121, 24], "Hong Kong": [114.1, 22.3],
  "Poland": [19, 52], "Netherlands": [5.3, 52.1], "Belgium": [4.5, 50.6], "Sweden": [15, 62],
  "Norway": [9, 61], "Denmark": [10, 56], "Finland": [26, 64], "Ireland": [-8, 53],
  "Portugal": [-8, 39.5], "Greece": [22, 39], "Switzerland": [8, 46.8], "Austria": [14.5, 47.6],
  "Czech Republic": [15.5, 49.8], "Romania": [25, 46], "Hungary": [19, 47], "Bulgaria": [25, 43],
  "Serbia": [21, 44], "Croatia": [16, 45], "Afghanistan": [66, 33], "Syria": [38, 35],
  "Lebanon": [35.8, 33.9], "Jordan": [36, 31], "Yemen": [48, 15.5], "Qatar": [51.2, 25.3],
  "Kuwait": [47.5, 29.3], "Morocco": [-6, 32], "Algeria": [3, 28], "Tunisia": [9, 34],
  "Libya": [17, 27], "Ethiopia": [40, 8], "Ghana": [-1, 8], "Tanzania": [35, -6],
  "Uganda": [32, 1], "Sudan": [30, 15], "New Zealand": [174, -41], "Cuba": [-79, 22],
  "Sri Lanka": [81, 7.5],
};
function gdeltDate(s?: string): string {
  const m = String(s ?? "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).toISOString() : new Date().toISOString();
}

async function gdelt(): Promise<Row[]> {
  try {
    const q = encodeURIComponent(Deno.env.get("GDELT_QUERY") ?? "(protest OR conflict OR election OR attack OR ceasefire OR crisis OR sanctions OR strike)");
    const span = encodeURIComponent(Deno.env.get("GDELT_TIMESPAN") ?? "30min");
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=ArtList&format=json&maxrecords=60&sort=DateDesc&timespan=${span}`;
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 15000);
    let j: any;
    try {
      const txt = await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 WorldMonitor/1.0" }, signal: ac.signal })).text();
      j = JSON.parse(txt);
    } catch { return []; } finally { clearTimeout(to); }
    const rows: Row[] = []; let i = 0;
    for (const a of (j.articles ?? [])) {
      if (!a.title) continue;
      const cc = COUNTRY_COORDS[a.sourcecountry];
      if (!cc) continue; // skip if we can't place it on the map
      const jx = (((i * 53) % 14) - 7) * 0.3, jy = (((i * 37) % 10) - 5) * 0.3; i++;
      rows.push({
        cat: "world",
        title: String(a.title).replace(/\s+/g, " ").trim().slice(0, 180),
        place: a.sourcecountry,
        lon: cc[0] + jx, lat: cc[1] + jy,
        t: gdeltDate(a.seendate),
        key: `gdelt|${a.url ?? a.title.slice(0, 60)}`,
      });
    }
    return rows;
  } catch (e) { console.error("gdelt", (e as Error).message); return []; }
}

async function gdacs(): Promise<Row[]> {
  try {
    const xml = await (await fetch("https://www.gdacs.org/xml/rss.xml", { headers: { "User-Agent": "Mozilla/5.0 WorldMonitor/1.0" } })).text();
    const items = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
    const rows: Row[] = [];
    for (const b of items.slice(0, 30)) {
      let title = (b.match(/<title>([\s\S]*?)<\/title>/i) ?? [])[1] ?? "";
      title = title.replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").replace(/&amp;/g, "&").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      const lat = parseFloat((b.match(/<geo:lat>([\-0-9.]+)<\/geo:lat>/i) ?? [])[1] ?? "");
      const lon = parseFloat((b.match(/<geo:long>([\-0-9.]+)<\/geo:long>/i) ?? [])[1] ?? "");
      const guid = ((b.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i) ?? [])[1] ?? title.slice(0, 60)).trim();
      const d = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) ?? [])[1] ?? "";
      if (!title || isNaN(lat) || isNaN(lon)) continue;
      const pm = title.match(/ in ([A-Z][A-Za-z .'-]{2,30}?)(?:[.,]| \d| on |$)/);
      rows.push({
        cat: "weather",
        title: title.slice(0, 180),
        place: pm ? pm[1].trim() : "GDACS alert",
        lon, lat,
        t: new Date(d ? Date.parse(d) : Date.now()).toISOString(),
        key: `gdacs|${guid}`,
      });
    }
    return rows;
  } catch (e) { console.error("gdacs", (e as Error).message); return []; }
}

// world news via RSS (GDELT is unreachable from cloud IPs). Place by country mentioned.
const WORLD_ALIASES: Record<string, string> = {
  "US": "United States", "U.S.": "United States", "USA": "United States", "America": "United States", "American": "United States", "Washington": "United States", "Trump": "United States",
  "UK": "United Kingdom", "U.K.": "United Kingdom", "Britain": "United Kingdom", "British": "United Kingdom", "London": "United Kingdom", "England": "United Kingdom",
  "UAE": "United Arab Emirates", "Dubai": "United Arab Emirates",
  "Gaza": "Israel", "Palestinian": "Israel", "Palestine": "Israel", "Israeli": "Israel", "Hamas": "Israel",
  "Kyiv": "Ukraine", "Kiev": "Ukraine", "Zelensky": "Ukraine", "Moscow": "Russia", "Putin": "Russia", "Kremlin": "Russia",
  "Beijing": "China", "Chinese": "China", "Paris": "France", "French": "France", "Berlin": "Germany", "German": "Germany",
  "Tehran": "Iran", "Iranian": "Iran", "Seoul": "South Korea", "Tokyo": "Japan", "Japanese": "Japan",
  "Delhi": "India", "Indian": "India", "Mumbai": "India", "Rome": "Italy", "Madrid": "Spain", "Ankara": "Turkey",
};
function detectCountry(t: string): string | null {
  const s = " " + t + " ";
  for (const [alias, country] of Object.entries(WORLD_ALIASES)) {
    if (new RegExp(`\\b${alias.replace(/\./g, "\\.")}\\b`, "i").test(s)) return country;
  }
  for (const country of Object.keys(COUNTRY_COORDS)) {
    if (new RegExp(`\\b${country}\\b`, "i").test(s)) return country;
  }
  return null;
}
async function worldNews(): Promise<Row[]> {
  const feeds = (Deno.env.get("WORLD_RSS") ?? "https://feeds.bbci.co.uk/news/world/rss.xml,https://www.aljazeera.com/xml/rss/all.xml").split(",").map((s) => s.trim()).filter(Boolean);
  const rows: Row[] = []; let i = 0;
  for (const f of feeds) {
    try {
      const xml = await (await fetch(f, { headers: { "User-Agent": "Mozilla/5.0 WorldMonitor/1.0" } })).text();
      for (const it of parseRSS(xml).slice(0, 20)) {
        const country = detectCountry(it.title);
        if (!country) continue;
        const cc = COUNTRY_COORDS[country]; if (!cc) continue;
        const jx = (((i * 53) % 14) - 7) * 0.3, jy = (((i * 37) % 10) - 5) * 0.3; i++;
        rows.push({ cat: "world", title: it.title, place: country, lon: cc[0] + jx, lat: cc[1] + jy, t: new Date(it.ts).toISOString(), key: `world|${it.title.slice(0, 70)}` });
      }
    } catch (e) { console.error("worldNews", f, (e as Error).message); }
  }
  return rows;
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
  const results = await Promise.allSettled([usgs(), gdelt(), worldNews(), hn(), cryptoRss(), finnhub(), gdacs()]);
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
