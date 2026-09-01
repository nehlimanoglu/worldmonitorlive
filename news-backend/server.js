// World Monitor — live news ingestion
// Pulls GDELT (world news, geolocated) + USGS (earthquakes) + CryptoPanic (crypto),
// normalizes every item to { id, cat, title, place, lon, lat, t }, dedups, keeps a
// rolling buffer, and serves it over REST + Server-Sent Events.
//
//   GET /api/events?since=<ms>   -> recent events (newest first)
//   GET /api/stream              -> SSE, one `data: {json}` per new event
//   GET /health
//
// Setup: cp .env.example .env && npm install && npm start
// USGS + GDELT need no API key; CryptoPanic needs a free token (optional).

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import dns from 'node:dns';
import { createClient } from '@supabase/supabase-js';
// Some hosts' IPv6 path to GDELT/USGS is broken → "fetch failed". Prefer IPv4.
dns.setDefaultResultOrder('ipv4first');

const {
  PORT = 4000,
  ALLOWED_ORIGINS = '*',
  CRYPTOPANIC_TOKEN = '',
  USGS_FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson',
  USGS_MIN_MAG = '2.5',
  GDELT_QUERY = '(protest OR clash OR strike OR election OR earthquake OR flood OR wildfire OR outage OR attack OR ceasefire)',
  GDELT_TIMESPAN = '30min',
  FINNHUB_TOKEN = '',
  AI_QUERY = 'AI OR "artificial intelligence" OR LLM OR OpenAI OR chatbot OR "machine learning"',
  CRYPTO_RSS = 'https://www.coindesk.com/arc/outboundfeeds/rss/,https://cointelegraph.com/rss',
  BUFFER_MAX = '500',
} = process.env;

const MAX = parseInt(BUFFER_MAX, 10) || 500;
const MIN_MAG = parseFloat(USGS_MIN_MAG) || 2.5;

// Supabase (persistence + Realtime). If unset, the service just serves in-memory.
const supa = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } })
  : null;

// categories must match the map's CATS keys
const buffer = [];             // newest first
const seen = new Map();         // dedup key -> ts
const clients = new Set();      // SSE responses
let nextId = 1;

function addEvent(ev) {
  if (ev.lon == null || ev.lat == null || !ev.title) return false;
  const key = ev.key || `${ev.cat}|${ev.title.slice(0, 80)}|${ev.place || ''}`;
  if (seen.has(key)) return false;
  seen.set(key, Date.now());
  const e = {
    id: nextId++,
    cat: ev.cat,
    title: ev.title.trim(),
    place: (ev.place || '').trim(),
    lon: +ev.lon,
    lat: +ev.lat,
    t: ev.t || Date.now(),
  };
  buffer.unshift(e);
  if (buffer.length > MAX) buffer.pop();
  broadcast(e);
  if (supa) {
    supa.from('events').upsert(
      { cat: e.cat, title: e.title, place: e.place, lon: e.lon, lat: e.lat, t: new Date(e.t).toISOString(), key },
      { onConflict: 'key', ignoreDuplicates: true }
    ).then(({ error }) => { if (error) console.error('supabase upsert:', error.message); });
  }
  return true;
}

function broadcast(e) {
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const res of clients) { try { res.write(line); } catch { /* dropped */ } }
}

// prune dedup memory so it doesn't grow forever
setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000; // 6h
  for (const [k, ts] of seen) if (ts < cutoff) seen.delete(k);
}, 10 * 60 * 1000);

// ---------- ingestors ----------

async function pullUSGS() {
  try {
    const r = await fetch(USGS_FEED);
    const j = await r.json();
    let n = 0;
    for (const f of j.features || []) {
      const c = f.geometry?.coordinates;
      const p = f.properties || {};
      if (!c) continue;
      if ((p.mag || 0) < MIN_MAG) continue;
      if (addEvent({
        cat: 'weather',
        title: `M${p.mag ?? '?'} earthquake — ${p.place || 'unknown location'}`,
        place: p.place || '',
        lon: c[0], lat: c[1],
        t: p.time || Date.now(),
        key: `usgs|${f.id}`,
      })) n++;
    }
    if (n) console.log(`USGS +${n}`);
  } catch (e) { console.error('USGS error:', e.message); }
}

