// ─── Backtest Engine v4 ──────────────────────────────────────────────────────
// v4: Historical market regime per bar (no bullish assumption)
//     Date-filtered trades for walk-forward warm-up
//     Stricter optimizer guardrails
//     Portfolio simulation engine

const { applyCosts } = require("./risk");
const { sma, ema, rsi, atr, adx, macd, bollingerBands, buildSignal } = require("./scanner");
const { sectorEtfOf, sectorOf } = require("../data/sectorMap");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emptySummary() {
  return {
    trades: 0, winRate: null, expectancyR: null, profitFactor: null,
    avgWinR: null, avgLossR: null, maxDrawdownR: null,
    sampleWarning: "No valid sample."
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
  if (trades.length < 30) sampleWarning = "Small sample (< 30 trades) — treat as exploratory.";
  else if (trades.length < 60) sampleWarning = "Moderate sample — results improving.";
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

// ─── Historical Market Regime (CRITICAL FIX) ─────────────────────────────────
// Calculates real market regime at each bar using only data available up to that point
// NO bullish assumption — the backtest now avoids longs in historically bearish periods

function calcHistoricalVolatility(bars, endIndex, period = 20) {
  if (!Array.isArray(bars) || endIndex < period + 1) return 18;
  const slice = bars.slice(Math.max(0, endIndex - period), endIndex + 1);
  const returns = [];
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1]?.close;
    const curr = slice[i]?.close;
    if (prev > 0 && curr > 0) returns.push(Math.log(curr / prev));
  }
  if (returns.length < 5) return 18;
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance = returns.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / returns.length;
  return Math.max(8, Math.min(80, Math.sqrt(variance) * Math.sqrt(252) * 100));
}

function indexTrendScore(bars, endIndex) {
  if (!Array.isArray(bars) || endIndex < 60) return 0;
  const slice = bars.slice(0, endIndex + 1);
  const closes = slice.map(b => b.close).filter(Number.isFinite);
  if (closes.length < 60) return 0;
  const price = closes.at(-1);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const s200 = closes.length >= 200 ? sma(closes, 200) : null;
  let score = 0;
  if (e20 && price > e20) score++;
  if (e50 && price > e50) score++;
  if (s200 && price > s200) score++;
  if (e20 && e50 && e20 > e50) score++;
  if (closes.length >= 55) {
    const e50Prev = ema(closes.slice(0, -5), 50);
    if (e50 && e50Prev && e50 > e50Prev) score++;
  }
  return score;
}

function historicalBreadthAtIndex(barsBySymbol, endIndex) {
  const excluded = new Set(["SPY", "QQQ", "DIA", "IWM", "VIX", "^VIX"]);
  let up = 0, total = 0;
  for (const [symbol, bars] of Object.entries(barsBySymbol || {})) {
    if (excluded.has(symbol)) continue;
    if (!Array.isArray(bars) || bars.length <= endIndex || endIndex < 50) continue;
    const slice = bars.slice(0, endIndex + 1);
    const closes = slice.map(b => b.close).filter(Number.isFinite);
    const price = closes.at(-1);
    const e20 = ema(closes, 20);
    const e50 = ema(closes, 50);
    if (!price || !e20 || !e50) continue;
    total++;
    if (price > e20 && price > e50 && e20 > e50) up++;
  }
  return total ? Math.round((up / total) * 100) : 50;
}

function historicalRegimeAtIndex(barsBySymbol, endIndex) {
  const spyBars = barsBySymbol.SPY || [];
  const qqqBars = barsBySymbol.QQQ || [];
  const spyScore = indexTrendScore(spyBars, endIndex);
  const qqqScore = indexTrendScore(qqqBars, endIndex);
  const indexScore = spyScore + qqqScore;
  const breadth = historicalBreadthAtIndex(barsBySymbol, endIndex);
  const vix = calcHistoricalVolatility(spyBars, endIndex, 20);
  let volatility = "MEDIUM";
  if (Number.isFinite(vix)) {
    volatility = vix < 18 ? "LOW" : vix < 25 ? "MEDIUM" : vix < 30 ? "ELEVATED" : "HIGH";
  }
  // Calculated SPY volatility (annualised stddev of log returns × 100) runs higher than
  // the real VIX index. Use raised thresholds so the backtest regime matches what the
  // live scanner sees with actual VIX data:
  //   vixPause (suppress BULLISH): calculated vol > 35  ≈ real VIX ~28
  //   vixHalt  (force BEARISH):    calculated vol > 45  ≈ real VIX ~38 (severe stress only)
  // This prevents the backtest from flagging normal 2022-style sell-offs as BEARISH and
  // wiping out all trade opportunities.
  const vixPause = Number.isFinite(vix) && vix > 35;
  const vixHalt  = Number.isFinite(vix) && vix > 45;
  let regime = "NEUTRAL";
  if (breadth >= 55 && indexScore >= 6 && !vixPause) regime = "BULLISH";
  else if (breadth >= 45 && indexScore >= 4 && !vixPause) regime = "NEUTRAL";
  // vixHalt alone only pushes to BEARISH if breadth and index score are also weak —
  // a strong tape can still be NEUTRAL even during elevated vol (e.g. a V-shaped recovery)
  if (breadth < 35 || indexScore <= 2 || (vixHalt && breadth < 45)) regime = "BEARISH";
  return { regime, breadth, spyScore, qqqScore, indexScore, volatility, vix: Number(vix.toFixed(1)) };
}

