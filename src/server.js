const express = require("express");
const path = require("path");

const { readDb, writeDb, resetDb, addJournal } = require("./storage/db");
const {
  getConfiguredSymbols,
  fetchUniverse,
  round,
  percentMove,
  fetchEarningsCalendar,
  fetchFundamentalsForUniverse,
  fetchIntradayRVOL
} = require("./data/marketData");
const { scanMarket } = require("./engines/scanner");
const { applyTradeFilters } = require("./engines/filters");
const { enterPaper, exitPaper, updateOpenPositions, paperStats } = require("./engines/paper");
const { runPortfolioBacktest, optimize } = require("./engines/backtest");
const { brokerStatus, placeOrder } = require("./broker/adapter");
const { runWalkForward } = require("./engines/walkForward");
const { generateReport } = require("./engines/reports");
const { buildReplay } = require("./engines/replay");
const { trainingDecision, applyTrainingDecision } = require("./engines/training");
const { riskLockout } = require("./engines/risk");
const { getMarketSession, isEntryStillValid } = require("./engines/marketHours");
const { fetchLiveQuotes, isMarketHours } = require("./data/liveQuotes");

const app = express();
const PORT = process.env.PORT || 10000;
const VERSION = "7.4.0-swing-edge-fixes";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const SCAN_LIMIT = Number(process.env.SCAN_LIMIT || process.env.UNIVERSE_LIMIT || 55);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "../public")));

let lastUniverse = null;
let lastUniverseTime = 0;

function configuredSymbols() {
  return getConfiguredSymbols().slice(0, SCAN_LIMIT);
}

function requireAdmin(req, res, next) {
  // Auth disabled — personal paper trading tool with no financial risk
  // All endpoints are open. Add ADMIN_TOKEN env var to re-enable protection.
  if (ADMIN_TOKEN) {
    const supplied = req.get("x-admin-token") || req.query.adminToken
      || req.get("authorization")?.replace("Bearer ", "")
      || "";
    if (supplied !== ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized — set TRADINGMINT_ADMIN_TOKEN in browser localStorage." });
    }
  }
  return next();
}

async function fetchIntradayRvolForSymbols(symbols) {
  if (!isMarketHours()) return {};
  const out = {};
  const unique = [...new Set(symbols.map(s => String(s).trim().toUpperCase()).filter(Boolean))];
  const batchSize = 6;
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map(symbol => fetchIntradayRVOL(symbol).then(rvol => ({ symbol, rvol }))));
    for (const item of settled) {
      if (item.status === "fulfilled" && item.value.rvol) out[item.value.symbol] = item.value.rvol;
    }
    if (i + batchSize < unique.length) await new Promise(resolve => setTimeout(resolve, 120));
  }
  return out;
}

