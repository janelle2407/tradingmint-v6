// ─── Backtest Engine v4 ──────────────────────────────────────────────────────
// v4: Historical market regime per bar (no bullish assumption)
//     Date-filtered trades for walk-forward warm-up
//     Stricter optimizer guardrails
//     Portfolio simulation engine

const { applyCosts } = require("./risk");
const { sma, ema, rsi, atr, adx, macd, bollingerBands } = require("./scanner");
const { sectorEtfOf } = require("../data/sectorMap");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emptySummary() {const { applyCosts } = require("./risk");
const { sma, ema, rsi, atr, adx, macd } = require("./scanner");
const { sectorEtfOf } = require("../data/sectorMap");

// Backtest Engine v4.1
// Fixes:
// 1. No more bullish-market assumption
// 2. Historical market regime is calculated at each bar
// 3. Backtest avoids long trades in bearish regimes
// 4. Date filtering supports walk-forward warm-up windows
// 5. Optimizer guardrails are stricter
// 6. Exit simulation is closer to paper mode with partial exit, breakeven stop, and target 2
// 7. Safer fallback if SPY/QQQ are missing in a walk-forward slice

function emptySummary() {
return {
trades: 0,
winRate: null,
expectancyR: null,
profitFactor: null,
avgWinR: null,
avgLossR: null,
maxDrawdownR: null,
sampleWarning: "No valid sample."
};
}

function summarizeTrades(trades = []) {
if (!trades.length) return emptySummary();

const wins = trades.filter(t => Number(t.pnlR || 0) > 0);
const losses = trades.filter(t => Number(t.pnlR || 0) <= 0);

const grossWins = wins.reduce((sum, trade) => sum + Number(trade.pnlR || 0), 0);
const grossLosses = Math.abs(losses.reduce((sum, trade) => sum + Number(trade.pnlR || 0), 0));
const totalR = trades.reduce((sum, trade) => sum + Number(trade.pnlR || 0), 0);
const expectancyR = totalR / trades.length;

let equityR = 0;
let peakR = 0;
let maxDrawdownR = 0;

for (const trade of trades) {
equityR += Number(trade.pnlR || 0);
peakR = Math.max(peakR, equityR);
maxDrawdownR = Math.max(maxDrawdownR, peakR - equityR);
}

let sampleWarning = "";
if (trades.length < 30) sampleWarning = "Small sample under 30 trades. Treat as exploratory.";
else if (trades.length < 60) sampleWarning = "Moderate sample. Use walk-forward confirmation before trusting.";

return {
trades: trades.length,
winRate: Number(((wins.length / trades.length) * 100).toFixed(1)),
expectancyR: Number(expectancyR.toFixed(2)),
profitFactor: grossLosses ? Number((grossWins / grossLosses).toFixed(2)) : null,
avgWinR: wins.length ? Number((grossWins / wins.length).toFixed(2)) : null,
avgLossR: losses.length ? Number((-grossLosses / losses.length).toFixed(2)) : null,
maxDrawdownR: Number(maxDrawdownR.toFixed(2)),
sampleWarning
};
}

function summarizeBySetup(trades = []) {
const grouped = {};

for (const trade of trades) {
const setup = trade.setupType || "Unknown";
grouped[setup] ||= [];
grouped[setup].push(trade);
}

const out = {};
for (const [setup, rows] of Object.entries(grouped)) {
out[setup] = summarizeTrades(rows);
}

return out;
}

function pctMove(current, previous) {
if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return 0;
return ((current - previous) / previous) * 100;
}

function calcHistoricalVolatility(bars, endIndex, period = 20) {
if (!Array.isArray(bars) || bars.length <= endIndex || endIndex < period + 1) return 18;

const slice = bars.slice(Math.max(0, endIndex - period), endIndex + 1);
const returns = [];

for (let i = 1; i < slice.length; i++) {
const prev = Number(slice[i - 1]?.close);
const curr = Number(slice[i]?.close);
if (prev > 0 && curr > 0) {
returns.push(Math.log(curr / prev));
}
}

if (returns.length < 5) return 18;

const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
const variance = returns.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / returns.length;
const annualisedVol = Math.sqrt(variance) * Math.sqrt(252) * 100;

return Math.max(8, Math.min(80, annualisedVol));
}

function indexTrendScore(bars, endIndex) {
if (!Array.isArray(bars) || bars.length <= endIndex || endIndex < 60) return null;

const slice = bars.slice(0, endIndex + 1);
const closes = slice.map(bar => Number(bar.close)).filter(Number.isFinite);

if (closes.length < 60) return null;

const price = closes.at(-1);
const e20 = ema(closes, 20);
const e50 = ema(closes, 50);
const s200 = closes.length >= 200 ? sma(closes, 200) : null;

let score = 0;

if (e20 && price > e20) score += 1;
if (e50 && price > e50) score += 1;
if (s200 && price > s200) score += 1;
if (e20 && e50 && e20 > e50) score += 1;

if (closes.length >= 55) {
const e50Prev = ema(closes.slice(0, -5), 50);
if (e50 && e50Prev && e50 > e50Prev) score += 1;
}

return score;
}

function historicalBreadthAtIndex(barsBySymbol, endIndex) {
const excluded = new Set(["SPY", "QQQ", "DIA", "IWM", "VIX", "^VIX"]);
let up = 0;
let total = 0;

for (const [symbol, bars] of Object.entries(barsBySymbol || {})) {
if (excluded.has(symbol)) continue;
if (!Array.isArray(bars) || bars.length <= endIndex || endIndex < 50) continue;

```
const slice = bars.slice(0, endIndex + 1);
const closes = slice.map(bar => Number(bar.close)).filter(Number.isFinite);
const price = closes.at(-1);
const e20 = ema(closes, 20);
const e50 = ema(closes, 50);

if (!price || !e20 || !e50) continue;

total += 1;
if (price > e20 && price > e50 && e20 > e50) up += 1;
```

}

return total ? Math.round((up / total) * 100) : 50;
}

function historicalRegimeAtIndex(barsBySymbol, endIndex) {
const spyBars = barsBySymbol?.SPY || [];
const qqqBars = barsBySymbol?.QQQ || [];

const spyScoreRaw = indexTrendScore(spyBars, endIndex);
const qqqScoreRaw = indexTrendScore(qqqBars, endIndex);

const hasSpy = Number.isFinite(spyScoreRaw);
const hasQqq = Number.isFinite(qqqScoreRaw);

const spyScore = hasSpy ? spyScoreRaw : 0;
const qqqScore = hasQqq ? qqqScoreRaw : 0;

const maxIndexScore = (hasSpy ? 5 : 0) + (hasQqq ? 5 : 0);
const indexScore = spyScore + qqqScore;
const indexHealth = maxIndexScore ? indexScore / maxIndexScore : null;

const breadth = historicalBreadthAtIndex(barsBySymbol, endIndex);
const vix = calcHistoricalVolatility(spyBars, endIndex, 20);

let volatility = "MEDIUM";
if (Number.isFinite(vix)) {
volatility = vix < 18 ? "LOW" : vix < 25 ? "MEDIUM" : vix < 30 ? "ELEVATED" : "HIGH";
}

const vixPause = Number.isFinite(vix) && vix > 25;
const vixHalt = Number.isFinite(vix) && vix > 30;

let regime = "NEUTRAL";

if (indexHealth === null) {
// Fallback for walk-forward slices where SPY/QQQ may not have been included.
// This is not ideal, but it prevents the backtest from incorrectly blocking every trade.
if (breadth >= 58 && !vixPause) regime = "BULLISH";
else if (breadth < 35 || vixHalt) regime = "BEARISH";
else regime = "NEUTRAL";
} else {
if (breadth >= 55 && indexHealth >= 0.6 && !vixPause) regime = "BULLISH";
else if (breadth >= 45 && indexHealth >= 0.4 && !vixPause) regime = "NEUTRAL";

```
if (breadth < 35 || indexHealth <= 0.2 || vixHalt) {
  regime = "BEARISH";
}
```

}

return {
regime,
breadth,
spyScore,
qqqScore,
indexScore,
maxIndexScore,
indexHealth: indexHealth === null ? null : Number(indexHealth.toFixed(2)),
volatility,
vix: Number(vix.toFixed(1))
};
}

function classifySetup(close, high20, ema20Value, ema50Value, macdData, adxValue) {
if (close >= high20 * 0.988) return "Breakout";

if (
ema20Value &&
ema50Value &&
close <= ema20Value * 1.015 &&
close >= ema20Value * 0.985 &&
ema20Value > ema50Value
) {
return "EMA Bounce";
}

if (macdData?.bullish && ema20Value && close > ema20Value && adxValue > 20) {
return "Momentum";
}

if (ema20Value && ema50Value && close > ema20Value && ema20Value > ema50Value) {
return "Pullback";
}

return "Watch";
}

function simulatePaperStyleExit({
bars,
startIndex,
holdDays,
entryPrice,
entryRisk,
settings
}) {
const target1 = entryPrice + entryRisk * 2.0;
const target2 = entryPrice + entryRisk * 3.0;

let stop = entryPrice - entryRisk;
let trailingStop = stop;
let partialDone = false;
let bankedR = 0;
let remainingSize = 1;
let exitPrice = null;
let exitDate = bars[Math.min(startIndex + holdDays, bars.length - 1)]?.date;
let exitReason = "Timed exit";
let ambiguousBar = false;

for (let j = startIndex + 1; j <= startIndex + holdDays && j < bars.length; j++) {
const bar = bars[j];
if (!bar) continue;

```
const open = Number(bar.open || bar.close);
const high = Number(bar.high);
const low = Number(bar.low);
const close = Number(bar.close);

if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
  continue;
}

if (close > entryPrice) {
  const newTrailing = close - entryRisk * 1.5;
  if (newTrailing > trailingStop) {
    trailingStop = newTrailing;
    if (newTrailing > stop) stop = newTrailing;
  }
}

const hitStop = low <= stop;
const hitTarget1 = high >= target1;
const hitTarget2 = high >= target2;

if (hitStop && (hitTarget1 || hitTarget2)) {
  ambiguousBar = true;
}

if (open <= stop) {
  exitPrice = applyCosts(open, "sell", settings);
  exitDate = bar.date;
  exitReason = partialDone ? "Gap through breakeven/trailing stop" : "Gap through stop";
  break;
}

if (hitStop) {
  exitPrice = applyCosts(stop, "sell", settings);
  exitDate = bar.date;
  exitReason = partialDone ? "Breakeven/trailing stop hit" : "Stop hit";
  break;
}

if (!partialDone && hitTarget1) {
  const partialExit = applyCosts(target1, "sell", settings);
  bankedR += ((partialExit - entryPrice) / entryRisk) * 0.5;
  remainingSize = 0.5;
  partialDone = true;
  stop = entryPrice;
  trailingStop = entryPrice;
  continue;
}

if (partialDone && hitTarget2) {
  exitPrice = applyCosts(target2, "sell", settings);
  exitDate = bar.date;
  exitReason = "Target 2 hit after partial";
  break;
}
```

}

if (exitPrice === null) {
const timedBar = bars[Math.min(startIndex + holdDays, bars.length - 1)];
exitPrice = applyCosts(Number(timedBar?.close || entryPrice), "sell", settings);
exitDate = timedBar?.date || exitDate;
}

const remainingR = ((exitPrice - entryPrice) / entryRisk) * remainingSize;
const pnlR = Number((bankedR + remainingR).toFixed(2));

return {
exitPrice,
exitDate,
exitReason,
pnlR,
partialDone,
ambiguousBar,
target1,
target2,
finalStop: stop
};
}

function runSignalBacktest(symbol, bars, options = {}, barsBySymbol = {}) {
const minConfidence = Number(options.minConfidence || 72);
const minRiskReward = Number(options.minRiskReward || 2.0);
const holdDays = Number(options.holdDays || 10);

const settings = {
slippagePct: options.slippagePct ?? 0.05,
spreadPct: options.spreadPct ?? 0.03
};

const countFrom = options.countTradesFromDate || null;
const countTo = options.countTradesToDate || null;

function shouldCountTrade(entryDate) {
if (!entryDate) return true;
if (countFrom && entryDate < countFrom) return false;
if (countTo && entryDate > countTo) return false;
return true;
}

const trades = [];

if (!Array.isArray(bars) || bars.length < 150) {
return {
symbol,
trades: [],
summary: emptySummary(),
setupStats: {}
};
}

const spyBars = barsBySymbol.SPY || [];
const spyCloses = spyBars.map(bar => Number(bar.close));
const etfSymbol = sectorEtfOf(symbol);
const etfBars = barsBySymbol[etfSymbol] || [];

const regimeCache = new Map();

function getCachedRegime(index) {
const bucket = Math.floor(index / 25) * 25;
const safeBucket = Math.min(index, bucket);

```
if (!regimeCache.has(safeBucket)) {
  regimeCache.set(safeBucket, historicalRegimeAtIndex(barsBySymbol, safeBucket));
}

return regimeCache.get(safeBucket);
```

}

for (let i = 100; i < bars.length - holdDays - 2; i++) {
const slice = bars.slice(0, i + 1);
const closes = slice.map(bar => Number(bar.close)).filter(Number.isFinite);
const close = closes.at(-1);

```
if (!Number.isFinite(close)) continue;

const ema20Value = ema(closes, 20);
const ema50Value = ema(closes, 50);

if (!ema20Value || !ema50Value) continue;

const trendBull = close > ema20Value && close > ema50Value && ema20Value > ema50Value;
if (!trendBull) {
  i += 2;
  continue;
}

const sma200Value = closes.length >= 200 ? sma(closes, 200) : null;
if (sma200Value && close < sma200Value) {
  i += 2;
  continue;
}

const rsi14 = rsi(closes, 14);
if (!rsi14 || rsi14 < 45 || rsi14 > 76) continue;

const atr14 = atr(slice, 14);
const adxValue = adx(slice, 14) || 0;
const macdData = macd(closes);

if (ema20Value && close > ema20Value * 1.09) continue;
if (adxValue > 0 && adxValue < 20) continue;

const regimeInfo = getCachedRegime(i);
if (regimeInfo.regime === "BEARISH") {
  i += 2;
  continue;
}

let score = 0;

if (close > ema20Value) score += 14;
if (close > ema50Value) score += 13;
if (sma200Value && close > sma200Value) score += 12;
if (ema20Value > ema50Value) score += 10;

if (macdData?.bullish) score += 10;
if (macdData?.crossing) score += 5;

if (adxValue > 25) score += 8;
else if (adxValue > 18) score += 4;

if (rsi14 >= 50 && rsi14 <= 68) score += 8;
else if (rsi14 > 68 && rsi14 <= 74) score += 3;

const volumes = slice.map(bar => Number(bar.volume || 0));
const averageVolume = sma(volumes, 20) || 1;
const volumeRatio = Number(slice.at(-1)?.volume || 0) / averageVolume;

if (volumeRatio >= 1.3) score += 8;
else if (volumeRatio >= 1.1) score += 3;

if (spyCloses.length > i && i > 22) {
  const spyMove = pctMove(spyCloses[i], spyCloses[i - 21]);
  const stockMove = pctMove(closes.at(-1), closes[closes.length - 22]);

  if (stockMove > spyMove + 2) score += 10;
  else if (stockMove > spyMove) score += 5;
}

if (Array.isArray(etfBars) && etfBars.length > i && i > 50) {
  const etfSlice = etfBars.slice(0, i + 1);
  const etfCloses = etfSlice.map(bar => Number(bar.close)).filter(Number.isFinite);
  const etfEma20 = ema(etfCloses, 20);
  const etfEma50 = ema(etfCloses, 50);
  const etfClose = etfCloses.at(-1);

  if (etfEma20 && etfEma50 && etfClose > etfEma20 && etfEma20 > etfEma50) {
    score += 10;
  } else if (etfEma20 && etfClose < etfEma20) {
    score -= 12;
  }
}

const recent20 = slice.slice(-20);
const high20 = Math.max(...recent20.map(bar => Number(bar.high)).filter(Number.isFinite));
const low20 = Math.min(...recent20.map(bar => Number(bar.low)).filter(Number.isFinite));

if (!Number.isFinite(high20) || !Number.isFinite(low20)) continue;

const setupType = classifySetup(close, high20, ema20Value, ema50Value, macdData, adxValue);

if (setupType === "Breakout") score += 7;
if (setupType === "Momentum") score += 6;
if (setupType === "EMA Bounce") score += 5;

if (regimeInfo.regime === "BULLISH") score += 6;
else if (regimeInfo.regime === "NEUTRAL") score -= 5;

score = Math.max(1, Math.min(99, Math.round(score)));
if (score < minConfidence) continue;

const safeAtr = Number.isFinite(atr14) && atr14 > 0 ? atr14 : close * 0.025;
const signalStop = Math.max(close - safeAtr * 1.2, low20 * 0.988);
const signalRisk = Math.max(0.001, close - signalStop);

if (signalRisk <= 0 || signalRisk > close * 0.12) continue;

const signalTarget = close + signalRisk * 2.0;
const riskReward = (signalTarget - close) / signalRisk;

if (riskReward < minRiskReward) continue;

const nextBar = bars[i + 1];
if (!nextBar) continue;

const rawEntry = Number(nextBar.open || nextBar.close);
if (!Number.isFinite(rawEntry) || rawEntry <= 0) continue;

const entryPrice = applyCosts(rawEntry, "buy", settings);
const entryRisk = Math.max(entryPrice * 0.005, signalRisk);

const exitResult = simulatePaperStyleExit({
  bars,
  startIndex: i + 1,
  holdDays,
  entryPrice,
  entryRisk,
  settings
});

if (!Number.isFinite(exitResult.pnlR)) continue;

const trade = {
  symbol,
  setupType,
  entryDate: nextBar.date,
  exitDate: exitResult.exitDate,
  entry: Number(entryPrice.toFixed(4)),
  exit: Number(exitResult.exitPrice.toFixed(4)),
  stop: Number((entryPrice - entryRisk).toFixed(4)),
  finalStop: Number(exitResult.finalStop.toFixed(4)),
  target: Number(exitResult.target1.toFixed(4)),
  target1: Number(exitResult.target1.toFixed(4)),
  target2: Number(exitResult.target2.toFixed(4)),
  confidence: score,
  pnlR: Number(exitResult.pnlR.toFixed(2)),
  exitReason: exitResult.exitReason,
  partialDone: exitResult.partialDone,
  ambiguousBar: exitResult.ambiguousBar,
  marketRegime: regimeInfo.regime,
  marketBreadth: regimeInfo.breadth,
  marketVolatility: regimeInfo.volatility,
  marketVixProxy: regimeInfo.vix,
  volumeRatio: Number(volumeRatio.toFixed(2))
};

if (!shouldCountTrade(trade.entryDate)) {
  i += Math.max(3, Math.floor(holdDays / 2));
  continue;
}

trades.push(trade);
i += Math.max(3, Math.floor(holdDays / 2));
```

}

return {
symbol,
trades,
summary: summarizeTrades(trades),
setupStats: summarizeBySetup(trades)
};
}

function runPortfolioBacktest(barsBySymbol, options = {}) {
const excluded = new Set(["SPY", "QQQ", "DIA", "IWM", "VIX", "^VIX"]);

const results = Object.entries(barsBySymbol || {})
.filter(([symbol]) => !excluded.has(symbol))
.map(([symbol, bars]) => runSignalBacktest(symbol, bars, options, barsBySymbol));

const allTrades = results.flatMap(result => result.trades || []);

const edges = {};
for (const result of results) {
edges[result.symbol] = {
symbol: result.symbol,
summary: result.summary,
setupStats: result.setupStats,
updatedAt: new Date().toISOString()
};
}

return {
options,
createdAt: new Date().toISOString(),
lookback: options.lookback || "daily historical bars, historical market regime applied",
method: "signal backtest with next-bar entry, historical regime, slippage/spread, partial exits, breakeven, target 2",
perSymbol: results,
summary: summarizeTrades(allTrades),
setupStats: summarizeBySetup(allTrades),
trades: allTrades.slice(-1000),
edges
};
}

function optimizerPassesGuardrails(summary, options = {}) {
const trades = Number(summary.trades || 0);
const expectancyR = Number(summary.expectancyR || 0);
const profitFactor = Number(summary.profitFactor || 0);
const maxDrawdownR = Number(summary.maxDrawdownR || 999);

return (
trades >= Number(options.minOptimizerTrades || 60) &&
expectancyR >= Number(options.minOptimizerExpectancyR || 0.15) &&
profitFactor >= Number(options.minOptimizerProfitFactor || 1.25) &&
maxDrawdownR <= Number(options.maxOptimizerDrawdownR || 10)
);
}

function optimize(barsBySymbol, baseOptions = {}) {
const runs = [];

for (const minConfidence of [68, 72, 76, 80]) {
for (const minRiskReward of [1.8, 2.0, 2.2]) {
for (const holdDays of [7, 10, 14]) {
const options = {
...baseOptions,
minConfidence,
minRiskReward,
holdDays
};

```
    const run = runPortfolioBacktest(barsBySymbol, options);
    run.options = options;

    const safe = optimizerPassesGuardrails(run.summary, baseOptions);

    run.optimizerScore = safe
      ? Number(
          (
            Number(run.summary.expectancyR || 0) * 60 +
            Number(run.summary.profitFactor || 0) * 12 -
            Number(run.summary.maxDrawdownR || 0) * 1.5
          ).toFixed(2)
        )
      : -999;

    run.guardrailPassed = safe;
    runs.push(run);
  }
}
```

}

runs.sort((a, b) => b.optimizerScore - a.optimizerScore);

return {
createdAt: new Date().toISOString(),
guardrail: "Best settings only valid if sample >= 60 trades, expectancy >= 0.15R, profit factor >= 1.25, and max drawdown <= 10R.",
best: runs[0] || null,
runs: runs.slice(0, 25)
};
}

module.exports = {
runSignalBacktest,
runPortfolioBacktest,
optimize,
summarizeTrades,
summarizeBySetup,
historicalRegimeAtIndex,
optimizerPassesGuardrails
};

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
  const vixPause = Number.isFinite(vix) && vix > 25;
  const vixHalt  = Number.isFinite(vix) && vix > 30;
  let regime = "NEUTRAL";
  if (breadth >= 55 && indexScore >= 6 && !vixPause) regime = "BULLISH";
  else if (breadth >= 45 && indexScore >= 4 && !vixPause) regime = "NEUTRAL";
  if (breadth < 35 || indexScore <= 2 || vixHalt) regime = "BEARISH";
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

function runSignalBacktest(symbol, bars, options = {}, barsBySymbol = {}) {
  const minConf  = options.minConfidence || 72;
  const minRR    = options.minRiskReward || 2.0;
  const slipPct  = options.slippagePct   ?? 0.05;
  const sprdPct  = options.spreadPct     ?? 0.03;
  const holdDays = options.holdDays      || 10;
  const settings = { slippagePct: slipPct, spreadPct: sprdPct };

  // Walk-forward date filter — only count trades in test window
  const countFrom = options.countTradesFromDate || null;
  const countTo   = options.countTradesToDate   || null;
  function shouldCount(entryDate) {
    if (!entryDate) return true;
    if (countFrom && entryDate < countFrom) return false;
    if (countTo   && entryDate > countTo)   return false;
    return true;
  }

  const trades = [];
  if (!Array.isArray(bars) || bars.length < 150) {
    return { symbol, trades: [], summary: emptySummary(), setupStats: {} };
  }

  const spyBars  = barsBySymbol.SPY || [];
  const spyCloses = spyBars.map(b => b.close);
  const etfSymbol = sectorEtfOf(symbol);
  const etfBars   = barsBySymbol[etfSymbol] || [];

  // Cache regime every 10 bars for speed
  // Regime cache: recalculate every 50 bars (balance accuracy vs performance)
  // historicalBreadthAtIndex is expensive - loops all symbols
  const regimeCache = new Map();
  function getCachedRegime(idx) {
    const bucket = Math.floor(idx / 50) * 50;
    if (!regimeCache.has(bucket)) {
      regimeCache.set(bucket, historicalRegimeAtIndex(barsBySymbol, bucket));
    }
    return regimeCache.get(bucket);
  }

  for (let i = 100; i < bars.length - holdDays - 2; i++) {
    const slice  = bars.slice(0, i + 1);
    const closes = slice.map(b => b.close);
    const close  = closes.at(-1);

    const ema20v = ema(closes, 20);
    const ema50v = ema(closes, 50);
    if (!ema20v || !ema50v) continue;
    const trendBull = close > ema20v && close > ema50v;
    if (!trendBull || ema20v <= ema50v) { i += 2; continue; }

    const sma200 = closes.length >= 200 ? sma(closes, 200) : null;
    if (sma200 && close < sma200) { i += 2; continue; }

    const rsi14  = rsi(closes, 14);
    if (!rsi14 || rsi14 < 45 || rsi14 > 76) continue;

    const atr14   = atr(slice, 14);
    const adxVal  = adx(slice, 14) || 0;
    const macdData = macd(closes);
    if (ema20v && close > ema20v * 1.09) continue;

    let score = 0;
    if (close > ema20v) score += 14;
    if (close > ema50v) score += 13;
    if (sma200 && close > sma200) score += 12;
    if (ema20v > ema50v) score += 10;
    if (macdData?.bullish) score += 10;
    if (macdData?.crossing) score += 5;
    if (adxVal > 25) score += 8; else if (adxVal > 18) score += 4;
    if (rsi14 >= 50 && rsi14 <= 68) score += 8; else if (rsi14 > 68 && rsi14 <= 74) score += 3;

    const volumes = slice.map(b => b.volume || 0);
    const avgVol  = sma(volumes, 20) || 1;
    const volRatio = slice.at(-1).volume / avgVol;
    if (volRatio >= 1.3) score += 8; else if (volRatio >= 1.1) score += 3;

    if (spyCloses.length > 22) {
      const spySlice = spyCloses.slice(0, i + 1);
      const spyMove  = spySlice.length > 22 ? ((spySlice.at(-1) - spySlice[spySlice.length - 22]) / spySlice[spySlice.length - 22]) * 100 : 0;
      const stockMove = closes.length > 22 ? ((close - closes[closes.length - 22]) / closes[closes.length - 22]) * 100 : 0;
      if (stockMove > spyMove + 2) score += 10;
      else if (stockMove > spyMove) score += 5;
    }

    if (etfBars.length > 50) {
      const etfSlice  = etfBars.slice(0, i + 1);
      const etfCloses = etfSlice.map(b => b.close);
      const etfEma20  = ema(etfCloses, 20);
      const etfEma50  = ema(etfCloses, 50);
      if (etfEma20 && etfEma50 && etfCloses.at(-1) > etfEma20 && etfEma20 > etfEma50) score += 10;
      else if (etfEma20 && etfCloses.at(-1) < etfEma20) score -= 12;
    }

    const recent20 = slice.slice(-20);
    const high20   = Math.max(...recent20.map(b => b.high));
    const setupType = classifySetup(close, high20, ema20v, ema50v, macdData, adxVal);
    if (setupType === "Breakout") score += 7;
    if (setupType === "Momentum") score += 6;
    if (setupType === "EMA Bounce") score += 5;

    // CRITICAL FIX: use historical regime — no bullish assumption
    const regimeInfo = getCachedRegime(i);
    if (regimeInfo.regime === "BULLISH") {
      score += 6;
    } else if (regimeInfo.regime === "NEUTRAL") {
      score -= 5;
    } else if (regimeInfo.regime === "BEARISH") {
      i += 2; continue; // skip longs in bearish regime
    }

    score = Math.max(1, Math.min(99, Math.round(score)));
    if (score < minConf) continue;
    if (adxVal > 0 && adxVal < 20) continue;

    const low20    = Math.min(...recent20.map(b => b.low));
    const safeAtr  = Number.isFinite(atr14) && atr14 > 0 ? atr14 : close * 0.025;
    const stop     = Math.max(close - safeAtr * 1.2, low20 * 0.988);
    const risk     = Math.max(0.001, close - stop);
    if (risk <= 0 || risk > close * 0.12) continue;

    const target = close + risk * 2.0;
    const rrNum  = (target - close) / risk;
    if (rrNum < minRR) continue;

    const nextBar = bars[i + 1];
    if (!nextBar) continue;
    const entryPrice = applyCosts(nextBar.open || nextBar.close, "buy", settings);
    const entryRisk  = Math.max(entryPrice * 0.005, risk);
    const entryStop  = entryPrice - entryRisk;
    const entryTarget = entryPrice + entryRisk * 2.0;

    let exit = null, exitReason = "Timed exit";
    let exitDate = bars[Math.min(i + 1 + holdDays, bars.length - 1)].date;

    for (let j = i + 2; j <= i + 1 + holdDays && j < bars.length; j++) {
      const bar = bars[j];
      if (bar.low <= entryStop) {
        exit = applyCosts(entryStop, "sell", settings);
        exitReason = "Stop hit"; exitDate = bar.date; break;
      }
      if (bar.high >= entryTarget) {
        exit = applyCosts(entryTarget, "sell", settings);
        exitReason = "Target hit"; exitDate = bar.date; break;
      }
    }

    if (exit === null) {
      const eb = bars[Math.min(i + 1 + holdDays, bars.length - 1)];
      exit = applyCosts(eb.close, "sell", settings);
      exitDate = eb.date;
    }

    const pnlR = Number(((exit - entryPrice) / entryRisk).toFixed(2));
    if (!Number.isFinite(pnlR)) continue;

    const trade = {
      symbol, setupType,
      entryDate: nextBar.date, exitDate,
      entry: Number(entryPrice.toFixed(4)), exit: Number(exit.toFixed(4)),
      stop: Number(entryStop.toFixed(4)), target: Number(entryTarget.toFixed(4)),
      confidence: score, pnlR, exitReason,
      marketRegime: regimeInfo.regime,
      marketBreadth: regimeInfo.breadth,
      marketVolatility: regimeInfo.volatility
    };

    // Walk-forward date filter — only count trades in test window
    if (!shouldCount(trade.entryDate)) {
      i += Math.max(3, Math.floor(holdDays / 2));
      continue;
    }

    trades.push(trade);
    i += Math.max(3, Math.floor(holdDays / 2));
  }

  return { symbol, trades, summary: summarizeTrades(trades), setupStats: summarizeBySetup(trades) };
}

// ─── Portfolio Backtest ───────────────────────────────────────────────────────

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
    lookback: options.lookback || "max daily — historical regime applied",
    method: "signal backtest + next-bar entry + historical regime",
    perSymbol: results, summary: summarizeTrades(allTrades),
    trades: allTrades.slice(-1000), edges
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
  runSignalBacktest, runPortfolioBacktest, optimize,
  summarizeTrades, summarizeBySetup,
  historicalRegimeAtIndex
};