function extractTitle(html) {
  if (!html) return null;
  const m = String(html).match(/<a[^>]*>([^<]{6,})<\/a>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

async function pullGDELT() {
  try {
    const url = `https://api.gdeltproject.org/api/v2/geo/geo?query=${encodeURIComponent(GDELT_QUERY)}&mode=PointData&format=GeoJSON&timespan=${encodeURIComponent(GDELT_TIMESPAN)}`;
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 25000);
    let txt;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 WorldMonitor/1.0', Accept: 'application/geo+json, application/json' }, signal: ac.signal });
      txt = await r.text();
    } finally { clearTimeout(to); }
    let j;
    try { j = JSON.parse(txt); } catch { return; } // GDELT sometimes returns non-JSON on throttle
    let n = 0;
    for (const f of (j.features || []).slice(0, 40)) {
      const c = f.geometry?.coordinates;
      const pr = f.properties || {};
      if (!c) continue;
      const title = extractTitle(pr.html) || (pr.name ? `${pr.name} — developing` : 'Breaking activity');
      if (addEvent({
        cat: 'world',
        title,
        place: pr.name || '',
        lon: c[0], lat: c[1],
        t: Date.now(),
        key: `gdelt|${pr.name || ''}|${title.slice(0, 60)}`,
      })) n++;
    }
    if (n) console.log(`GDELT +${n}`);
  } catch (e) { console.error('GDELT error:', e.message); }
}

const CRYPTO_HUBS = [
  [-74, 40.7, 'New York'], [-0.1, 51.5, 'London'], [103.8, 1.35, 'Singapore'],
  [139.7, 35.7, 'Tokyo'], [8.5, 47.4, 'Zurich'], [121.5, 25, 'Taipei'],
  [-122.4, 37.8, 'San Francisco'], [55.3, 25.2, 'Dubai'],
];
let hubIx = 0;

const MARKET_HUBS = [
  [-74, 40.7, 'New York'], [-0.1, 51.5, 'London'], [139.7, 35.7, 'Tokyo'],
  [114.2, 22.3, 'Hong Kong'], [8.7, 50.1, 'Frankfurt'], [121.5, 31.2, 'Shanghai'],
  [72.8, 19.1, 'Mumbai'], [151.2, -33.9, 'Sydney'],
];
let mkIx = 0;

const TECH_HUBS = [
  [-122.4, 37.8, 'San Francisco'], [-122.3, 47.6, 'Seattle'], [-97.7, 30.3, 'Austin'],
  [-0.1, 51.5, 'London'], [77.6, 12.97, 'Bangalore'], [116.4, 39.9, 'Beijing'],
  [34.8, 32.1, 'Tel Aviv'], [-79.4, 43.7, 'Toronto'],
];
let aiIx = 0;

async function pullCrypto() {
  if (!CRYPTOPANIC_TOKEN) return;
  try {
    const r = await fetch(`https://cryptopanic.com/api/v1/posts/?auth_token=${CRYPTOPANIC_TOKEN}&public=true&kind=news`);
    const j = await r.json();
    let n = 0;
    for (const p of (j.results || []).slice(0, 20)) {
      const hub = CRYPTO_HUBS[hubIx++ % CRYPTO_HUBS.length];
      if (addEvent({
        cat: 'crypto',
        title: p.title,
        place: hub[2],
        lon: hub[0], lat: hub[1],
        t: Date.parse(p.published_at) || Date.now(),
        key: `cp|${p.id}`,
      })) n++;
    }
    if (n) console.log(`CryptoPanic +${n}`);
  } catch (e) { console.error('CryptoPanic error:', e.message); }
}

