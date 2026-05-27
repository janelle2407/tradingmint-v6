const { applyCosts } = require("./risk");
const { adx, macd, bollingerBands } = require("./scanner");

function emptySummary() {
  return { trades: 0, winRate: null, expectancyR: null, profitFactor: null, avgWinR: null, avgLossR: null, maxDrawdownR: null, sampleWarning: "No valid sample." };
}

function emaAt(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let cur = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < values.length; i++) cur = values[i] * k + cur * (1 - k);
  return cur;
}

function smaAt(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  return values.slice(-period).reduce((s, v) => s + v, 0) / period;
}

function classifySetupBacktest(close, high20, low20, ema20, ema50, bars, i) {
  // ATR for stop calculations
  const recentBars = bars.slice(Math.max(0, i - 14), i + 1);
  let atrVal = null;
  if (recentBars.length >= 5) {
    const trs = [];
    for (let j = 1; j < recentBars.length; j++) {
      const h = recentBars[j].high, l = recentBars[j].low, pc = recentBars[j - 1].close;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    atrVal = trs.reduce((s, v) => s + v, 0) / trs.length;
  }
  if (close >= high20 * 0.988) return { setup: "Breakout", atrVal };
  if (ema20 && close <= ema20 * 1.015 && close >= ema20 * 0.985 && ema20 > ema50) return { setup: "EMA Bounce", atrVal };
  if (close > ema20 && ema20 > ema50) return { setup: "Pullback", atrVal };
  return { setup: "Watch", atrVal };
}

function summarizeTrades(trades) {
  if (!trades.length) return emptySummary();
  const wins = trades.filter(t => t.pnlR > 0), losses = trades.filter(t => t.pnlR <= 0);
  const grossWins = wins.reduce((s, t) => s + t.pnlR, 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnlR, 0));
  const expectancy = trades.reduce((s, t) => s + t.pnlR, 0) / trades.length;
  let equityR = 0, peak = 0, maxDrawdownR = 0;
  for (const t of trades) {
    equityR += t.pnlR;
    peak = Math.max(peak, equityR);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equityR);
  }
  return {
    trades: trades.length,
    winRate: Number(((wins.length / trades.length) * 100).toFixed(1)),
    expectancyR: Number(expectancy.toFixed(2)),
    profitFactor: grossLosses ? Number((grossWins / grossLosses).toFixed(2)) : null,
    avgWinR: wins.length ? Number((grossWins / wins.length).toFixed(2)) : null,
    avgLossR: losses.length ? Number((-grossLosses / losses.length).toFixed(2)) : null,
    maxDrawdownR: Number(maxDrawdownR.toFixed(2)),
    sampleWarning: trades.length < 15 ? "Small sample — treat this edge as unproven." : ""
  };
}

function summarizeBySetup(trades) {
  const grouped = {};
  for (const t of trades) { grouped[t.setupType] ||= []; grouped[t.setupType].push(t); }
  const out = {};
  for (const [setup, rows] of Object.entries(grouped)) out[setup] = summarizeTrades(rows);
  return out;
}

