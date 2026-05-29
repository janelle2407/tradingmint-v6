const cache = new Map();

const DEFAULT_SYMBOLS = [
  "SPY", "QQQ", "DIA", "IWM",
  "NVDA", "AVGO", "AMD", "META", "PLTR", "TSLA", "CRWD", "AMZN", "AAPL", "MSFT",
  "GOOGL", "NFLX", "COST", "LLY", "JPM", "SMCI", "MSTR", "COIN", "HOOD",
  "ORCL", "CRM", "ADBE", "PANW", "NOW", "SNOW", "SHOP", "UBER", "MU", "QCOM",
  "WMT", "HD", "MA", "V", "BAC", "XOM", "CVX", "CAT", "DE", "GE",
  "LRCX", "KLAC", "AMAT", "INTC", "MRVL", "ARM", "NET", "DDOG", "ZS",
  "MELI", "ABNB", "DASH", "RBLX", "ROKU", "SQ", "PYPL", "SOFI",
  "XLE", "XLK", "XLF", "XLV", "XLY", "XLI", "XLP", "XLU", "XLB", "XLRE"
];

const RANGE_FALLBACKS = ["max", "10y", "5y", "3y"];

function round(value, decimals = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(decimals)) : null;
}

function percentMove(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return 0;
  return ((current - previous) / previous) * 100;
}

