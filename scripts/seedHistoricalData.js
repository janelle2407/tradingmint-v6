#!/usr/bin/env node
// ─── TradingMint PRO — Historical Data Seeder ────────────────────────────────
// Run this script ONCE on your local machine before deploying to Render.
// It fetches 5 years of daily OHLCV bars from Yahoo Finance for every symbol,
// runs the portfolio backtest to populate historicalEdges, and writes a
// pre-seeded tradingmint-db.json that you include in your deployment.
//
// Usage:
//   node scripts/seedHistoricalData.js
//
// Output:
//   data/tradingmint-db.json   ← commit this file, Render will use it on deploy
//
// Requirements: Node 18+, internet access, ~2-3 minutes to run.
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require("fs");
const path = require("path");

// ── Config ────────────────────────────────────────────────────────────────────
const RANGE           = "5y";       // 5 years of daily bars
const INTERVAL        = "1d";
const BATCH_SIZE      = 4;          // parallel fetches per batch (be gentle with Yahoo)
const DELAY_MS        = 600;        // ms between batches
const TIMEOUT_MS      = 12000;      // per-symbol fetch timeout
const MIN_BARS        = 200;        // skip symbol if fewer bars returned
const OUT_PATH        = path.join(__dirname, "../data/tradingmint-db.json");

const SYMBOLS = [
  // Market ETFs — required for regime detection
  "SPY", "QQQ", "IWM",
  // Sector ETFs
  "XLK", "XLF", "XLV", "XLY", "XLI", "XLE", "SMH", "IGV", "XBI", "CIBR",
  // Mega cap tech
  "NVDA", "AAPL", "MSFT", "META", "GOOGL", "AMZN", "TSLA",
  // Semiconductors
  "AVGO", "AMD", "ARM", "MRVL", "KLAC", "LRCX", "QCOM", "MU", "ON",
  // Software & cloud
  "CRWD", "ORCL", "NOW", "PANW", "SNOW", "NET", "DDOG", "ZS", "FTNT", "OKTA", "TTD",
  // Growth leaders
  "PLTR", "APP", "HOOD", "RBLX", "COIN", "MSTR", "SHOP", "MELI",
  // High-momentum mid-caps
  "AXON", "DUOL", "HIMS", "CELH", "ASTS", "LUNR", "RXRX",
  // Healthcare
  "LLY", "NVO", "ISRG", "VRTX", "REGN", "ABBV",
  // Financials
  "JPM", "GS", "BAC", "SCHW", "KKR",
  // Industrials
  "CAT", "DE", "VRT", "PWR", "FAST",
  // Consumer & retail
  "COST", "CAVA", "ELF", "WING",
  // Other
  "NFLX", "UBER", "ANET", "GE", "TSM", "ASML", "SPOT", "DASH"
];

// ── Yahoo Finance fetcher ─────────────────────────────────────────────────────
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://finance.yahoo.com",
  "Referer": "https://finance.yahoo.com/"
};

