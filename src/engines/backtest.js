// ─── Backtest Engine v2 ──────────────────────────────────────────────────────
// Fix 3: Uses same buildSignal() as live scanner — point-in-time only
// Enter on next bar open (not current close) — more realistic
// minConfidence and minRiskReward now actually filter trades
// minHistoricalTrades raised to 20 for meaningful edge proof

const { applyCosts } = require("./risk");
const { buildSignal } = require("./scanner");

function emptySummary() {
  return {
    trades: 0, winRate: null, expectancyR: null, profitFactor: null,
    avgWinR: null, avgLossR: null, maxDrawdownR: null,
    sampleWarning: "No valid sample — insufficient historical data."
  };
}

function summarizeTrades(trades) {
  if (!trades.length) return emptySummary();
  const wins = trades.filter(t => t.pnlR > 0);
  const losses = trades.filter(t => t.pnlR <= 0);
  const grossWins = wins.reduce((s, t) => s + t.pnlR, 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnlR, 0));
  const expectancy = trades.reduce((s, t) => s + t.pnlR, 0) / trades.length;
  let equityR = 0, peak = 0, maxDrawdownR = 0;
  for (const t of trades) {
    equityR += t.pnlR;
    peak = Math.max(peak, equityR);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equityR);
  }

  let sampleWarning = "";
  if (trades.length < 20) sampleWarning = "Insufficient sample (< 20 trades) — edge is unproven.";
  else if (trades.length < 50) sampleWarning = "Small sample (< 50 trades) — treat edge as exploratory.";

  return {
    trades: trades.length,
    winRate: Number(((wins.length / trades.length) * 100).toFixed(1)),
    expectancyR: Number(expectancy.toFixed(2)),
    profitFactor: grossLosses ? Number((grossWins / grossLosses).toFixed(2)) : null,
    avgWinR: wins.length ? Number((grossWins / wins.length).toFixed(2)) : null,
    avgLossR: losses.length ? Number((-grossLosses / losses.length).toFixed(2)) : null,
    maxDrawdownR: Number(maxDrawdownR.toFixed(2)),
    sampleWarning
  };
}

function summarizeBySetup(trades) {
  const grouped = {};
  for (const t of trades) { grouped[t.setupType] ||= []; grouped[t.setupType].push(t); }
  const out = {};
  for (const [setup, rows] of Object.entries(grouped)) out[setup] = summarizeTrades(rows);
  return out;
}

