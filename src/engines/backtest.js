// ─── Backtest Engine v3 ──────────────────────────────────────────────────────
// Aligned with live scanner rules but optimised for speed
// Uses same indicators as buildSignal (MACD, ADX, RSI, Bollinger, EMA)
// Enters on next bar open — realistic execution
// minConfidence and minRiskReward actually filter trades

const { applyCosts } = require("./risk");
const { sma, ema, emaArray, rsi, atr, adx, macd, bollingerBands } = require("./scanner");
const { sectorEtfOf } = require("../data/sectorMap");

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
  if (trades.length < 20) sampleWarning = "Small sample (< 20 trades) — treat as exploratory.";
  else if (trades.length < 50) sampleWarning = "Moderate sample — increasing confidence.";
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

// Classify setup using same logic as live scanner
function classifySetup(close, high20, ema20v, ema50v, macdData, adxVal) {
  if (close >= high20 * 0.988) return "Breakout";
  if (ema20v && close <= ema20v * 1.015 && close >= ema20v * 0.985 && ema20v > ema50v) return "EMA Bounce";
  if (macdData?.bullish && ema20v && close > ema20v && adxVal > 20) return "Momentum";
  if (ema20v && close > ema20v && ema20v > ema50v) return "Pullback";
  return "Watch";
}