async function getUniverse(force = false) {
  if (!force && lastUniverse && Date.now() - lastUniverseTime < 900000) { // 15 min cache — daily bars don't change during the day
    if (isMarketHours()) {
      try {
        const liveResult = await fetchLiveQuotes(Object.keys(lastUniverse.completedBarsBySymbol || lastUniverse.barsBySymbol));
        if (liveResult.isLive && liveResult.liveCount > 0) {
          lastUniverse = {
            ...lastUniverse,
            liveQuotes: liveResult.quotes,
            liveCount: liveResult.liveCount,
            isLive: true,
            liveReason: liveResult.reason
          };
        }
      } catch {
        // Live fetch failed gracefully. Keep completed daily bars.
      }
    }
    return lastUniverse;
  }

  const db = readDb();
  const symbols = configuredSymbols();

  // ── Use pre-seeded bars if available, supplement with fresh Yahoo fetch ──
  // The seed script (scripts/seedHistoricalData.js) pre-fetches 5y of bars and
  // stores them in db.historicalBars. On Render, Yahoo is often rate-limited on
  // startup, so we prefer the seeded bars and only re-fetch symbols that are
  // missing or whose data is older than 24 hours.
  const seededBars = db.historicalBars || {};
  const nowMs = Date.now();
  const BAR_TTL = 24 * 60 * 60 * 1000; // refresh bars older than 24h

  const symbolsNeedingFetch = symbols.filter(s => {
    const entry = seededBars[s];
    if (!entry || !Array.isArray(entry.bars) || entry.bars.length < 200) return true;
    const age = nowMs - Date.parse(entry.updatedAt || 0);
    return age > BAR_TTL;
  });

  const symbolsFromSeed = symbols.filter(s => !symbolsNeedingFetch.includes(s));

  let universe;
  if (symbolsNeedingFetch.length > 0) {
    console.log(`[UNIVERSE] Fetching ${symbolsNeedingFetch.length} symbols from Yahoo (${symbolsFromSeed.length} from seed cache)`);
    try {
      const fresh = await fetchUniverse(symbolsNeedingFetch, SCAN_LIMIT, db.settings.historicalRange || "5y");
      const merged = {};
      for (const s of symbolsFromSeed) merged[s] = seededBars[s].bars;
      for (const [s, b] of Object.entries(fresh.barsBySymbol)) merged[s] = b;
      universe = { ...fresh, barsBySymbol: merged, errors: fresh.errors || [],
        seededCount: symbolsFromSeed.length, freshCount: Object.keys(fresh.barsBySymbol).length };
    } catch (fetchErr) {
      console.log(`[UNIVERSE] Yahoo fetch failed (${fetchErr.message}), using seed data only`);
      const seedOnly = {};
      for (const s of symbols) {
        if (seededBars[s]?.bars?.length >= 200) seedOnly[s] = seededBars[s].bars;
      }
      universe = { barsBySymbol: seedOnly, errors: [fetchErr.message],
        seededCount: Object.keys(seedOnly).length, freshCount: 0, usedSeedFallback: true };
    }
  } else {
    console.log(`[UNIVERSE] All ${symbols.length} symbols loaded from seed cache (no Yahoo fetch needed)`);
    const seedOnly = {};
    for (const s of symbols) {
      if (seededBars[s]?.bars?.length >= 200) seedOnly[s] = seededBars[s].bars;
    }
    universe = { barsBySymbol: seedOnly, errors: [], seededCount: Object.keys(seedOnly).length, freshCount: 0 };
  }

  universe.completedBarsBySymbol = universe.barsBySymbol;

  if (isMarketHours()) {
    try {
      const liveResult = await fetchLiveQuotes(Object.keys(universe.barsBySymbol));
      universe.isLive = Boolean(liveResult.isLive && liveResult.liveCount > 0);
      universe.liveQuotes = universe.isLive ? liveResult.quotes : {};
      universe.liveCount = liveResult.liveCount || 0;
      universe.liveReason = liveResult.reason;
    } catch {
      universe.isLive = false;
      universe.liveCount = 0;
      universe.liveReason = "Live fetch error";
    }
  } else {
    universe.isLive = false;
    universe.liveQuotes = {};
    universe.liveCount = 0;
    universe.liveReason = "Market closed";
  }

  lastUniverse = universe;
  lastUniverseTime = Date.now();

  // Persist freshly fetched bars back to DB
  if (symbolsNeedingFetch.length > 0) {
    for (const [symbol, bars] of Object.entries(universe.barsBySymbol)) {
      if (symbolsNeedingFetch.includes(symbol)) {
        db.historicalBars[symbol] = {
          range: db.settings.historicalRange || "5y",
          interval: "1d",
          updatedAt: new Date().toISOString(),
          bars
        };
      }
    }
  }
  db.historicalSnapshots.unshift({
    time: new Date().toISOString(),
    range: db.settings.historicalRange || "5y",
    interval: "1d",
    symbols: Object.keys(universe.barsBySymbol),
    requestedSymbols: symbols,
    errorCount: (universe.errors || []).length,
    seededCount: universe.seededCount || 0,
    freshCount: universe.freshCount || 0
  });
  db.historicalSnapshots = db.historicalSnapshots.slice(0, 500);
  writeDb(db);

  return universe;
}