async function fetchBars(symbol, range = RANGE) {
  const clean = symbol.trim().toUpperCase();
  const endpoints = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(clean)}?range=${range}&interval=${INTERVAL}&includePrePost=false`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(clean)}?range=${range}&interval=${INTERVAL}&includePrePost=false`,
  ];

  for (const url of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: HEADERS });
      clearTimeout(timer);
      if (!res.ok) continue;
      const payload = await res.json();
      const result = payload?.chart?.result?.[0];
      const quote  = result?.indicators?.quote?.[0];
      if (!result?.timestamp || !quote) continue;

      const bars = result.timestamp.map((ts, i) => ({
        date:   new Date(ts * 1000).toISOString().slice(0, 10),
        open:   Number(quote.open?.[i]),
        high:   Number(quote.high?.[i]),
        low:    Number(quote.low?.[i]),
        close:  Number(quote.close?.[i]),
        volume: Number(quote.volume?.[i] || 0),
      })).filter(b =>
        Number.isFinite(b.open) && Number.isFinite(b.close) &&
        b.close > 0 && b.high >= b.low
      );

      if (bars.length < MIN_BARS) {
        console.warn(`  ⚠  ${clean}: only ${bars.length} bars — skipping`);
        return null;
      }
      return bars;
    } catch (e) {
      clearTimeout(timer);
      // try next endpoint
    }
  }
  console.warn(`  ✗  ${clean}: all endpoints failed`);
  return null;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log(" TradingMint PRO — Historical Data Seeder");
  console.log(`  Fetching ${SYMBOLS.length} symbols × ${RANGE} daily bars`);
  console.log("═══════════════════════════════════════════════════\n");

  // Ensure output directory exists
  const dir = path.dirname(OUT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // ── Step 1: Fetch bars ─────────────────────────────────────────────────────
  const barsBySymbol = {};
  const errors = [];
  let done = 0;

  for (let i = 0; i < SYMBOLS.length; i += BATCH_SIZE) {
    const batch = SYMBOLS.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(s => fetchBars(s)));

    for (let j = 0; j < batch.length; j++) {
      const symbol = batch[j];
      const r = results[j];
      done++;
      if (r.status === "fulfilled" && r.value) {
        barsBySymbol[symbol] = r.value;
        const last = r.value.at(-1);
        console.log(`  ✓  ${String(symbol).padEnd(6)} ${r.value.length} bars  (${r.value[0].date} → ${last.date})`);
      } else {
        errors.push(symbol);
        console.log(`  ✗  ${symbol}: failed`);
      }
    }

    if (i + BATCH_SIZE < SYMBOLS.length) {
      process.stdout.write(`\n  [${done}/${SYMBOLS.length}] fetched — pausing ${DELAY_MS}ms...\n\n`);
      await sleep(DELAY_MS);
    }
  }

  const succeeded = Object.keys(barsBySymbol).length;
  console.log(`\n  Fetch complete: ${succeeded}/${SYMBOLS.length} symbols`);
  if (errors.length) console.log(`  Failed: ${errors.join(", ")}`);

  if (succeeded < 10) {
    console.error("\n  ✗  Too few symbols fetched. Check your internet connection and try again.");
    process.exit(1);
  }

  // ── Step 2: Run backtest to populate historicalEdges ──────────────────────
  console.log("\n  Running portfolio backtest to build historical edges...");
  const { runPortfolioBacktest } = require("../src/engines/backtest");

  const settings = {
    minConfidence: 72,
    minRiskReward: 2.0,
    requireHistoricalEdge: false,
    minHistoricalTrades: 0,
    minHistoricalExpectancyR: -999,
    minHistoricalProfitFactor: 0,
    slippagePct: 0.05,
    spreadPct: 0.03,
    maxOpenPositions: 4,
    maxDailyEntries: 2,
    maxSameSectorOpen: 2,
    edgeWeight: 0,
    blockUnknownEarnings: false,
    earningsBlockDays: 5,
    regimeRiskMultipliers: { BULLISH: 1, NEUTRAL: 0.5, BEARISH: 0 }
  };

  let backtestResult;
  try {
    backtestResult = runPortfolioBacktest(barsBySymbol, settings);
    const s = backtestResult.summary;
    console.log(`  ✓  Backtest done:`);
    console.log(`       Trades:        ${s.trades}`);
    console.log(`       Win rate:      ${s.winRate ?? "--"}%`);
    console.log(`       Expectancy R:  ${s.expectancyR ?? "--"}`);
    console.log(`       Profit factor: ${s.profitFactor ?? "--"}`);
    console.log(`       Symbols with edge data: ${Object.keys(backtestResult.edges || {}).length}`);
  } catch (e) {
    console.error("  ✗  Backtest failed:", e.message);
    backtestResult = { summary: {}, trades: [], edges: {} };
  }

  // ── Step 3: Build the pre-seeded DB ───────────────────────────────────────
  console.log("\n  Building pre-seeded database...");

  const now = new Date().toISOString();

  // Load existing DB if it exists, otherwise start fresh
  let existingDb = {};
  if (fs.existsSync(OUT_PATH)) {
    try {
      existingDb = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
      console.log("  (merging into existing DB)");
    } catch {
      console.log("  (existing DB unreadable — starting fresh)");
    }
  }

  const db = {
    version: "7.4.0",
    createdAt: existingDb.createdAt || now,
    seededAt: now,
    seededSymbols: Object.keys(barsBySymbol),
    seededBarCounts: Object.fromEntries(
      Object.entries(barsBySymbol).map(([s, b]) => [s, b.length])
    ),

    settings: {
      // Defaults — these will be merged with mergeDefaults() on first read
      startingCash: 5000,
      autoPaper: true,
      maxOpenPositions: 4,
      maxDailyEntries: 2,
      maxTradePct: 10,
      riskPerTradePct: 1,
      minConfidence: 78,
      minRiskReward: 2.0,
      minHistoricalTrades: 10,
      minHistoricalExpectancyR: 0.1,
      minHistoricalProfitFactor: 1.1,
      slippagePct: 0.05,
      spreadPct: 0.03,
      commissionPerTrade: 0,
      blockUnknownEarnings: true,
      earningsBlockDays: 5,
      maxDailyLossPct: 2,
      maxDrawdownPct: 10,
      requireHistoricalEdge: true,
      historicalRange: "5y",
      minHistoricalBars: 750,
      minHistoricalYearsPreferred: 5,
      edgeWeight: 0.45,
      technicalWeight: 0.55,
      maxSameSectorOpen: 2,
      maxCorrelation: 0.78,
      autoTraining: true,
      walkForwardAuto: true,
      trainingAutoApply: false,
      brokerMode: "disabled",
      regimeRiskMultipliers: { BULLISH: 1, NEUTRAL: 0.5, BEARISH: 0 },
      ...((existingDb.settings) || {})
    },

    paper: existingDb.paper || { cash: 5000, open: [], closed: [] },
    journal: existingDb.journal || [],
    alerts: existingDb.alerts || [],

    // Pre-seeded historical bars
    historicalBars: Object.fromEntries(
      Object.entries(barsBySymbol).map(([symbol, bars]) => [
        symbol,
        {
          range: RANGE,
          interval: INTERVAL,
          seededAt: now,
          updatedAt: now,
          barCount: bars.length,
          firstDate: bars[0]?.date,
          lastDate:  bars.at(-1)?.date,
          bars
        }
      ])
    ),

    historicalMeta: Object.fromEntries(
      Object.entries(barsBySymbol).map(([symbol, bars]) => [
        symbol,
        {
          range: RANGE,
          interval: INTERVAL,
          barCount: bars.length,
          firstDate: bars[0]?.date,
          lastDate:  bars.at(-1)?.date,
          seededAt:  now
        }
      ])
    ),

    // Pre-seeded backtest edges — scanner uses these immediately
    historicalEdges: Object.fromEntries(
      Object.entries(backtestResult.edges || {}).map(([symbol, edge]) => [
        symbol,
        { ...edge, updatedAt: now, seededAt: now }
      ])
    ),

    historicalSnapshots: [{
      time: now,
      range: RANGE,
      interval: INTERVAL,
      symbols: Object.keys(barsBySymbol),
      requestedSymbols: SYMBOLS,
      errorCount: errors.length,
      seeded: true
    }],

    backtests: backtestResult.summary?.trades > 0
      ? [{ ...backtestResult, createdAt: now, seeded: true }]
      : [],

    optimizerRuns: [],
    lockouts: [],
    trainingDecisions: [],
    reports: [],
    walkForwardRuns: [],
  };

  // ── Step 4: Write the file ─────────────────────────────────────────────────
  fs.writeFileSync(OUT_PATH, JSON.stringify(db, null, 2));
  const sizeKB = Math.round(fs.statSync(OUT_PATH).size / 1024);

  console.log(`\n  ✓  Saved: ${OUT_PATH}`);
  console.log(`     Size: ${sizeKB} KB`);
  console.log(`     Symbols with bars: ${succeeded}`);
  console.log(`     Symbols with edge data: ${Object.keys(db.historicalEdges).length}`);
  console.log(`     Backtest trades: ${backtestResult.summary?.trades ?? 0}`);

  console.log("\n═══════════════════════════════════════════════════");
  console.log(" DONE. Next steps:");
  console.log("  1. Commit data/tradingmint-db.json to your repo");
  console.log("  2. Deploy to Render — the app will use the seeded data immediately");
  console.log("  3. The scanner will show real scores right away (no backtest needed)");
  console.log("  4. Re-run this script monthly to refresh the data");
  console.log("═══════════════════════════════════════════════════\n");
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