async function yahooBarsRaw(symbol, range = "max", interval = "1d") {
  const clean = String(symbol || "").trim().toUpperCase();
  const key = `${clean}:${range}:${interval}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < 180000) return cached;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(clean)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
    });

    if (!response.ok) throw new Error(`${clean} HTTP ${response.status}`);
    const payload = await response.json();
    const result = payload?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    if (!result?.timestamp || !quote) throw new Error(`${clean} missing chart data`);

    const bars = result.timestamp.map((timestamp, index) => ({
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      open: Number(quote.open?.[index]),
      high: Number(quote.high?.[index]),
      low: Number(quote.low?.[index]),
      close: Number(quote.close?.[index]),
      volume: Number(quote.volume?.[index] || 0)
    })).filter(bar =>
      Number.isFinite(bar.open) && Number.isFinite(bar.high) &&
      Number.isFinite(bar.low) && Number.isFinite(bar.close)
    );

    if (bars.length < 200) throw new Error(`${clean} only returned ${bars.length} usable bars`);
    const out = { bars, usedRange: range, interval, firstDate: bars[0]?.date, lastDate: bars.at(-1)?.date, barCount: bars.length };
    cache.set(key, { time: Date.now(), ...out });
    return out;
  } finally {
    clearTimeout(timeout);
  }
}

async function yahooBarsWithFallback(symbol, preferredRange = "max", interval = "1d") {
  const ranges = preferredRange === "max"
    ? RANGE_FALLBACKS
    : [preferredRange, ...RANGE_FALLBACKS.filter(r => r !== preferredRange)];

  const errors = [];
  for (const range of ranges) {
    try { return await yahooBarsRaw(symbol, range, interval); }
    catch (error) { errors.push(`${range}: ${error.message}`); }
  }
  throw new Error(`${symbol} failed all ranges: ${errors.join(" | ")}`);
}

async function yahooBars(symbol, range = "max", interval = "1d") {
  const result = await yahooBarsWithFallback(symbol, range, interval);
  return result.bars;
}

// Fetch symbols in parallel batches — much faster than sequential
async function fetchUniverse(symbols = DEFAULT_SYMBOLS, limit = 70, range = "max") {
  const unique = [...new Set(symbols.map(s => String(s).trim().toUpperCase()).filter(Boolean))].slice(0, limit);
  const barsBySymbol = {};
  const metaBySymbol = {};
  const errors = [];

  // Process in batches of 8 in parallel — fast but won't overwhelm Yahoo
  const BATCH = 8;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(symbol => yahooBarsWithFallback(symbol, range, "1d").then(r => ({ symbol, r })))
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        const { symbol, r } = result.value;
        barsBySymbol[symbol] = r.bars;
        metaBySymbol[symbol] = {
          usedRange: r.usedRange, interval: r.interval,
          firstDate: r.firstDate, lastDate: r.lastDate, barCount: r.barCount
        };
      } else {
        // Extract symbol from error or batch
        const idx = results.indexOf(result);
        errors.push({ symbol: batch[idx], error: result.reason?.message || "unknown" });
      }
    }
  }

  return { barsBySymbol, metaBySymbol, errors, requested: unique, range, interval: "1d", rangeFallbacks: RANGE_FALLBACKS };
}


function dataQualityScore(bars) {
  if (!Array.isArray(bars) || bars.length < 200) {
    return { score: 0, label: "POOR", warnings: ["Too few bars — need at least 200."] };
  }
  let score = 100;
  const warnings = [];
  const zeroDays = bars.filter(b => Number(b.volume || 0) === 0).length;
  if (zeroDays > 5) { score -= 15; warnings.push(`${zeroDays} zero-volume bars detected.`); }
  const badOhlc = bars.filter(b =>
    !Number.isFinite(b.open) || !Number.isFinite(b.high) || !Number.isFinite(b.low) || !Number.isFinite(b.close) ||
    b.high < b.low || b.close <= 0
  ).length;
  if (badOhlc > 0) { score -= 25; warnings.push(`${badOhlc} bad OHLC bars detected.`); }
  const hugeGaps = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close, curr = bars[i].close;
    if (prev > 0 && curr > 0) {
      const move = Math.abs((curr - prev) / prev) * 100;
      if (move > 40) hugeGaps.push({ date: bars[i].date, move: Number(move.toFixed(1)) });
    }
  }
  if (hugeGaps.length) { score -= 10; warnings.push(`${hugeGaps.length} very large price gaps — check for splits.`); }
  score = Math.max(0, Math.min(100, score));
  return {
    score, warnings,
    label: score >= 90 ? "EXCELLENT" : score >= 75 ? "GOOD" : score >= 50 ? "FAIR" : "POOR"
  };
}


// ─── Earnings Calendar ────────────────────────────────────────────────────────
// Fetches next earnings date from Yahoo Finance (free, no API key needed)
// Returns null if unavailable so the filter degrades gracefully

const earningsCache = new Map();
const EARNINGS_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

async function fetchEarningsDate(symbol) {
  const clean = String(symbol || "").trim().toUpperCase();
  const cached = earningsCache.get(clean);
  if (cached && Date.now() - cached.time < EARNINGS_CACHE_TTL) return cached.date;

  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(clean)}?modules=calendarEvents`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const earnings = data?.quoteSummary?.result?.[0]?.calendarEvents?.earnings;
      const dates = earnings?.earningsDate || [];
      // Yahoo returns array of timestamps — take the nearest future one
      const now = Date.now() / 1000;
      const next = dates
        .map(d => Number(d.raw || d))
        .filter(ts => ts > now - 86400) // include today
        .sort((a, b) => a - b)[0];
      const dateStr = next ? new Date(next * 1000).toISOString().slice(0, 10) : null;
      earningsCache.set(clean, { date: dateStr, time: Date.now() });
      return dateStr;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    earningsCache.set(clean, { date: null, time: Date.now() });
    return null;
  }
}

async function fetchEarningsCalendar(symbols) {
  const calendar = {};
  const BATCH = 6;
  const unique = [...new Set(symbols.map(s => s.toUpperCase()))];
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(sym => fetchEarningsDate(sym).then(date => ({ sym, date })))
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.date) {
        calendar[r.value.sym] = { date: r.value.date };
      }
    }
    if (i + BATCH < unique.length) await new Promise(r => setTimeout(r, 150));
  }
  return calendar;
}

module.exports = { DEFAULT_SYMBOLS, RANGE_FALLBACKS, yahooBars, yahooBarsWithFallback, fetchUniverse, round, percentMove, dataQualityScore, fetchEarningsCalendar, fetchEarningsDate };