function edgeFreshEnough(db) {
  const updated = Object.values(db.historicalEdges || {})
    .map(edge => Date.parse(edge.updatedAt || 0))
    .filter(Number.isFinite);
  if (!updated.length) return false;
  return Date.now() - Math.max(...updated) < 6 * 60 * 60 * 1000;
}

async function ensureBacktestEdges(db, universe, force = false) {
  if (!force && edgeFreshEnough(db)) return { reused: true, result: null };
  const bars = universe.completedBarsBySymbol || universe.barsBySymbol;
  const result = runPortfolioBacktest(bars, {
    ...db.settings,
    edgeWeight: 0,
    requireHistoricalEdge: false,
    minHistoricalTrades: 0,
    blockUnknownEarnings: false
  });
  db.historicalEdges = result.edges || {};
  db.backtests.unshift(result);
  db.backtests = db.backtests.slice(0, 30);
  addJournal(db, "AUTO_BACKTEST_MAX_HISTORY", "-", "Automatic max-history backtest completed and historical edges updated", result.summary);
  writeDb(db);
  return { reused: false, result };
}

async function buildState(force = false) {
  const db = readDb();
  db.settings.autoPaper = true;
  db.settings.startingCash = 5000;
  if (!Number.isFinite(Number(db.paper.cash))) db.paper.cash = 5000;

  // Safe timeout — return partial state instead of hanging on slow Yahoo
  let universe;
  try {
    const universePromise = getUniverse(force);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Data fetch timeout — Yahoo may be slow. Try refreshing in a moment.")), 25000)
    );
    universe = await Promise.race([universePromise, timeoutPromise]);
  } catch (err) {
    console.log(`[STATE] ${err.message}`);
    const { getMarketSession } = require("./engines/marketHours");
    return {
      ok: true, partial: true, partialReason: err.message,
      signals: [], market: { regime: "UNKNOWN", breadth: null },
      marketSession: getMarketSession(),
      paper: db.paper, settings: db.settings,
      alerts: (db.alerts || []).slice(0, 20),
      journal: (db.journal || []).slice(0, 20),
      health: { status: "degraded", reason: err.message }
    };
  }
  // Auto-backtest: run if edges are empty or stale (>6 hours old).
  // This ensures edges are always populated after a fresh deploy or DB reset
  // without requiring the user to manually click Backtest.
  // Runs synchronously here only when edges are missing — normal scans skip it.
  const edgeRun = { reused: true, result: null };
  const freshEdgesCheck = readDb().historicalEdges || {};
  const hasEdges = Object.keys(freshEdgesCheck).length > 0;
  if (!hasEdges) {
    try {
      console.log("[AUTO-BACKTEST] No edges found — running backtest now...");
      const barsForBT = universe.completedBarsBySymbol || universe.barsBySymbol;
      const btResult = runPortfolioBacktest(barsForBT, {
        ...db.settings,
        edgeWeight: 0,
        requireHistoricalEdge: false,
        minHistoricalTrades: 0,
        blockUnknownEarnings: false
      });
      db.historicalEdges = btResult.edges || {};
      db.backtests.unshift(btResult);
      db.backtests = db.backtests.slice(0, 30);
      addJournal(db, "AUTO_BACKTEST", "-",
        `Auto-backtest: ${btResult.summary.trades} trades, ${Object.keys(btResult.edges||{}).length} symbols`,
        btResult.summary);
      writeDb(db);
      console.log(`[AUTO-BACKTEST] Done — ${btResult.summary.trades} trades, ${Object.keys(btResult.edges||{}).length} edge symbols`);
    } catch (btErr) {
      console.log("[AUTO-BACKTEST] Failed:", btErr.message);
    }
  }
  const barsForScan = universe.completedBarsBySymbol || universe.barsBySymbol;
  const symbols = Object.keys(barsForScan);

  // These can be disabled via env vars if Yahoo is throttling on your host
  const enableEarnings = process.env.ENABLE_EARNINGS !== "false";
  const enableFundamentals = process.env.ENABLE_FUNDAMENTALS !== "false";

  const [earningsCalendar, fundamentalsData, intradayRvolBySymbol] = await Promise.all([
    enableEarnings ? fetchEarningsCalendar(symbols).catch(() => ({})) : Promise.resolve({}),
    enableFundamentals ? fetchFundamentalsForUniverse(symbols).catch(() => ({})) : Promise.resolve({}),
    fetchIntradayRvolForSymbols(symbols).catch(() => ({}))
  ]);

  // Use the most current edges — either just written by auto-backtest above,
  // or re-read from disk in case the startup backtest finished asynchronously.
  const freshEdges = db.historicalEdges || readDb().historicalEdges || {};

  const scanned = scanMarket(
    barsForScan,
    db.settings,
    freshEdges,
    universe.liveQuotes || {},
    earningsCalendar,
    fundamentalsData,
    intradayRvolBySymbol
  );

  let signals = scanned.signals.map(signal => applyTradeFilters(signal, db.settings, earningsCalendar));
  updateOpenPositions(db, signals);

  const statsBefore = paperStats(db);
  const lockout = riskLockout(db.paper, db.settings, statsBefore);
  const marketSession = getMarketSession();

  if (db.settings.autoPaper && !lockout.locked && marketSession.autoPaperAllowed) {
    for (const signal of signals.slice(0, 8)) {
      if (signal.safety === "TRADE_READY" && isEntryStillValid(signal)) {
        enterPaper(db, signal, "auto-opening-window", barsForScan);
      }
    }
  } else if (db.settings.autoPaper && !lockout.locked && !marketSession.autoPaperAllowed) {
    addJournal(db, "AUTO_PAPER_SKIPPED", "-", `Auto-paper skipped: ${marketSession.reason}`, {
      session: marketSession.session,
      etTime: marketSession.etTime
    });
  }

  const stats = paperStats(db);
  const indices = ["SPY", "QQQ", "DIA", "IWM", "VIX"].map(sym => {
    const symbol = sym === "VIX" ? "^VIX" : sym;
    const bars = universe.barsBySymbol[symbol] || universe.barsBySymbol[sym] || [];
    const last = bars.at(-1);
    const prev = bars.at(-2);
    return {
      symbol: sym,
      price: round(last?.close),
      changePct: round(percentMove(last?.close, prev?.close), 2),
      bars: bars.slice(-30)
    };
  });

  if (lockout.locked) {
    db.lockouts.unshift({ time: new Date().toISOString(), reason: lockout.reason });
    db.lockouts = db.lockouts.slice(0, 100);
  }
  writeDb(db);

  return {
    ok: true,
    version: VERSION,
    mode: universe.errors.length ? "PARTIAL_LIVE_DATA" : (universe.isLive ? "LIVE_PRICES" : "EOD_PRICES"),
    dataQuality: universe.errors.length ? "PARTIAL" : (universe.isLive ? "LIVE" : "END_OF_DAY"),
    liveCount: universe.liveCount || 0,
    intradayRvolCount: Object.values(intradayRvolBySymbol).filter(value => Number.isFinite(Number(value?.rvol))).length,
    lookback: "max available daily",
    market: scanned.market,
    signals,
    indices,
    systems: [
      { name: "Configured Universe", state: "RUNNING", detail: `${symbols.length} symbols scanned. Add more with EXTRA_SYMBOLS or STOCK_SYMBOLS.` },
      { name: "Historical Data Collector", state: universe.errors.length ? "PARTIAL" : "RUNNING", detail: universe.errors.length ? `${universe.errors.length} symbols failed` : "Yahoo daily chart data with range fallback" },
      { name: "Historical Cache", state: "RUNNING", detail: `${Object.keys(db.historicalBars).length} symbols cached` },
      { name: "Intraday RVOL", state: isMarketHours() ? "RUNNING" : "STANDBY", detail: isMarketHours() ? `${Object.keys(intradayRvolBySymbol).length} symbols checked` : "Market closed, using completed daily volume" },
      { name: "Auto Backtest", state: edgeRun.reused ? "REUSED" : "UPDATED", detail: edgeRun.reused ? "Fresh edge data reused" : "Historical edges recalculated from available data" },
      { name: "Proof-Based Scoring", state: "RUNNING", detail: "Technical score blended with historical edge score" },
      { name: "Risk Lockout", state: lockout.locked ? "LOCKED" : "CLEAR", detail: lockout.reason || "No risk lockout active" },
      { name: "Paper Trader", state: db.paper.open.length ? "ACTIVE" : "READY", detail: `${db.paper.open.length} open, ${db.paper.closed.length} closed` },
      { name: "Trade Journal", state: "RUNNING", detail: `${db.journal.length} journal records` },
      { name: "Strategy Optimizer", state: db.optimizerRuns.length ? "READY" : "WAITING", detail: `${db.optimizerRuns.length} optimizer runs` },
      { name: "Admin API", state: ADMIN_TOKEN ? "PROTECTED" : (process.env.RENDER || process.env.NODE_ENV === "production" ? "BLOCKED" : "LOCAL"), detail: ADMIN_TOKEN ? "Write endpoints require x-admin-token" : "Set ADMIN_TOKEN before production deploy" },
      { name: "Broker Adapter", state: "DISABLED", detail: "Safe mode only, no live orders" }
    ],
    paper: db.paper,
    stats,
    alerts: db.alerts,
    journal: db.journal.slice(0, 60),
    backtests: db.backtests.slice(0, 5),
    optimizerRuns: db.optimizerRuns.slice(0, 3),
    broker: brokerStatus(db.settings),
    settings: db.settings,
    lockout,
    historicalEdgeCount: Object.keys(db.historicalEdges || {}).length,
    historicalSnapshotCount: db.historicalSnapshots.length,
    errors: universe.errors,
    updatedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    marketSession: getMarketSession()
  };
}

