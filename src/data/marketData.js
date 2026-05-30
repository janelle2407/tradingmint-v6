const cache = new Map();

const DEFAULT_SYMBOLS = [
  // Market ETFs — always needed for regime detection
  "SPY", "QQQ", "IWM",
  // Sector ETFs — best proxies for each sector
  "XLK", "XLF", "XLV", "XLY", "XLI", "XLE", "SMH", "IGV", "XBI", "CIBR",
  // Mega cap tech — highest volume, most liquid
  "NVDA", "AAPL", "MSFT", "META", "GOOGL", "AMZN", "TSLA",
  // Semiconductors — highest momentum group
  "AVGO", "AMD", "ARM", "MRVL", "KLAC", "LRCX", "QCOM", "MU", "ON",
  // Software & cloud — enterprise + security leaders
  "CRWD", "ORCL", "NOW", "PANW", "SNOW", "NET", "DDOG", "ZS", "FTNT", "OKTA", "TTD",
  // Growth leaders — momentum names institutional traders track
  "PLTR", "APP", "HOOD", "RBLX", "COIN", "MSTR", "SHOP", "MELI",
  // High-momentum mid-caps — often lead before becoming obvious
  "AXON", "DUOL", "HIMS", "CELH", "ASTS", "LUNR", "RXRX",
  // Healthcare & biotech
  "LLY", "NVO", "ISRG", "VRTX", "REGN", "ABBV",
  // Financials
  "JPM", "GS", "BAC", "SCHW", "KKR",
  // Industrials & infrastructure
  "CAT", "DE", "VRT", "PWR", "FAST",
  // Consumer & retail
  "COST", "CAVA", "ELF", "WING",
  // Other high-quality multinationals
  "NFLX", "UBER", "ANET", "GE", "TSM", "ASML", "SPOT", "DASH"
];