// ─── Setup Classifier ────────────────────────────────────────────────────────

function classifySetup(close, high20, ema20v, ema50v, macdData, adxVal) {
  if (close >= high20 * 0.988) return "Breakout";
  if (ema20v && close <= ema20v * 1.015 && close >= ema20v * 0.985 && ema20v > ema50v) return "EMA Bounce";
  if (macdData?.bullish && ema20v && close > ema20v && adxVal > 20) return "Momentum";
  if (ema20v && close > ema20v && ema20v > ema50v) return "Pullback";
  return "Watch";
}

// ─── Signal Backtest ─────────────────────────────────────────────────────────

function spyMove21At(spyBars) {
  const closes = (spyBars || []).map(bar => bar.close).filter(Number.isFinite);
  return closes.length > 22 ? ((closes.at(-1) - closes[closes.length - 22]) / closes[closes.length - 22]) * 100 : 0;
}

function historicalContextAtIndex(barsBySymbol, endIndex) {
  const context = {};
  for (const [symbol, rows] of Object.entries(barsBySymbol || {})) {
    if (!Array.isArray(rows) || rows.length < 2) continue;
    context[symbol] = rows.slice(0, Math.min(rows.length, endIndex + 1));
  }
  return context;
}

function runSignalBacktest(symbol, bars, options = {}, barsBySymbol = {}, sharedRegimeCache = null) {
  const minConf = Number(options.minConfidence || 72);
  const minRR = Number(options.minRiskReward || 2.0);
  const slipPct = options.slippagePct ?? 0.05;
  const sprdPct = options.spreadPct ?? 0.03;
  const holdDays = Number(options.holdDays || 10);
  const timeStopDays = Number(options.timeStopDays || Math.min(5, holdDays));
  const costs = { slippagePct: slipPct, spreadPct: sprdPct };

  const countFrom = options.countTradesFromDate || null;
  const countTo = options.countTradesToDate || null;
  function shouldCount(entryDate) {
    if (!entryDate) return true;
    if (countFrom && entryDate < countFrom) return false;
    if (countTo && entryDate > countTo) return false;
    return true;
  }

  const trades = [];
  if (!Array.isArray(bars) || bars.length < 230) {
    return { symbol, trades: [], summary: emptySummary(), setupStats: {} };
  }

  const localCache = new Map();
  function getCachedRegime(idx) {
    const bucket = Math.floor(idx / 50) * 50;
    if (sharedRegimeCache && sharedRegimeCache.has(bucket)) return sharedRegimeCache.get(bucket);
    if (!localCache.has(bucket)) localCache.set(bucket, historicalRegimeAtIndex(barsBySymbol, bucket));
    return localCache.get(bucket);
  }

  for (let i = 220; i < bars.length - holdDays - 2; i++) {
    const context = historicalContextAtIndex(barsBySymbol, i);
    const slice = context[symbol] || bars.slice(0, i + 1);
    if (slice.length < 220) continue;

    const regimeInfo = getCachedRegime(i);
    if (regimeInfo.regime === "BEARISH") {
      i += 2;
      continue;
    }

    const backtestSettings = {
      ...options,
      minConfidence: minConf,
      minRiskReward: minRR,
      requireHistoricalEdge: false,
      minHistoricalTrades: 0,
      minHistoricalExpectancyR: -999,
      minHistoricalProfitFactor: 0,
      edgeWeight: Number(options.backtestEdgeWeight ?? 0),
      blockUnknownEarnings: false,
      earningsBlockDays: Number(options.earningsBlockDays || 5)
    };

    let signal;
    try {
      signal = buildSignal(
        symbol,
        slice,
        spyMove21At(context.SPY || []),
        regimeInfo.regime,
        backtestSettings,
        {},
        context,
        {},
        {},
        {}
      );
    } catch {
      continue;
    }

    if (!signal || signal.safety !== "TRADE_READY") continue;
    if (Number(signal.confidence || 0) < minConf) continue;
    if (Number(signal.rrNumber || 0) < minRR) continue;

    const nextBar = bars[i + 1];
    if (!nextBar || !shouldCount(nextBar.date)) continue;

    const rawEntry = Number(nextBar.open || nextBar.close);
    const entryPrice = applyCosts(rawEntry, "buy", costs);
    const entryShift = entryPrice - Number(signal.entry);
    const entryStop = Math.max(0.01, Number(signal.stop) + entryShift);
    const risk = Math.max(entryPrice * 0.005, entryPrice - entryStop);
    if (!Number.isFinite(risk) || risk <= 0 || risk > entryPrice * 0.12) continue;

    const target1 = Number(signal.target1) + entryShift;
    const target2 = Number(signal.target2) + entryShift;
    const entryTarget = Number.isFinite(target1) && target1 > entryPrice ? target1 : entryPrice + risk * 2;
    const stretchTarget = Number.isFinite(target2) && target2 > entryPrice ? target2 : entryPrice + risk * 3;

    let exit = null;
    let exitReason = "Timed exit";
    let exitDate = bars[Math.min(i + 1 + holdDays, bars.length - 1)].date;
    let bestHigh = entryPrice;

    for (let j = i + 2; j <= i + 1 + holdDays && j < bars.length; j++) {
      const bar = bars[j];
      bestHigh = Math.max(bestHigh, Number(bar.high || bestHigh));

      // Conservative sequencing: if stop and target both hit in the same bar, count stop first.
      if (bar.low <= entryStop) {
        exit = applyCosts(entryStop, "sell", costs);
        exitReason = "Stop hit";
        exitDate = bar.date;
        break;
      }
      if (bar.high >= stretchTarget) {
        exit = applyCosts(stretchTarget, "sell", costs);
        exitReason = "Target 2 hit";
        exitDate = bar.date;
        break;
      }
      if (bar.high >= entryTarget) {
        exit = applyCosts(entryTarget, "sell", costs);
        exitReason = "Target 1 hit";
        exitDate = bar.date;
        break;
      }

      // Time stop: if the trade has not made progress after a few bars, exit flat/weak.
      if (timeStopDays > 0 && j >= i + 1 + timeStopDays) {
        const progressR = (bestHigh - entryPrice) / risk;
        if (progressR < 0.5 && Number(bar.close) <= entryPrice) {
          exit = applyCosts(Number(bar.close), "sell", costs);
          exitReason = "Time stop — no progress";
          exitDate = bar.date;
          break;
        }
      }
    }

    if (exit === null) {
      const exitBar = bars[Math.min(i + 1 + holdDays, bars.length - 1)];
      exit = applyCosts(Number(exitBar.close), "sell", costs);
      exitDate = exitBar.date;
    }

    const pnlR = Number(((exit - entryPrice) / risk).toFixed(2));
    if (!Number.isFinite(pnlR)) continue;

    trades.push({
      symbol,
      setupType: signal.setup,
      entryDate: nextBar.date,
      exitDate,
      entry: Number(entryPrice.toFixed(4)),
      exit: Number(exit.toFixed(4)),
      stop: Number(entryStop.toFixed(4)),
      target: Number(entryTarget.toFixed(4)),
      confidence: signal.confidence,
      grade: signal.grade || null,
      pnlR,
      exitReason,
      marketRegime: regimeInfo.regime,
      marketBreadth: regimeInfo.breadth,
      marketVolatility: regimeInfo.volatility,
      rsPercentile: signal.rs?.rsPercentile || null
    });

    i += Math.max(3, Math.floor(holdDays / 2));
  }

  return { symbol, trades, summary: summarizeTrades(trades), setupStats: summarizeBySetup(trades) };
}

