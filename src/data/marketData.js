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

module.exports = { DEFAULT_SYMBOLS, RANGE_FALLBACKS, yahooBars, yahooBarsWithFallback, fetchUniverse, round, percentMove };