function parseSymbolList(value) {
  return String(value || "")
    .split(/[\s,]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
}

function getConfiguredSymbols() {
  const replacement = parseSymbolList(process.env.STOCK_SYMBOLS);
  const extras = parseSymbolList(process.env.EXTRA_SYMBOLS);
  const base = replacement.length ? replacement : DEFAULT_SYMBOLS;
  return [...new Set([...base, ...extras])];
}

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
  if (cached && Date.now() - cached.time < 86400000) return cached; // 24hr cache — historical data doesn't change

  // Try query1 first, fall back to query2 if blocked
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(clean)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(clean)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`,
  ];
  const url = urls[0]; // primary
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000); // fail fast — better to skip than hang

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://finance.yahoo.com",
        "Referer": "https://finance.yahoo.com/"
      }
    });

    if (!response.ok) {
      // Try query2 if query1 is blocked
      if (response.status === 403 || response.status === 429) {
        const url2 = urls[1];
        // Use a fresh AbortController — the original may already be aborted or its
        // timeout may fire and cancel this request before it completes.
        const controller2 = new AbortController();
        const timeout2 = setTimeout(() => controller2.abort(), 8000);
        const res2 = await fetch(url2, {
          signal: controller2.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://finance.yahoo.com",
            "Referer": "https://finance.yahoo.com/"
          }
        });
        if (!res2.ok) throw new Error(`${clean} HTTP ${response.status} (both endpoints blocked)`);
        const payload2 = await res2.json();
        const result2 = payload2?.chart?.result?.[0];
        const quote2 = result2?.indicators?.quote?.[0];
        if (!result2?.timestamp || !quote2) throw new Error(`${clean} missing data`);
        const bars2 = result2.timestamp.map((ts, idx) => ({
          date: new Date(ts * 1000).toISOString().slice(0, 10),
          open: Number(quote2.open?.[idx]), high: Number(quote2.high?.[idx]),
          low: Number(quote2.low?.[idx]), close: Number(quote2.close?.[idx]),
          volume: Number(quote2.volume?.[idx] || 0)
        })).filter(b => Number.isFinite(b.open) && Number.isFinite(b.close) && b.close > 0);
        clearTimeout(timeout2);
        if (bars2.length < 200) throw new Error(`${clean} only ${bars2.length} bars from query2`);
        const out2 = { bars: bars2, usedRange: range, interval, firstDate: bars2[0]?.date, lastDate: bars2.at(-1)?.date, barCount: bars2.length };
        cache.set(key, { time: Date.now(), ...out2 });
        return out2;
      }
      throw new Error(`${clean} HTTP ${response.status}`);
    }
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
  // Only try max then one fallback — walking all ranges is too slow on cloud hosts
  const ranges = preferredRange === "max"
    ? ["max", "5y"]
    : [preferredRange, "5y"].filter((r, i, a) => a.indexOf(r) === i);

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
async function fetchUniverse(symbols = getConfiguredSymbols(), limit = 120, range = "max") {
  const unique = [...new Set(symbols.map(s => String(s).trim().toUpperCase()).filter(Boolean))].slice(0, limit);
  const barsBySymbol = {};
  const metaBySymbol = {};
  const errors = [];

  // Process in batches of 8 in parallel — fast but won't overwhelm Yahoo
  const BATCH = 8;
  let emptyBatches = 0;
  const STOP_AFTER_EMPTY = Number(process.env.STOP_AFTER_EMPTY_BATCHES || 2);

  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(symbol => yahooBarsWithFallback(symbol, range, "1d").then(r => ({ symbol, r })))
    );
    let batchSuccess = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        const { symbol, r } = result.value;
        barsBySymbol[symbol] = r.bars;
        metaBySymbol[symbol] = {
          usedRange: r.usedRange, interval: r.interval,
          firstDate: r.firstDate, lastDate: r.lastDate, barCount: r.barCount
        };
        batchSuccess++;
      } else {
        const idx = results.indexOf(result);
        errors.push({ symbol: batch[idx], error: result.reason?.message || "unknown" });
      }
    }
    // Circuit breaker: if too many consecutive empty batches, Yahoo is throttling — stop
    if (batchSuccess === 0) {
      emptyBatches++;
      if (emptyBatches >= STOP_AFTER_EMPTY) {
        console.log(`[CIRCUIT BREAKER] ${emptyBatches} empty batches — Yahoo throttling detected. Returning partial data.`);
        break;
      }
    } else {
      emptyBatches = 0;
    }
    // Small delay between batches
    if (i + BATCH < unique.length) await new Promise(r => setTimeout(r, 100));
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
        headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://finance.yahoo.com",
        "Referer": "https://finance.yahoo.com/"
      }
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

// exports moved to bottom of file

// ─── Fundamental Data Fetcher ─────────────────────────────────────────────────
// Fetches earnings history, revenue growth, and institutional ownership
// All free from Yahoo Finance — same endpoint we use for earnings dates
// Cache: 12 hours (fundamentals update quarterly)

const fundamentalCache = new Map();
const FUNDAMENTAL_CACHE_TTL = 12 * 60 * 60 * 1000;

const YAHOO_HEADERS_FULL = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://finance.yahoo.com",
  "Referer": "https://finance.yahoo.com/"
};

function parseDateValue(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortByDateAsc(rows) {
  return [...rows].sort((a, b) => parseDateValue(a.date) - parseDateValue(b.date));
}

function calcYoYGrowth(rows, valueKey) {
  const sorted = sortByDateAsc(rows).filter(row => Number.isFinite(Number(row[valueKey])));
  const growth = [];
  for (let i = 4; i < sorted.length; i++) {
    const current = Number(sorted[i][valueKey]);
    const priorYear = Number(sorted[i - 4][valueKey]);
    if (!Number.isFinite(current) || !Number.isFinite(priorYear) || priorYear === 0) continue;
    growth.push({ date: sorted[i].date, value: ((current - priorYear) / Math.abs(priorYear)) * 100 });
  }
  return growth;
}

async function fetchFundamentals(symbol) {
  const clean = String(symbol || "").trim().toUpperCase();
  const cached = fundamentalCache.get(clean);
  if (cached && Date.now() - cached.time < FUNDAMENTAL_CACHE_TTL) return cached.data;

  try {
    const modules = "earningsHistory,incomeStatementHistoryQuarterly,institutionOwnership,defaultKeyStatistics";
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(clean)}?modules=${modules}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: YAHOO_HEADERS_FULL });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      const result = payload?.quoteSummary?.result?.[0];
      if (!result) throw new Error("No data");

      // Use true year-over-year growth: latest quarter vs same quarter last year.
      // Quarter-over-quarter growth can be distorted by seasonality.
      const epsHistory = sortByDateAsc((result.earningsHistory?.history || [])
        .map(q => ({
          date: q.quarter?.fmt || null,
          actual: Number(q.epsActual?.raw ?? null),
          estimate: Number(q.epsEstimate?.raw ?? null),
          surprise: Number(q.surprisePercent?.raw ?? null)
        }))
        .filter(q => Number.isFinite(q.actual)));

      const epsGrowthRows = calcYoYGrowth(epsHistory, "actual");
      const epsGrowth = epsGrowthRows.map(row => row.value).filter(Number.isFinite);
      const latestEpsGrowth = epsGrowth.length ? epsGrowth.at(-1) : null;
      const epsAccelerating = epsGrowth.length >= 2 ? epsGrowth.at(-1) > epsGrowth.at(-2) : null;

      const revHistory = sortByDateAsc((result.incomeStatementHistoryQuarterly?.incomeStatementHistory || [])
        .map(q => ({
          date: q.endDate?.fmt || null,
          revenue: Number(q.totalRevenue?.raw ?? null)
        }))
        .filter(q => Number.isFinite(q.revenue) && q.revenue > 0));

      const revGrowthRows = calcYoYGrowth(revHistory, "revenue");
      const revGrowthArr = revGrowthRows.map(row => row.value).filter(Number.isFinite);
      const latestRevGrowth = revGrowthArr.length ? revGrowthArr.at(-1) : null;
      const revAccelerating = revGrowthArr.length >= 2 ? revGrowthArr.at(-1) > revGrowthArr.at(-2) : null;

      const latestSurprise = epsHistory.length ? epsHistory.at(-1).surprise : null;

      const instOwnership = result.institutionOwnership?.ownershipList || [];
      const recentInst = instOwnership.slice(0, 10);
      const instPctHeld = Number(result.defaultKeyStatistics?.heldPercentInstitutions?.raw ?? null) * 100;
      const instNetChange = recentInst.reduce((sum, h) => sum + Number(h.pctChange?.raw ?? 0), 0);
      const instIncreasing = instNetChange > 0;
      const instHolderCount = instOwnership.length;

      const data = {
        symbol: clean,
        fetchedAt: new Date().toISOString(),
        epsHistory: epsHistory.slice(-8),
        latestEpsGrowth: latestEpsGrowth != null ? round(latestEpsGrowth, 1) : null,
        epsAccelerating,
        epsGrowthArr: epsGrowth.map(v => round(v, 1)),
        epsGrowthRows: epsGrowthRows.map(row => ({ date: row.date, value: round(row.value, 1) })),
        revHistory: revHistory.slice(-8),
        latestRevGrowth: latestRevGrowth != null ? round(latestRevGrowth, 1) : null,
        revAccelerating,
        revGrowthArr: revGrowthArr.map(v => round(v, 1)),
        revGrowthRows: revGrowthRows.map(row => ({ date: row.date, value: round(row.value, 1) })),
        latestSurprise: latestSurprise != null ? round(latestSurprise, 1) : null,
        instPctHeld: Number.isFinite(instPctHeld) ? round(instPctHeld, 1) : null,
        instIncreasing,
        instNetChange: round(instNetChange, 2),
        instHolderCount,
        fundamentalsStrong: (
          (latestEpsGrowth != null && latestEpsGrowth >= 25) || epsAccelerating === true
        ) && (
          latestRevGrowth != null && latestRevGrowth >= 10
        )
      };

      fundamentalCache.set(clean, { data, time: Date.now() });
      return data;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    const empty = {
      symbol: clean,
      fetchedAt: new Date().toISOString(),
      error: true,
      latestEpsGrowth: null,
      epsAccelerating: null,
      latestRevGrowth: null,
      revAccelerating: null,
      instPctHeld: null,
      instIncreasing: null,
      fundamentalsStrong: null
    };
    fundamentalCache.set(clean, { data: empty, time: Date.now() });
    return empty;
  }
}

async function fetchFundamentalsForUniverse(symbols) {
  const result = {};
  const excluded = new Set(["SPY","QQQ","DIA","IWM","XLK","XLF","XLV","XLY","XLI","XLE","XLP","XLU","XLB","XLRE","VIX","SMH","SOXX","IGV","CIBR","IHAK","XBI","IBB","KRE","KBE","XRT"]);
  const stocks = symbols.filter(s => !excluded.has(s));
  const BATCH = 5; // Small batches to avoid rate limiting
  for (let i = 0; i < stocks.length; i += BATCH) {
    const batch = stocks.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map(sym => fetchFundamentals(sym).then(d => ({ sym, d })))
    );
    for (const r of settled) {
      if (r.status === "fulfilled") result[r.value.sym] = r.value.d;
    }
    if (i + BATCH < stocks.length) await new Promise(r => setTimeout(r, 300));
  }
  return result;
}

// ─── Intraday RVOL ────────────────────────────────────────────────────────────
// Compares today's volume-so-far against the average for this time of day
// Uses 5-day 5-minute bars to build a time-of-day volume profile
// Only meaningful during market hours

const rvolCache = new Map();
const RVOL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchIntradayRVOL(symbol) {
  const clean = String(symbol || "").trim().toUpperCase();
  const cached = rvolCache.get(clean);
  if (cached && Date.now() - cached.time < RVOL_CACHE_TTL) return cached.rvol;

  try {
    // Get 5 days of 5-minute bars
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(clean)}?range=5d&interval=5m&includePrePost=false`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: YAHOO_HEADERS_FULL });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      const result = payload?.chart?.result?.[0];
      const quote = result?.indicators?.quote?.[0];
      if (!result?.timestamp || !quote) throw new Error("No intraday data");

      const bars = result.timestamp.map((ts, i) => ({
        ts, time: new Date(ts * 1000),
        volume: Number(quote.volume?.[i] || 0)
      })).filter(b => b.volume > 0);

      if (bars.length < 10) throw new Error("Too few bars");

      // Get current ET hour+minute
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false
      });
      const parts = fmt.formatToParts(new Date());
      const nowH = parseInt(parts.find(p => p.type === "hour")?.value || "10") % 24;
      const nowM = parseInt(parts.find(p => p.type === "minute")?.value || "0");
      const nowMins = nowH * 60 + nowM;

      // Today's volume so far (bars in last 24h)
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const todayBars = bars.filter(b => b.ts * 1000 > cutoff);
      const todayVol = todayBars.reduce((s, b) => s + b.volume, 0);

      // Historical bars at same time of day (prior 4 days)
      const priorDayBars = bars.filter(b => b.ts * 1000 <= cutoff);
      // Group by day, keep only bars up to same time as now
      const dayMap = new Map();
      for (const bar of priorDayBars) {
        const d = bar.time.toISOString().slice(0, 10);
        const barFmt = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false
        });
        const bp = barFmt.formatToParts(bar.time);
        const bh = parseInt(bp.find(p => p.type === "hour")?.value || "0") % 24;
        const bm = parseInt(bp.find(p => p.type === "minute")?.value || "0");
        if (bh * 60 + bm <= nowMins) {
          dayMap.set(d, (dayMap.get(d) || 0) + bar.volume);
        }
      }

      const priorVols = [...dayMap.values()].filter(v => v > 0);
      if (priorVols.length === 0) throw new Error("No prior day data");
      const avgPriorVol = priorVols.reduce((s, v) => s + v, 0) / priorVols.length;
      const rvol = avgPriorVol > 0 ? round(todayVol / avgPriorVol, 2) : null;

      const out = { rvol, todayVol, avgPriorVol: round(avgPriorVol), daysUsed: priorVols.length };
      rvolCache.set(clean, { rvol: out, time: Date.now() });
      return out;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    const out = { rvol: null, error: true };
    rvolCache.set(clean, { rvol: out, time: Date.now() });
    return out;
  }
}

module.exports = {
  DEFAULT_SYMBOLS, RANGE_FALLBACKS, getConfiguredSymbols,
  yahooBars, yahooBarsWithFallback, fetchUniverse,
  round, percentMove, dataQualityScore,
  fetchEarningsCalendar, fetchEarningsDate,
  fetchFundamentals, fetchFundamentalsForUniverse,
  fetchIntradayRVOL
};