function simulatePortfolioTrades(trades, options = {}) {
  const maxOpen = Number(options.maxOpenPositions || 4);
  const maxDailyEntries = Number(options.maxDailyEntries || 2);
  const maxSameSectorOpen = Number(options.maxSameSectorOpen || 2);
  const sorted = [...trades].sort((a, b) => String(a.entryDate).localeCompare(String(b.entryDate)) || Number(b.confidence || 0) - Number(a.confidence || 0));
  const open = [];
  const accepted = [];
  const rejected = [];
  const dailyEntries = {};

  for (const trade of sorted) {
    while (open.length && String(open[0].exitDate) <= String(trade.entryDate)) open.shift();
    open.sort((a, b) => String(a.exitDate).localeCompare(String(b.exitDate)));

    const day = trade.entryDate;
    const sector = sectorOf(trade.symbol);
    const sameSectorOpen = open.filter(row => sectorOf(row.symbol) === sector).length;
    const reasons = [];
    if (open.length >= maxOpen) reasons.push("Max open positions reached");
    if ((dailyEntries[day] || 0) >= maxDailyEntries) reasons.push("Max daily entries reached");
    if (sameSectorOpen >= maxSameSectorOpen) reasons.push(`Max same-sector positions reached for ${sector}`);

    if (reasons.length) {
      rejected.push({ ...trade, rejectedReasons: reasons });
      continue;
    }

    accepted.push(trade);
    open.push(trade);
    dailyEntries[day] = (dailyEntries[day] || 0) + 1;
  }

  return { trades: accepted, rejected };
}

