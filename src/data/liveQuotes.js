// ─── Live Quote Engine v2 ─────────────────────────────────────────────────────
// Tries multiple Yahoo Finance endpoints for live prices
// Falls back gracefully to daily bars if all fail
// Cache: 60 seconds per symbol

const liveCache = new Map();
const LIVE_CACHE_TTL = 60 * 1000;
let consecutiveFailures = 0;
let livePausedUntil = 0;
const MAX_FAILURES = 5; // Stop trying live after too many failures
const LIVE_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

function isMarketHours() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 25 && mins < 16 * 60 + 5;
}

const YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Origin": "https://finance.yahoo.com",
  "Referer": "https://finance.yahoo.com/"
};

async function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: YAHOO_HEADERS });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLiveQuote(symbol) {
  const clean = String(symbol || "").trim().toUpperCase();
  const key = `live:${clean}`;
  const cached = liveCache.get(key);
  if (cached && Date.now() - cached.time < LIVE_CACHE_TTL) return cached;

  // Try query1 then query2
  const endpoints = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(clean)}?range=1d&interval=1m&includePrePost=false`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(clean)}?range=1d&interval=2m&includePrePost=false`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(clean)}?range=5d&interval=5m&includePrePost=false`,
  ];

  for (const url of endpoints) {
    try {
      const response = await fetchWithTimeout(url);
      if (!response.ok) continue;
      const payload = await response.json();
      const result = payload?.chart?.result?.[0];
      const quote = result?.indicators?.quote?.[0];
      if (!result || !quote) continue;

      const rawCloses = quote.close || [];
      const rawOpens  = quote.open  || [];
      const rawHighs  = quote.high  || [];
      const rawLows   = quote.low   || [];
      const rawVols   = quote.volume|| [];

      // Get last valid close
      let price = null;
      for (let i = rawCloses.length - 1; i >= 0; i--) {
        if (rawCloses[i] != null && Number.isFinite(rawCloses[i])) {
          price = rawCloses[i]; break;
        }
      }
      if (!price) continue;

      const validCloses = rawCloses.filter(v => v != null && Number.isFinite(v));
      const validHighs  = rawHighs.filter(v => v != null && Number.isFinite(v));
      const validLows   = rawLows.filter(v => v != null && Number.isFinite(v));
      const validVols   = rawVols.filter(v => v != null);

      const open = rawOpens.find(v => v != null && Number.isFinite(v)) || price;
      const high = validHighs.length ? Math.max(...validHighs) : price;
      const low  = validLows.length  ? Math.min(...validLows)  : price;
      const volume = validVols.reduce((s, v) => s + (Number(v) || 0), 0);
      const prevClose = result?.meta?.chartPreviousClose || result?.meta?.previousClose || null;
      const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : null;

      const out = {
        symbol: clean, price: Number(price.toFixed(2)),
        open: Number(open.toFixed(2)), high: Number(high.toFixed(2)), low: Number(low.toFixed(2)),
        volume, prevClose: prevClose ? Number(Number(prevClose).toFixed(2)) : null,
        changePct: changePct != null ? Number(changePct.toFixed(2)) : null,
        isLive: true, time: Date.now()
      };
      liveCache.set(key, out);
      consecutiveFailures = 0;
      livePausedUntil = 0;
      return out;
    } catch (e) {
      continue;
    }
  }

  consecutiveFailures++;
  if (consecutiveFailures >= MAX_FAILURES) {
    livePausedUntil = Date.now() + LIVE_FAILURE_COOLDOWN_MS;
  }
  throw new Error(`${clean}: all live endpoints failed`);
}

async function fetchLiveQuotes(symbols) {
  if (!isMarketHours()) return { quotes: {}, isLive: false, reason: "Market closed" };
  if (livePausedUntil && Date.now() < livePausedUntil) {
    const mins = Math.ceil((livePausedUntil - Date.now()) / 60000);
    return { quotes: {}, isLive: false, liveCount: 0, reason: `Live data cooling down after ${consecutiveFailures} failures. Retrying in ${mins} minute(s).` };
  }
  if (livePausedUntil && Date.now() >= livePausedUntil) {
    consecutiveFailures = 0;
    livePausedUntil = 0;
  }

  const results = {};
  const errors = [];
  const BATCH = 8;
  const unique = [...new Set(symbols.map(s => s.toUpperCase()).filter(Boolean))];

  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map(sym => fetchLiveQuote(sym).then(q => ({ sym, q })))
    );
    for (const r of settled) {
      if (r.status === "fulfilled") results[r.value.sym] = r.value.q;
      else errors.push(r.reason?.message || "unknown");
    }
    // Small delay between batches to avoid rate limiting
    if (i + BATCH < unique.length) await new Promise(r => setTimeout(r, 200));
  }

  const liveCount = Object.keys(results).length;
  if (liveCount > 0) {
    consecutiveFailures = 0;
    livePausedUntil = 0;
  }
  return {
    quotes: results,
    isLive: liveCount > 0,
    liveCount,
    errorCount: errors.length,
    reason: liveCount > 0 ? `${liveCount} live prices` : "All live fetches failed"
  };
}

function mergeLiveIntoBars(barsBySymbol, quotes) {
  const merged = {};
  for (const [symbol, bars] of Object.entries(barsBySymbol)) {
    const live = quotes[symbol];
    if (!live || !bars.length) { merged[symbol] = bars; continue; }
    const updatedBars = [...bars];
    const last = { ...updatedBars[updatedBars.length - 1] };
    last.close  = live.price;
    last.high   = Math.max(last.high  || live.price, live.high  || live.price);
    last.low    = Math.min(last.low   || live.price, live.low   || live.price);
    last.volume = live.volume || last.volume;
    last.isLive = true;
    updatedBars[updatedBars.length - 1] = last;
    merged[symbol] = updatedBars;
  }
  return merged;
}

module.exports = { fetchLiveQuotes, fetchLiveQuote, mergeLiveIntoBars, isMarketHours };