// Fast aligned backtest — calculates same indicators as live scanner
// but efficiently without calling full buildSignal() on every bar
function runSignalBacktest(symbol, bars, options = {}, barsBySymbol = {}) {
  const minConf = options.minConfidence || 72;
  const minRR   = options.minRiskReward  || 2.0;
  const slipPct = options.slippagePct    ?? 0.05;
  const sprdPct = options.spreadPct      ?? 0.03;
  const holdDays = options.holdDays      || 10;
  const settings = { slippagePct: slipPct, spreadPct: sprdPct };

  const trades = [];
  if (!Array.isArray(bars) || bars.length < 150) {
    return { symbol, trades: [], summary: emptySummary(), setupStats: {} };
  }

  // Pre-calculate SPY move for relative strength
  const spyBars = barsBySymbol.SPY || [];
  const spyCloses = spyBars.map(b => b.close);

  // Pre-calculate sector ETF trend
  const etfSymbol = sectorEtfOf(symbol);
  const etfBars = barsBySymbol[etfSymbol] || [];

  for (let i = 100; i < bars.length - holdDays - 2; i++) {
    const slice = bars.slice(0, i + 1);
    const closes = slice.map(b => b.close);
    const close = closes.at(-1);

    // ── Indicators (same as buildSignal) ──
    const ema20v = ema(closes, 20);
    const ema50v = ema(closes, 50);
    if (!ema20v || !ema50v) continue;

    // Trend filter — must be bullish
    const trendBull = close > ema20v && close > ema50v;
    if (!trendBull) { i += 2; continue; }
    if (ema20v <= ema50v) { i += 2; continue; }

    const sma200 = closes.length >= 200 ? sma(closes, 200) : null;
    if (sma200 && close < sma200) { i += 2; continue; }

    const rsi14 = rsi(closes, 14);
    if (!rsi14 || rsi14 < 45 || rsi14 > 76) continue;

    const atr14 = atr(slice, 14);
    const adxVal = adx(slice, 14) || 0;
    const macdData = macd(closes);
    const bb = bollingerBands(closes, 20, 2);

    // Extended check
    if (ema20v && close > ema20v * 1.09) continue;

    // ── Technical score (mirrors buildSignal logic) ──
    let score = 0;
    if (close > ema20v) score += 14;
    if (close > ema50v) score += 13;
    if (sma200 && close > sma200) score += 12;
    if (ema20v > ema50v) score += 10;
    if (macdData?.bullish) score += 10;
    if (macdData?.crossing) score += 5;
    if (adxVal > 25) score += 8;
    else if (adxVal > 18) score += 4;
    if (rsi14 >= 50 && rsi14 <= 68) score += 8;
    else if (rsi14 > 68 && rsi14 <= 74) score += 3;

    // Volume
    const volumes = slice.map(b => b.volume || 0);
    const avgVol = sma(volumes, 20) || 1;
    const volRatio = slice.at(-1).volume / avgVol;
    if (volRatio >= 1.3) score += 8;
    else if (volRatio >= 1.1) score += 3;

    // Relative strength vs SPY
    if (spyCloses.length > 22) {
      const spySlice = spyCloses.slice(0, i + 1);
      const spyMove = spySlice.length > 22 ? ((spySlice.at(-1) - spySlice[spySlice.length - 22]) / spySlice[spySlice.length - 22]) * 100 : 0;
      const stockMove = closes.length > 22 ? ((close - closes[closes.length - 22]) / closes[closes.length - 22]) * 100 : 0;
      if (stockMove > spyMove + 2) score += 10;
      else if (stockMove > spyMove) score += 5;
    }

    // Sector ETF check
    if (etfBars.length > 50) {
      const etfSlice = etfBars.slice(0, i + 1);
      const etfCloses = etfSlice.map(b => b.close);
      const etfEma20 = ema(etfCloses, 20);
      const etfEma50 = ema(etfCloses, 50);
      if (etfEma20 && etfEma50 && etfCloses.at(-1) > etfEma20 && etfEma20 > etfEma50) score += 10;
      else if (etfEma20 && etfCloses.at(-1) < etfEma20) score -= 12;
    }

    // Setup bonus
    const recent20 = slice.slice(-20);
    const high20 = Math.max(...recent20.map(b => b.high));
    const setupType = classifySetup(close, high20, ema20v, ema50v, macdData, adxVal);
    if (setupType === "Breakout") score += 7;
    if (setupType === "Momentum") score += 6;
    if (setupType === "EMA Bounce") score += 5;

    // Market bias bonus (assume BULLISH for backtest)
    score += 6;

    score = Math.max(1, Math.min(99, Math.round(score)));
    if (score < minConf) continue;

    // ADX filter
    if (adxVal > 0 && adxVal < 20) continue;

    // ── Stop / Target ──
    const low20 = Math.min(...recent20.map(b => b.low));
    const safeAtr = Number.isFinite(atr14) && atr14 > 0 ? atr14 : close * 0.025;
    const stop = Math.max(close - safeAtr * 1.2, low20 * 0.988);
    const risk = Math.max(0.001, close - stop);
    if (risk <= 0 || risk > close * 0.12) continue;

    const target = close + risk * 2.0;
    const rrNum = (target - close) / risk;
    if (rrNum < minRR) continue;

    // ── Enter on next bar open ──
    const nextBar = bars[i + 1];
    if (!nextBar) continue;
    const entryPrice = applyCosts(nextBar.open || nextBar.close, "buy", settings);

    // Use signal-bar stop and target (calculated from close)
    // Ensure risk is at least 0.5% of price to avoid division issues
    const entryRisk = Math.max(entryPrice * 0.005, risk);
    const entryStop = entryPrice - entryRisk;
    const entryTarget = entryPrice + entryRisk * 2.0;

    let exit = null, exitReason = "Timed exit";
    let exitDate = bars[Math.min(i + 1 + holdDays, bars.length - 1)].date;

    for (let j = i + 2; j <= i + 1 + holdDays && j < bars.length; j++) {
      const bar = bars[j];
      if (bar.low <= entryStop) {
        exit = applyCosts(entryStop, "sell", settings);
        exitReason = "Stop hit";
        exitDate = bar.date;
        break;
      }
      if (bar.high >= entryTarget) {
        exit = applyCosts(entryTarget, "sell", settings);
        exitReason = "Target hit";
        exitDate = bar.date;
        break;
      }
    }

    if (exit === null) {
      const eb = bars[Math.min(i + 1 + holdDays, bars.length - 1)];
      exit = applyCosts(eb.close, "sell", settings);
      exitDate = eb.date;
    }

    const pnlR = Number(((exit - entryPrice) / entryRisk).toFixed(2));
    if (!Number.isFinite(pnlR)) continue;
    trades.push({
      symbol, setupType, entryDate: nextBar.date, exitDate,
      entry: Number(entryPrice.toFixed(4)), exit: Number(exit.toFixed(4)),
      stop: Number(stop.toFixed(4)), target: Number(target.toFixed(4)),
      confidence: score, pnlR: Number(pnlR.toFixed(2)), exitReason
    });

    i += Math.max(3, Math.floor(holdDays / 2));
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
      symbol: r.symbol, summary: r.summary,
      setupStats: r.setupStats, updatedAt: new Date().toISOString()
    };
  }
  return {
    options, createdAt: new Date().toISOString(),
    lookback: "3y daily — aligned with live scanner rules",
    method: "fast aligned backtest + next-bar entry",
    perSymbol: results, summary: summarizeTrades(allTrades),
    trades: allTrades.slice(-1000), edges
  };
}

function optimize(barsBySymbol, baseOptions = {}) {
  const runs = [];
  for (const minConfidence of [68, 72, 76, 80])
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
    best: runs[0] || null, runs: runs.slice(0, 25)
  };
}

module.exports = { runSignalBacktest, runPortfolioBacktest, optimize, summarizeTrades, summarizeBySetup };