function parseRSS(xml) {
  const out = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    let t = (b.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
    t = t.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')
         .replace(/&amp;/g, '&').replace(/&#039;|&apos;/g, "'").replace(/&quot;/g, '"')
         .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const d = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || '';
    const ts = d ? Date.parse(d) : Date.now();
    if (t) out.push({ title: t.slice(0, 180), ts: isNaN(ts) ? Date.now() : ts });
  }
  return out;
}

async function pullCryptoRSS() {
  const feeds = CRYPTO_RSS.split(',').map((s) => s.trim()).filter(Boolean);
  let n = 0;
  for (const f of feeds) {
    try {
      const r = await fetch(f, { headers: { 'User-Agent': 'Mozilla/5.0 WorldMonitor/1.0' } });
      const xml = await r.text();
      for (const it of parseRSS(xml).slice(0, 15)) {
        const hub = CRYPTO_HUBS[hubIx++ % CRYPTO_HUBS.length];
        if (addEvent({
          cat: 'crypto',
          title: it.title,
          place: hub[2],
          lon: hub[0], lat: hub[1],
          t: it.ts,
          key: `rss|${it.title.slice(0, 70)}`,
        })) n++;
      }
    } catch (e) { console.error(`CryptoRSS(${f}) error:`, e.message); }
  }
  if (n) console.log(`CryptoRSS +${n}`);
}

async function pullMarkets() {
  if (!FINNHUB_TOKEN) return;
  try {
    const r = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_TOKEN}`);
    const arr = await r.json();
    let n = 0;
    for (const p of (Array.isArray(arr) ? arr : []).slice(0, 25)) {
      if (!p.headline) continue;
      const hub = MARKET_HUBS[mkIx++ % MARKET_HUBS.length];
      if (addEvent({
        cat: 'markets',
        title: p.headline,
        place: hub[2],
        lon: hub[0], lat: hub[1],
        t: p.datetime ? p.datetime * 1000 : Date.now(),
        key: `fh|${p.id || p.url || p.headline.slice(0, 60)}`,
      })) n++;
    }
    if (n) console.log(`Finnhub +${n}`);
  } catch (e) { console.error('Finnhub error:', e.message); }
}

async function pullAI() {
  try {
    const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story&query=${encodeURIComponent(AI_QUERY)}&hitsPerPage=25`;
    const r = await fetch(url);
    const j = await r.json();
    let n = 0;
    for (const h of j.hits || []) {
      if (!h.title) continue;
      const hub = TECH_HUBS[aiIx++ % TECH_HUBS.length];
      if (addEvent({
        cat: 'ai',
        title: h.title,
        place: hub[2],
        lon: hub[0], lat: hub[1],
        t: h.created_at_i ? h.created_at_i * 1000 : Date.now(),
        key: `hn|${h.objectID}`,
      })) n++;
    }
    if (n) console.log(`HN/AI +${n}`);
  } catch (e) { console.error('HN/AI error:', e.message); }
}

function schedule(fn, ms) { fn(); setInterval(fn, ms); }

// ---------- http ----------

const app = express();
const origins = ALLOWED_ORIGINS.split(',').map((s) => s.trim());
app.use(cors({ origin: origins.includes('*') ? true : origins }));

app.get('/health', (_req, res) => res.json({ ok: true, events: buffer.length, clients: clients.size }));

app.get('/api/events', (req, res) => {
  const since = +req.query.since || 0;
  res.json(since ? buffer.filter((e) => e.t > since) : buffer);
});

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// SSE keepalive
setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch { /* */ } } }, 25000);

app.listen(PORT, () => {
  console.log(`World Monitor news backend on :${PORT}`);
  console.log('Sources: GDELT, USGS, HN/AI, Crypto(RSS)'
    + (CRYPTOPANIC_TOKEN ? ', CryptoPanic' : '')
    + (FINNHUB_TOKEN ? ', Finnhub' : ''));
  schedule(pullUSGS, 120000);      // 2 min
  schedule(pullGDELT, 300000);     // 5 min
  schedule(pullAI, 240000);        // 4 min
  schedule(pullCryptoRSS, 180000); // 3 min · free, no key
  if (CRYPTOPANIC_TOKEN) schedule(pullCrypto, 180000);  // 3 min · optional
  if (FINNHUB_TOKEN) schedule(pullMarkets, 180000);     // 3 min
});