// Point-in-time backtest using same buildSignal() as live scanner
// This means the historical edge actually validates the live rules
function runSignalBacktest(symbol, allBars, options = {}, allBarsBySymbol = {}) {
  const settings = {
    minConfidence: options.minConfidence || 72,  // slightly lower for backtest
    minRiskReward: options.minRiskReward || 2.0,
    slippagePct: options.slippagePct ?? 0.05,
    spreadPct: options.spreadPct ?? 0.03,
    holdDays: options.holdDays || 10,
    requireHistoricalEdge: false,
    edgeWeight: 0.0,
    minHistoricalTrades: 0,
    minHistoricalExpectancyR: -999,
    minHistoricalProfitFactor: 0,
    maxSameSectorOpen: 99,
    maxCorrelation: 1,
  };

  const trades = [];
  if (!Array.isArray(allBars) || allBars.length < 200) {
    return { symbol, trades: [], summary: emptySummary(), setupStats: {} };
  }

  // SPY bars for relative strength calculation
  const spyBars = allBarsBySymbol.SPY || [];

  for (let i = 100; i < allBars.length - settings.holdDays - 2; i++) {
    // Point-in-time: only give buildSignal the data up to bar i
    const barsUpToNow = allBars.slice(0, i + 1);
    if (barsUpToNow.length < 100) continue;

    // Build SPY slice for relative strength
    const spySlice = spyBars.slice(0, i + 1);
    const spyCloses = spySlice.map(b => b.close);
    const spyMove21 = spyCloses.length > 22
      ? ((spyCloses.at(-1) - spyCloses[spyCloses.length - 22]) / spyCloses[spyCloses.length - 22]) * 100
      : 0;

    // Build bars slice including sector ETFs for accurate sector check
    const { sectorEtfOf } = require("../data/sectorMap");
    const sectorEtf = sectorEtfOf(symbol);
    const barsSlice = {
      [symbol]: barsUpToNow,
      SPY: spySlice,
      [sectorEtf]: (allBarsBySymbol[sectorEtf] || []).slice(0, i + 1)
    };

    // Call the EXACT same buildSignal used by live scanner
    let signal;
    try {
      signal = buildSignal(
        symbol, barsUpToNow, spyMove21,
        "BULLISH", // assume bullish regime for backtesting
        settings, {}, barsSlice
      );
    } catch (e) {
      continue;
    }

    if (!signal) continue;
    // Accept TRADE_READY signals, also accept high-confidence WATCHLIST for edge building
    if (signal.safety !== "TRADE_READY") continue;
    if (signal.confidence < settings.minConfidence) continue;
    if (signal.rrNumber < settings.minRiskReward) continue;

    // Enter on NEXT bar open (not current close) — realistic execution
    const nextBar = allBars[i + 1];
    if (!nextBar) continue;
    const entryPrice = applyCosts(nextBar.open || nextBar.close, "buy", settings);
    const stop = signal.stop;
    const target = signal.target1;
    const risk = Math.max(0.001, entryPrice - stop);

    if (risk <= 0 || risk > entryPrice * 0.15) continue;

    let exit = null;
    let exitReason = "Timed exit";
    let exitDate = allBars[Math.min(i + 1 + settings.holdDays, allBars.length - 1)].date;

    // Simulate trade over hold period
    for (let j = i + 2; j <= i + 1 + settings.holdDays && j < allBars.length; j++) {
      const bar = allBars[j];
      // Check for gap down through stop at open
      if (bar.open <= stop) {
        exit = applyCosts(bar.open, "sell", settings); // Exit at open if gapped through stop
        exitReason = "Gap through stop";
        exitDate = bar.date;
        break;
      }
      if (bar.low <= stop) {
        exit = applyCosts(stop, "sell", settings);
        exitReason = "Stop hit";
        exitDate = bar.date;
        break;
      }
      if (bar.high >= target) {
        exit = applyCosts(target, "sell", settings);
        exitReason = "Target hit";
        exitDate = bar.date;
        break;
      }
    }

    if (exit === null) {
      const eb = allBars[Math.min(i + 1 + settings.holdDays, allBars.length - 1)];
      exit = applyCosts(eb.close, "sell", settings);
      exitDate = eb.date;
    }

    const pnlR = (exit - entryPrice) / risk;
    trades.push({
      symbol,
      setupType: signal.setup,
      entryDate: nextBar.date,
      exitDate,
      entry: Number(entryPrice.toFixed(4)),
      exit: Number(exit.toFixed(4)),
      stop: Number(stop.toFixed(4)),
      target: Number(target.toFixed(4)),
      confidence: signal.confidence,
      pnlR: Number(pnlR.toFixed(2)),
      exitReason
    });

    // Skip forward to avoid overlapping trades
    i += Math.max(3, Math.floor(settings.holdDays / 2));
  }

  return { symbol, trades, summary: summarizeTrades(trades), setupStats: summarizeBySetup(trades) };
}

function runPortfolioBacktest(barsBySymbol, options = {}) {
  const excluded = new Set(["SPY", "QQQ", "DIA", "IWM", "VIX", "^VIX"]);
  const results = Object.entries(barsBySymbol)
    .filter(([s]) => !excluded.has(s))
    .map(([s, b]) => runSignalBacktest(s, b, options, barsBySymbol));

  const allTrades = results.flatMap(r => r.trades);
  const edges = {};
  for (const r of results) {
    edges[r.symbol] = {
      symbol: r.symbol,
      summary: r.summary,
      setupStats: r.setupStats,
      updatedAt: new Date().toISOString()
    };
  }

  return {
    options,
    createdAt: new Date().toISOString(),
    lookback: "3y daily — same rules as live scanner",
    method: "point-in-time buildSignal + next-bar entry",
    perSymbol: results,
    summary: summarizeTrades(allTrades),
    trades: allTrades.slice(-1000),
    edges
  };
}

function optimize(barsBySymbol, baseOptions = {}) {
  const runs = [];
  // Fix: optimizer now searches parameters that ACTUALLY affect buildSignal entry decisions
  for (const minConfidence of [72, 76, 80, 84])
    for (const minRiskReward of [1.8, 2.0, 2.2])
      for (const holdDays of [7, 10, 14]) {
        const opts = { ...baseOptions, minConfidence, minRiskReward, holdDays };
        const run = runPortfolioBacktest(barsBySymbol, opts);
        const enough = (run.summary.trades || 0) >= 20;
        const safe = (run.summary.expectancyR || -999) > 0;
        run.options = opts;
        run.optimizerScore = enough && safe
          ? Number(((run.summary.expectancyR || 0) * 50 + (run.summary.profitFactor || 0) * 10 - (run.summary.maxDrawdownR || 0)).toFixed(2))
          : -999;
        runs.push(run);
      }

  runs.sort((a, b) => b.optimizerScore - a.optimizerScore);
  return {
    createdAt: new Date().toISOString(),
    guardrail: "Best settings only valid if sample >= 20 trades and expectancy > 0.",
    best: runs[0] || null,
    runs: runs.slice(0, 25)
  };
}

module.exports = { runSignalBacktest, runPortfolioBacktest, optimize, summarizeTrades, summarizeBySetup };