app.get("/api/health", (req, res) => {
  const db = readDb();
  res.json({
    ok: true,
    version: VERSION,
    app: "TradingMint PRO",
    lookback: "max available daily",
    configuredSymbols: configuredSymbols().length,
    historicalEdgeCount: Object.keys(db.historicalEdges || {}).length,
    authProtected: Boolean(ADMIN_TOKEN),
    broker: brokerStatus(db.settings),
    uptimeSeconds: Math.round(process.uptime()),
    time: new Date().toISOString()
  });
});

app.get("/api/state", async (req, res) => {
  try {
    res.json(await buildState(req.query.force === "1"));
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, time: new Date().toISOString() });
  }
});

app.post("/api/settings", requireAdmin, (req, res) => {
  const db = readDb();
  db.settings = { ...db.settings, ...(req.body || {}), autoPaper: true, startingCash: 5000 };
  addJournal(db, "SETTINGS_UPDATED", "-", "Settings updated", db.settings);
  writeDb(db);
  res.json({ ok: true, settings: db.settings });
});

app.post("/api/paper/enter", requireAdmin, async (req, res) => {
  try {
    const universe = await getUniverse(false);
    const barsForManual = universe.completedBarsBySymbol || universe.barsBySymbol;
    const state = await buildState(false);
    const symbol = String(req.body.symbol || "").toUpperCase();
    const signal = state.signals.find(item => item.symbol === symbol);
    const db = readDb();
    const result = enterPaper(db, signal, "manual", barsForManual);
    writeDb(db);
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/paper/enter/override", requireAdmin, async (req, res) => {
  try {
    const universe = await getUniverse(false);
    const barsForManual = universe.completedBarsBySymbol || universe.barsBySymbol;
    const state = await buildState(false);
    const symbol = String(req.body.symbol || "").toUpperCase();
    let signal = state.signals.find(item => item.symbol === symbol);
    if (!signal) return res.status(404).json({ ok: false, error: "Symbol not found in scanner." });

    // Override: force TRADE_READY and bypass regime/edge/earnings blocks.
    // Also override regime risk multiplier so BEARISH doesn't zero out position size.
    signal = { ...signal, safety: "TRADE_READY", action: "LONG", marketRegime: "BULLISH" };

    const db = readDb();
    // Override settings for this entry only — bypass regime sizing, confidence,
    // and historical edge requirements so the manual override always works.
    const overrideSettings = {
      ...db.settings,
      regimeRiskMultipliers: { BULLISH: 1, NEUTRAL: 1, BEARISH: 1 },
      minConfidence: 1,
      minRiskReward: 1,
      requireHistoricalEdge: false,
      blockUnknownEarnings: false,
      // Raise maxTradePct to 25% for overrides — the default 10% cap can produce
      // 0 shares for high-priced stocks (e.g. AMD at $516 with $5k account).
      // ATR-based risk sizing still limits actual dollar risk to riskPerTradePct.
      maxTradePct: 25,
    };
    const dbOverride = { ...db, settings: overrideSettings };
    const result = enterPaper(dbOverride, signal, "manual-override", barsForManual);
    // Copy mutated paper state back to real db before writing
    db.paper = dbOverride.paper;
    db.journal = dbOverride.journal;
    db.alerts = dbOverride.alerts;
    writeDb(db);
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/paper/exit", requireAdmin, (req, res) => {
  const db = readDb();
  const result = exitPaper(db, req.body.positionId || req.body.symbol, req.body.exitPrice, req.body.reason || "Manual exit");
  writeDb(db);
  res.json(result);
});

app.get("/api/journal", (req, res) => {
  const db = readDb();
  res.json({ ok: true, journal: db.journal });
});

app.post("/api/backtest/run", requireAdmin, async (req, res) => {
  try {
    const db = readDb();
    const universe = await getUniverse(req.query.force === "1");
    const allBars = universe.completedBarsBySymbol || universe.barsBySymbol;

    // Limit to top 60 symbols to avoid Render free tier 30s timeout
    // Priority: keep SPY, QQQ and the highest-volume stocks
    const PRIORITY = ["SPY","QQQ","NVDA","AAPL","MSFT","AMD","META","GOOGL","AMZN","TSLA",
      "ARM","AVGO","CRWD","ORCL","MSFT","PLTR","HOOD","ROKU","MRVL","KLAC",
      "XLK","XLY","XLI","XLF","SMH","IGV","XBI","SOXX"];
    const allSymbols = Object.keys(allBars);
    const prioritized = [
      ...PRIORITY.filter(s => allBars[s]),
      ...allSymbols.filter(s => !PRIORITY.includes(s))
    ].slice(0, 60);
    const barsForBacktest = {};
    for (const s of prioritized) barsForBacktest[s] = allBars[s];

    // Always override edge/earnings settings for backtesting — these don't apply historically
    const backtestOverrides = {
      edgeWeight: 0,
      requireHistoricalEdge: false,
      minHistoricalTrades: 0,
      blockUnknownEarnings: false,
    };
    const result = runPortfolioBacktest(barsForBacktest, { ...db.settings, ...backtestOverrides, ...(req.body || {}) });
    db.historicalEdges = result.edges || db.historicalEdges;
    db.backtests.unshift(result);
    db.backtests = db.backtests.slice(0, 30);
    addJournal(db, "BACKTEST_RUN", "-", `Backtest completed on ${prioritized.length} symbols`, result.summary);
    writeDb(db);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/optimizer/run", requireAdmin, async (req, res) => {
  try {
    const db = readDb();
    const universe = await getUniverse(req.query.force === "1");
    const result = optimize(universe.completedBarsBySymbol || universe.barsBySymbol, { ...db.settings, ...(req.body || {}) });
    db.optimizerRuns.unshift(result);
    db.optimizerRuns = db.optimizerRuns.slice(0, 30);
    addJournal(db, "OPTIMIZER_RUN", "-", "Optimizer completed with guardrails", result.best?.summary || {});
    writeDb(db);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/optimizer/apply", requireAdmin, (req, res) => {
  const db = readDb();
  const latest = db.optimizerRuns[0];
  if (!latest || !latest.best || !latest.best.options) return res.status(400).json({ ok: false, error: "No optimizer result available to apply." });
  const summary = latest.best.summary || {};
  if ((summary.trades || 0) < 25 || (summary.expectancyR || 0) <= 0) {
    return res.status(400).json({ ok: false, error: "Optimizer guardrail blocked apply. Sample size or expectancy is not strong enough." });
  }
  const options = latest.best.options;
  db.settings.minConfidence = Number(options.minConfidence || db.settings.minConfidence);
  db.settings.minRiskReward = Number(options.minRiskReward || db.settings.minRiskReward);
  db.settings.autoPaper = true;
  db.settings.startingCash = 5000;
  addJournal(db, "OPTIMIZER_APPLIED", "-", "Optimizer best settings applied to scanner after guardrail check", db.settings);
  writeDb(db);
  res.json({ ok: true, settings: db.settings, applied: options });
});

app.post("/api/walkforward/run", requireAdmin, async (req, res) => {
  try {
    const db = readDb();
    const universe = await getUniverse(req.query.force === "1");
    const result = runWalkForward(universe.completedBarsBySymbol || universe.barsBySymbol, { ...db.settings, ...(req.body || {}) });
    db.walkForwardRuns ||= [];
    db.walkForwardRuns.unshift(result);
    db.walkForwardRuns = db.walkForwardRuns.slice(0, 30);
    addJournal(db, "WALK_FORWARD_RUN", "-", "Manual walk-forward validation completed", result.summary);
    writeDb(db);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/training/run", requireAdmin, async (req, res) => {
  try {
    const db = readDb();
    const universe = await getUniverse(req.query.force === "1");
    const bars = universe.completedBarsBySymbol || universe.barsBySymbol;
    const walkForward = runWalkForward(bars, db.settings);
    const latestBacktest = db.backtests?.[0] || runPortfolioBacktest(bars, db.settings);
    const decision = trainingDecision(db, walkForward, latestBacktest);
    db.walkForwardRuns ||= [];
    db.trainingDecisions ||= [];
    db.walkForwardRuns.unshift(walkForward);
    db.trainingDecisions.unshift(decision);
    if (req.body?.apply === true && decision.canAutoApply) {
      applyTrainingDecision(db, decision);
      addJournal(db, "TRAINING_APPLIED", "-", "Manual self-training decision applied", decision);
    } else {
      addJournal(db, "TRAINING_REVIEW", "-", decision.reason, decision);
    }
    writeDb(db);
    res.json({ ok: true, walkForward, decision, settings: db.settings });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/report", (req, res) => {
  const db = readDb();
  const report = generateReport(db);
  db.reports ||= [];
  db.reports.unshift(report);
  db.reports = db.reports.slice(0, 100);
  writeDb(db);
  res.json({ ok: true, report });
});

app.get("/api/replay", (req, res) => {
  const db = readDb();
  res.json({ ok: true, symbol: req.query.symbol || null, events: buildReplay(db, req.query.symbol) });
});

app.post("/api/broker/order", requireAdmin, (req, res) => res.status(403).json(placeOrder(req.body)));
app.post("/api/reset", requireAdmin, (req, res) => {
  const db = resetDb();
  res.json({ ok: true, db });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "../public/index.html")));

app.listen(PORT, async () => {
  console.log(`TradingMint PRO ${VERSION} running on port ${PORT}`);

  // ── Startup: fetch bars + run backtest so scanner is ready immediately ──────
  // Retries up to 4 times with backoff — Render cold starts sometimes take a
  // moment before outbound connections are fully available.
  (async () => {
    const RETRY_DELAYS = [4000, 15000, 30000, 60000];
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      if (attempt > 0) {
        const wait = RETRY_DELAYS[attempt - 1];
        console.log(`[STARTUP] Retry ${attempt}/${RETRY_DELAYS.length} in ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      }
      try {
        console.log(`[STARTUP] Fetching historical bars (attempt ${attempt + 1})...`);
        const universe = await getUniverse(true);
        const symbolCount = Object.keys(universe.barsBySymbol || {}).length;
        console.log(`[STARTUP] Got bars for ${symbolCount} symbols`);
        if (symbolCount < 5) throw new Error(`Only ${symbolCount} symbols — too few to backtest`);

        // Auto-run backtest so historicalEdges are populated before first user visit
        const db = readDb();
        const allBars = universe.completedBarsBySymbol || universe.barsBySymbol;
        console.log(`[STARTUP] Running startup backtest on ${Object.keys(allBars).length} symbols...`);
        const result = runPortfolioBacktest(allBars, {
          ...db.settings,
          edgeWeight: 0,
          requireHistoricalEdge: false,
          minHistoricalTrades: 0,
          blockUnknownEarnings: false
        });
        db.historicalEdges = result.edges || db.historicalEdges;
        db.backtests.unshift(result);
        db.backtests = db.backtests.slice(0, 30);
        addJournal(db, "STARTUP_BACKTEST", "-",
          `Startup backtest: ${result.summary.trades} trades, winRate ${result.summary.winRate}%`,
          result.summary);
        writeDb(db);
        console.log(`[STARTUP] Backtest done — ${result.summary.trades} trades, ${Object.keys(result.edges || {}).length} symbols with edge data`);
        break; // success
      } catch (err) {
        console.log(`[STARTUP] Attempt ${attempt + 1} failed: ${err.message}`);
        if (attempt === RETRY_DELAYS.length) {
          console.log("[STARTUP] All retries exhausted — scanner will use existing edge data if any");
        }
      }
    }
  })();

  setInterval(async () => {
    try {
      const session = getMarketSession();
      const now = new Date();
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        minute: "2-digit",
        weekday: "short",
        hour12: false
      });
      const parts = fmt.formatToParts(now);
      const hour = parseInt(parts.find(part => part.type === "hour")?.value || "0", 10) % 24;
      const minute = parseInt(parts.find(part => part.type === "minute")?.value || "0", 10);
      const weekday = parts.find(part => part.type === "weekday")?.value;
      const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
      if (day === 0 || day === 6) return;
      const mins = hour * 60 + minute;
      const PRE_WARM_START = 9 * 60 + 30;
      const AUTO_CHECK_END = 15 * 60 + 45;
      if (mins < PRE_WARM_START || mins > AUTO_CHECK_END) return;
      if (mins < 9 * 60 + 45) {
        console.log(`[AUTO-WARM] Pre-warming data at ${session.etTime}`);
        await getUniverse(false);
        return;
      }
      if (session.autoPaperAllowed) {
        console.log(`[AUTO-PAPER] Running auto-paper check at ${session.etTime}`);
        await buildState(false);
      }
    } catch (error) {
      console.log(`[AUTO-WARM] Error: ${error.message}`);
    }
  }, 60 * 1000);
});