// ─── Portfolio Backtest ───────────────────────────────────────────────────────

function runPortfolioBacktest(barsBySymbol, options = {}) {
  const excluded = new Set(["SPY", "QQQ", "DIA", "IWM", "VIX", "^VIX"]);

  // Pre-compute regime timeline ONCE for all symbols to share
  // This is the critical performance fix — without this each symbol
  // recalculates regime across all other symbols = O(n^2) slowness
  const reference = barsBySymbol.SPY || barsBySymbol[Object.keys(barsBySymbol)[0]] || [];
  const sharedRegimeCache = new Map();
  const CACHE_STEP = 50;
  for (let i = 100; i < reference.length; i += CACHE_STEP) {
    sharedRegimeCache.set(i, historicalRegimeAtIndex(barsBySymbol, i));
  }

  const results = Object.entries(barsBySymbol)
    .filter(([s]) => !excluded.has(s))
    .map(([s, b]) => runSignalBacktest(s, b, options, barsBySymbol, sharedRegimeCache));

  const rawTrades = results.flatMap(r => r.trades);
  const portfolio = simulatePortfolioTrades(rawTrades, options);
  const edges = {};
  for (const r of results) {
    edges[r.symbol] = {
      symbol: r.symbol, summary: r.summary,
      setupStats: r.setupStats, updatedAt: new Date().toISOString()
    };
  }
  return {
    options, createdAt: new Date().toISOString(),
    lookback: options.lookback || "max daily — live signal engine, historical regime applied",
    method: "scanner-equivalent signal backtest + next-bar entry + portfolio constraints",
    perSymbol: results,
    rawSummary: summarizeTrades(rawTrades),
    summary: summarizeTrades(portfolio.trades),
    portfolioRejected: portfolio.rejected.slice(-500),
    trades: portfolio.trades.slice(-1000),
    rawTrades: rawTrades.slice(-1000),
    edges
  };
}

// ─── Optimizer Guardrails (STRICTER) ─────────────────────────────────────────

function optimizerPassesGuardrails(summary, options = {}) {
  const trades       = Number(summary.trades || 0);
  const expectancyR  = Number(summary.expectancyR || 0);
  const profitFactor = Number(summary.profitFactor || 0);
  const maxDrawdownR = Number(summary.maxDrawdownR || 999);
  return (
    trades       >= Number(options.minOptimizerTrades      || 60)   &&
    expectancyR  >= Number(options.minOptimizerExpectancyR || 0.15) &&
    profitFactor >= Number(options.minOptimizerProfitFactor|| 1.25) &&
    maxDrawdownR <= Number(options.maxOptimizerDrawdownR   || 10)
  );
}

function optimize(barsBySymbol, baseOptions = {}) {
  const runs = [];
  for (const minConfidence of [68, 72, 76, 80])
    for (const minRiskReward of [1.8, 2.0, 2.2])
      for (const holdDays of [7, 10, 14]) {
        const opts = { ...baseOptions, minConfidence, minRiskReward, holdDays };
        const run  = runPortfolioBacktest(barsBySymbol, opts);
        run.options = opts;
        const safe = optimizerPassesGuardrails(run.summary, baseOptions);
        run.optimizerScore = safe
          ? Number(((run.summary.expectancyR || 0) * 60 + (run.summary.profitFactor || 0) * 12 - (run.summary.maxDrawdownR || 0) * 1.5).toFixed(2))
          : -999;
        runs.push(run);
      }
  runs.sort((a, b) => b.optimizerScore - a.optimizerScore);
  return {
    createdAt: new Date().toISOString(),
    guardrail: "Best settings only valid if sample ≥ 60 trades, expectancy ≥ 0.15R, profit factor ≥ 1.25, and max drawdown ≤ 10R.",
    best: runs[0] || null, runs: runs.slice(0, 25)
  };
}

module.exports = {
  runSignalBacktest,
  runPortfolioBacktest,
  optimize,
  summarizeTrades,
  summarizeBySetup,
  simulatePortfolioTrades,
  historicalRegimeAtIndex
};