function runSignalBacktest(symbol, bars, options = {}) {
  const settings = {
    minConfidence: options.minConfidence || 76,
    minRiskReward: options.minRiskReward || 1.8,
    slippagePct: options.slippagePct ?? 0.05,
    spreadPct: options.spreadPct ?? 0.03,
    holdDays: options.holdDays || 10
  };
  const trades = [];
  if (!Array.isArray(bars) || bars.length < 200) return { symbol, trades: [], summary: emptySummary(), setupStats: {} };

  for (let i = 80; i < bars.length - settings.holdDays - 1; i++) {
    const recent = bars.slice(0, i + 1);
    const closes = recent.map(b => b.close);
    const close = recent.at(-1).close;
    const high20 = Math.max(...recent.slice(-20).map(b => b.high));
    const low20 = Math.min(...recent.slice(-20).map(b => b.low));
    const ema20v = emaAt(closes, 20);
    const ema50v = emaAt(closes, 50);
    if (!ema20v || !ema50v) continue;

    const { setup, atrVal } = classifySetupBacktest(close, high20, low20, ema20v, ema50v, bars, i);
    const highBreak = close >= high20 * 0.988;
    const trend = close > ema20v && ema20v > ema50v;
    if (!highBreak && !trend) continue;

    // v6: tighter ATR-based stops
    const safeAtr = atrVal && atrVal > 0 ? atrVal : close * 0.025;
    const atrStop = close - safeAtr * 1.2;
    const low20Stop = low20 * 0.988;
    const stop = Math.max(atrStop, low20Stop, close * 0.91); // Never more than 9% away
    const risk = close - stop;
    if (risk <= 0 || risk > close * 0.12) continue;

    const target = close + risk * 2.0; // Improved to 2.0 R:R
    const entry = applyCosts(close, "buy", settings);
    let exit = null, exitReason = "Timed exit", exitDate = bars[Math.min(i + settings.holdDays, bars.length - 1)].date;

    for (let j = i + 1; j <= i + settings.holdDays && j < bars.length; j++) {
      if (bars[j].low <= stop) {
        exit = applyCosts(stop, "sell", settings);
        exitReason = "Stop hit";
        exitDate = bars[j].date;
        break;
      }
      if (bars[j].high >= target) {
        exit = applyCosts(target, "sell", settings);
        exitReason = "Target hit";
        exitDate = bars[j].date;
        break;
      }
    }

    if (exit === null) {
      const eb = bars[Math.min(i + settings.holdDays, bars.length - 1)];
      exit = applyCosts(eb.close, "sell", settings);
      exitDate = eb.date;
    }

    const pnlR = (exit - entry) / risk;
    trades.push({
      symbol, setupType: setup, entryDate: bars[i].date, exitDate,
      entry: Number(entry.toFixed(4)), exit: Number(exit.toFixed(4)),
      stop: Number(stop.toFixed(4)), target: Number(target.toFixed(4)),
      pnlR: Number(pnlR.toFixed(2)), exitReason
    });
    i += Math.max(2, Math.floor(settings.holdDays / 2));
  }

  return { symbol, trades, summary: summarizeTrades(trades), setupStats: summarizeBySetup(trades) };
}

function runPortfolioBacktest(barsBySymbol, options = {}) {
  const results = Object.entries(barsBySymbol)
    .filter(([s]) => !["SPY", "QQQ", "DIA", "IWM", "VIX", "^VIX"].includes(s))
    .map(([s, b]) => runSignalBacktest(s, b, options));
  const allTrades = results.flatMap(r => r.trades);
  const edges = {};
  for (const r of results) {
    edges[r.symbol] = { symbol: r.symbol, summary: r.summary, setupStats: r.setupStats, updatedAt: new Date().toISOString() };
  }
  return {
    options,
    createdAt: new Date().toISOString(),
    lookback: "3y daily",
    perSymbol: results,
    summary: summarizeTrades(allTrades),
    trades: allTrades.slice(-1000),
    edges
  };
}

function optimize(barsBySymbol, baseOptions = {}) {
  const runs = [];
  for (const minConfidence of [70, 76, 82, 86])
    for (const minRiskReward of [1.6, 1.8, 2.0, 2.2])
      for (const holdDays of [7, 10, 14]) {
        const run = runPortfolioBacktest(barsBySymbol, { ...baseOptions, minConfidence, minRiskReward, holdDays });
        const enough = (run.summary.trades || 0) >= 25, safe = (run.summary.expectancyR || -999) > 0;
        run.optimizerScore = enough && safe
          ? Number(((run.summary.expectancyR || 0) * 50 + (run.summary.profitFactor || 0) * 10 - (run.summary.maxDrawdownR || 0)).toFixed(2))
          : -999;
        runs.push(run);
      }
  runs.sort((a, b) => b.optimizerScore - a.optimizerScore);
  return {
    createdAt: new Date().toISOString(),
    guardrail: "Best settings only apply if sample size and expectancy are both positive.",
    best: runs[0] || null,
    runs: runs.slice(0, 25)
  };
}

module.exports = { runSignalBacktest, runPortfolioBacktest, optimize, summarizeTrades, summarizeBySetup };
