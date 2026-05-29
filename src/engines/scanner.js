const { round, percentMove } = require("../data/marketData");
const { sectorEtfOf } = require("../data/sectorMap");

// Optional fundamentals — won't crash if not connected
let getFundamentalSnapshot = null, getCatalystSnapshot = null;
try { ({ getFundamentalSnapshot, getCatalystSnapshot } = require("../data/fundamentals")); } catch {}

// ─── Technical Indicators ──────────────────────────────────────────────────

function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(-period).filter(Number.isFinite);
  if (slice.length < period) return null;
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const clean = values.filter(Number.isFinite);
  if (clean.length < period) return null;
  const k = 2 / (period + 1);
  let cur = clean.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < clean.length; i++) cur = clean[i] * k + cur * (1 - k);
  return cur;
}

function emaArray(values, period) {
  // Returns full EMA array for MACD calculation
  if (!Array.isArray(values) || values.length < period) return [];
  const clean = values.filter(Number.isFinite);
  if (clean.length < period) return [];
  const k = 2 / (period + 1);
  const result = new Array(period - 1).fill(null);
  let cur = clean.slice(0, period).reduce((s, v) => s + v, 0) / period;
  result.push(cur);
  for (let i = period; i < clean.length; i++) {
    cur = clean[i] * k + cur * (1 - k);
    result.push(cur);
  }
  return result;
}

function macd(closes) {
  // Returns { macdLine, signalLine, histogram, bullish, crossing }
  // Fix: build full signal-line array so crossing compares prev MACD to prev signal (not current signal)
  if (!Array.isArray(closes) || closes.length < 40) return null;
  const ema12arr = emaArray(closes, 12);
  const ema26arr = emaArray(closes, 26);

  // Build MACD line array (same length as closes)
  const macdArr = closes.map((_, i) =>
    ema12arr[i] != null && ema26arr[i] != null ? ema12arr[i] - ema26arr[i] : null
  );

  // Build signal line array from valid MACD values using proper EMA
  // We need the signal line as a full array aligned with macdArr
  const validMacdValues = macdArr.filter(v => v != null);
  if (validMacdValues.length < 9) return null;

  // Calculate signal line EMA(9) over MACD values, building full array
  const signalArr = [];
  let sigVal = null;
  const k = 2 / (9 + 1);
  let seedCount = 0;
  let seedSum = 0;

  for (let i = 0; i < macdArr.length; i++) {
    if (macdArr[i] == null) { signalArr.push(null); continue; }
    if (sigVal === null) {
      seedSum += macdArr[i];
      seedCount++;
      if (seedCount === 9) {
        sigVal = seedSum / 9;
        signalArr.push(sigVal);
      } else {
        signalArr.push(null);
      }
    } else {
      sigVal = macdArr[i] * k + sigVal * (1 - k);
      signalArr.push(sigVal);
    }
  }

  const lastMacd = macdArr.at(-1);
  const prevMacd = macdArr.slice(0, -1).filter(v => v != null).at(-1);
  const lastSignal = signalArr.at(-1);
  const prevSignal = signalArr.slice(0, -1).filter(v => v != null).at(-1);

  if (lastMacd == null || lastSignal == null) return null;

  const histogram = lastMacd - lastSignal;
  const bullish = lastMacd > lastSignal;

  // Fix: true crossover = prev MACD was BELOW prev signal, now ABOVE current signal
  const crossing = prevMacd != null && prevSignal != null &&
    prevMacd <= prevSignal && lastMacd > lastSignal;

  return {
    macdLine: round(lastMacd, 4),
    signalLine: round(lastSignal, 4),
    histogram: round(histogram, 4),
    bullish,
    crossing
  };
}

function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    if (ch >= 0) gains += ch; else losses -= ch;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function atr(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length <= period) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return sma(trs, period);
}

function adx(bars, period = 14) {
  // Returns ADX value — measures trend strength regardless of direction
  // ADX > 20 = trending, ADX > 25 = strong trend
  if (!Array.isArray(bars) || bars.length < period * 2 + 2) return null;
  const dmPlus = [], dmMinus = [], tr = [];
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].high, low = bars[i].low;
    const prevHigh = bars[i - 1].high, prevLow = bars[i - 1].low, prevClose = bars[i - 1].close;
    dmPlus.push(high - prevHigh > prevLow - low ? Math.max(high - prevHigh, 0) : 0);
    dmMinus.push(prevLow - low > high - prevHigh ? Math.max(prevLow - low, 0) : 0);
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const smoothTr = sma(tr.slice(-period * 2), period);
  const smoothDmPlus = sma(dmPlus.slice(-period * 2), period);
  const smoothDmMinus = sma(dmMinus.slice(-period * 2), period);
  if (!smoothTr || smoothTr === 0) return null;
  const diPlus = (smoothDmPlus / smoothTr) * 100;
  const diMinus = (smoothDmMinus / smoothTr) * 100;
  const diSum = diPlus + diMinus;
  if (diSum === 0) return null;
  return Math.abs(diPlus - diMinus) / diSum * 100;
}

function bollingerBands(closes, period = 20, stdDev = 2) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: mean + stdDev * std,
    middle: mean,
    lower: mean - stdDev * std,
    bandwidth: round((stdDev * 2 * std) / mean * 100, 2),
    pctB: round((closes.at(-1) - (mean - stdDev * std)) / (stdDev * 2 * std), 2)
  };
}

// ─── VWAP Calculation ────────────────────────────────────────────────────────
// VWAP = Volume Weighted Average Price — most reliable intraday anchor
// We calculate it from daily bars as a 20-day VWAP approximation
// Rule: only long if price is above VWAP

function calcVWAP(bars, period = 20) {
  if (!Array.isArray(bars) || bars.length < period) return null;
  const slice = bars.slice(-period);
  let totalPV = 0, totalVol = 0;
  for (const bar of slice) {
    const typical = (bar.high + bar.low + bar.close) / 3;
    const vol = Number(bar.volume || 0);
    totalPV += typical * vol;
    totalVol += vol;
  }
  return totalVol > 0 ? totalPV / totalVol : null;
}

// ─── Candle Quality Check ─────────────────────────────────────────────────────
// Rule 5: candle body must be > 50% of candle range (no wick-dominated candles)
// Weak candles = indecision = unreliable breakout

function candleQuality(bar) {
  if (!bar) return { strong: false, bodyPct: 0 };
  const range = bar.high - bar.low;
  if (range <= 0) return { strong: false, bodyPct: 0 };
  const body = Math.abs(bar.close - bar.open);
  const bodyPct = (body / range) * 100;
  return {
    strong: bodyPct >= 50,          // body fills at least half the candle
    bodyPct: round(bodyPct, 1),
    bullish: bar.close > bar.open   // green candle
  };
}

// ─── Setup Classification ──────────────────────────────────────────────────

function classifySetup(price, high20, low20, ema20, ema50, sma200, rsi14, macdData, adxVal, bb) {
  // Breakout: price near 20-day high with momentum
  if (price >= high20 * 0.988 && rsi14 >= 50 && rsi14 <= 72) return "Breakout";
  // EMA Bounce: pulled back to EMA20 in uptrend, bouncing
  if (price > ema50 && price <= ema20 * 1.015 && price >= ema20 * 0.985 && ema20 > ema50) return "EMA Bounce";
  // Momentum: strong trend + MACD bullish + above all MAs
  if (macdData?.bullish && price > ema20 && price > ema50 && adxVal > 20) return "Momentum";
  // Bollinger squeeze breakout
  if (bb && bb.pctB > 0.8 && bb.bandwidth < 8 && price > ema20) return "Squeeze Breakout";
  // Pullback: standard pullback in uptrend
  if (price > ema20 && ema20 > ema50) return "Pullback";
  return "Watch";
}

// ─── Historical Edge Scoring ───────────────────────────────────────────────

function historicalScore(edge, setupType, settings) {
  if (!edge || !edge.summary) return {
    score: 0, grade: "NO DATA", passed: !settings.requireHistoricalEdge,
    warning: "No historical data yet. The system is still building its proof.",
    stats: null
  };
  const st = edge.setupStats?.[setupType] || edge.summary;
  const trades = Number(st.trades || 0);
  const expectancyR = Number(st.expectancyR || 0);
  const profitFactor = Number(st.profitFactor || 0);
  const winRate = Number(st.winRate || 0);
  let score = 0;
  if (trades >= settings.minHistoricalTrades) score += 25;
  if (expectancyR >= settings.minHistoricalExpectancyR) score += 30;
  if (profitFactor >= settings.minHistoricalProfitFactor) score += 25;
  if (winRate >= 52) score += 10;
  if ((st.maxDrawdownR || 999) <= 8) score += 10;
  const passed = trades >= settings.minHistoricalTrades &&
    expectancyR >= settings.minHistoricalExpectancyR &&
    profitFactor >= settings.minHistoricalProfitFactor;
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    grade: score >= 80 ? "ELITE EDGE" : score >= 60 ? "STRONG EDGE" : score >= 40 ? "FAIR EDGE" : "WEAK EDGE",
    passed,
    warning: passed ? "" : "Historical edge is still building. Treat with extra caution.",
    stats: st
  };
}

// ─── Market Regime ─────────────────────────────────────────────────────────

function findSectorLeader(signals) {
  const { sectorOf } = require("../data/sectorMap");
  const sectorStrength = {};
  for (const s of signals) {
    const sector = sectorOf(s.symbol);
    if (!sectorStrength[sector]) sectorStrength[sector] = { total: 0, count: 0 };
    sectorStrength[sector].total += s.confidence || 0;
    sectorStrength[sector].count += 1;
  }
  let best = "TECHNOLOGY", bestScore = 0;
  for (const [sector, data] of Object.entries(sectorStrength)) {
    const avg = data.count ? data.total / data.count : 0;
    if (avg > bestScore) { bestScore = avg; best = sector; }
  }
  return best;
}

// Calculate VIX equivalent from SPY historical volatility
// Used when Yahoo Finance blocks ^VIX from server (common on cloud hosts)
// 20-day annualised standard deviation of daily log returns × 100
function calcSpyVix(spyBars, period = 20) {
  if (!Array.isArray(spyBars) || spyBars.length < period + 2) return 18; // neutral default
  const closes = spyBars.map(b => b.close).filter(Number.isFinite);
  if (closes.length < period + 1) return 18;
  const recent = closes.slice(-period - 1);
  const returns = [];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i - 1] > 0) returns.push(Math.log(recent[i] / recent[i - 1]));
  }
  if (returns.length < 5) return 18;
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance = returns.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / returns.length;
  const annualisedVol = Math.sqrt(variance) * Math.sqrt(252) * 100;
  // Clamp to realistic VIX range
  return Math.max(8, Math.min(80, annualisedVol));
}

function marketRegimeFromSignals(signals, vix, barsBySymbol = {}) {
  const excluded = new Set(["SPY","QQQ","DIA","IWM"]);
  const universe = signals.filter(s => !excluded.has(s.symbol));
  const breadth = universe.length
    ? Math.round((universe.filter(s => s.trend === "UP").length / universe.length) * 100)
    : 50;

  let volatility = "MEDIUM";
  if (Number.isFinite(vix)) {
    volatility = vix < 18 ? "LOW" : vix < 25 ? "MEDIUM" : vix < 30 ? "ELEVATED" : "HIGH";
  }

  const vixPause = Number.isFinite(vix) && vix > 25;
  const vixHalt  = Number.isFinite(vix) && vix > 30;

  // SPY/QQQ structure — professional regime model using MA layers + slope
  let spyScore = 0, qqqScore = 0;
  for (const [etfSym, which] of [["SPY", 0], ["QQQ", 1]]) {
    const etfBars = barsBySymbol[etfSym] || [];
    if (etfBars.length >= 50) {
      const ec = etfBars.map(b => b.close);
      const price = ec.at(-1);
      const e20 = ema(ec, 20), e50 = ema(ec, 50);
      const s200 = ec.length >= 200 ? sma(ec, 200) : null;
      let sc = 0;
      if (e20 && price > e20) sc++;
      if (e50 && price > e50) sc++;
      if (s200 && price > s200) sc++;
      if (e20 && e50 && e20 > e50) sc++; // short-term > medium-term
      if (ec.length >= 55) {
        const e50prev = ema(ec.slice(0, -5), 50);
        if (e50 && e50prev && e50 > e50prev) sc++; // 50-day slope rising
      }
      if (which === 0) spyScore = sc; else qqqScore = sc;
    }
  }
  const indexScore = spyScore + qqqScore; // max 10

  let regime = "NEUTRAL";
  if (breadth >= 55 && indexScore >= 6 && !vixPause) regime = "BULLISH";
  else if (breadth >= 45 && indexScore >= 4 && !vixPause) regime = "NEUTRAL";
  if (breadth < 35 || indexScore <= 2 || vixHalt) regime = "BEARISH";

  return { regime, breadth, volatility, vixPause, vixHalt, spyScore, qqqScore, indexScore };
}

// ─── Sector ETF Momentum Check ────────────────────────────────────────────────
// Checks if the sector ETF for this stock is in an uptrend
// A stock fighting a weak sector is much more likely to fail
function getSectorEtfScore(symbol, barsBySymbol) {
  const etf = sectorEtfOf(symbol);
  if (etf === "SPY") return { score: 50, bullish: null, etf, reason: "Using SPY as proxy" };
  
  const bars = barsBySymbol[etf];
  if (!bars || bars.length < 50) return { score: 50, bullish: null, etf, reason: "No sector ETF data" };
  
  const closes = bars.map(b => b.close);
  const price = closes.at(-1);
  const ema20v = ema(closes, 20);
  const ema50v = ema(closes, 50);
  const rsi14v = rsi(closes, 14);
  
  if (!ema20v || !ema50v) return { score: 50, bullish: null, etf, reason: "Insufficient sector data" };
  
  // Score the sector ETF trend
  let score = 0;
  const reasons = [];
  
  if (price > ema20v) { score += 35; reasons.push(`${etf} above EMA20`); }
  else reasons.push(`${etf} below EMA20 — sector headwind`);
  
  if (ema20v > ema50v) { score += 35; reasons.push(`${etf} short-term trend up`); }
  else reasons.push(`${etf} short-term trend weak`);
  
  if (rsi14v && rsi14v >= 50) { score += 30; reasons.push(`${etf} RSI bullish`); }
  else reasons.push(`${etf} RSI weak`);
  
  const bullish = score >= 70;
  return { score, bullish, etf, reasons, price: round(price), ema20: round(ema20v) };
}

// ─── Base Quality / VCP Detection ────────────────────────────────────────────
// Scores base depth, contraction, volume dry-up, pivot proximity
// Inspired by Minervini and O'Neil style base analysis

function maxHigh(bars) { return Math.max(...bars.map(b => Number(b.high)).filter(Number.isFinite)); }
function minLow(bars)  { return Math.min(...bars.map(b => Number(b.low)).filter(Number.isFinite)); }
function avgVolume(bars) {
  const vols = bars.map(b => Number(b.volume || 0)).filter(Number.isFinite);
  return vols.length ? vols.reduce((s, v) => s + v, 0) / vols.length : null;
}

function detectBaseQuality(bars) {
  if (!Array.isArray(bars) || bars.length < 80) {
    return { score: 0, label: "NO BASE DATA", reasons: [], warnings: ["Not enough history to evaluate base quality."] };
  }
  const recent   = bars.slice(-63);
  const last20   = bars.slice(-20);
  const last10   = bars.slice(-10);
  const prior20  = bars.slice(-40, -20);
  const baseHigh = maxHigh(recent);
  const baseLow  = minLow(recent);
  const lastPrice = bars.at(-1).close;
  const baseDepthPct = baseHigh && baseLow ? ((baseHigh - baseLow) / baseHigh) * 100 : null;
  const range10  = maxHigh(last10) - minLow(last10);
  const range20  = maxHigh(last20) - minLow(last20);
  const range40  = maxHigh(bars.slice(-40)) - minLow(bars.slice(-40));
  const tightness10Pct = lastPrice ? (range10 / lastPrice) * 100 : null;
  const rangeContracting = Number.isFinite(range10) && Number.isFinite(range20) && Number.isFinite(range40) && range10 < range20 && range20 < range40;
  const vol10 = avgVolume(last10);
  const volPrior20 = avgVolume(prior20);
  const volumeDryUpPct = volPrior20 && vol10 ? ((volPrior20 - vol10) / volPrior20) * 100 : null;
  const pivotPrice = maxHigh(last20);
  const distanceFromPivotPct = pivotPrice && lastPrice ? ((lastPrice - pivotPrice) / pivotPrice) * 100 : null;
  let contractionCount = 0;
  const blocks = [bars.slice(-63, -42), bars.slice(-42, -21), bars.slice(-21)];
  const blockRanges = blocks.map(block => {
    if (!block.length) return null;
    const h = maxHigh(block), l = minLow(block), mid = (h + l) / 2;
    return mid ? ((h - l) / mid) * 100 : null;
  }).filter(Number.isFinite);
  for (let i = 1; i < blockRanges.length; i++) if (blockRanges[i] < blockRanges[i - 1]) contractionCount++;
  let failedBreakoutCount = 0;
  for (let i = Math.max(20, bars.length - 63); i < bars.length - 3; i++) {
    const priorHigh = maxHigh(bars.slice(i - 20, i));
    const breakout  = bars[i].close > priorHigh * 1.005;
    const failed    = breakout && bars[i + 1]?.close < priorHigh && bars[i + 2]?.close < priorHigh;
    if (failed) failedBreakoutCount++;
  }
  let score = 0;
  const reasons = [], warnings = [];
  if (baseDepthPct != null && baseDepthPct <= 25) { score += 20; reasons.push(`Base depth ${baseDepthPct.toFixed(1)}% is controlled.`); }
  else if (baseDepthPct != null && baseDepthPct <= 35) { score += 10; warnings.push(`Base depth ${baseDepthPct.toFixed(1)}% is a bit wide.`); }
  else if (baseDepthPct != null) warnings.push(`Base depth ${baseDepthPct.toFixed(1)}% is too deep for a clean growth setup.`);
  if (rangeContracting) { score += 20; reasons.push("Price ranges are contracting — sellers drying up."); }
  if (contractionCount >= 2) { score += 15; reasons.push("Multiple volatility contractions detected."); }
  else if (contractionCount === 1) score += 8;
  if (tightness10Pct != null && tightness10Pct <= 6) { score += 15; reasons.push(`Last 10-day range is tight at ${tightness10Pct.toFixed(1)}%.`); }
  else if (tightness10Pct != null && tightness10Pct > 10) warnings.push(`Last 10-day range is loose at ${tightness10Pct.toFixed(1)}%.`);
  if (volumeDryUpPct != null && volumeDryUpPct >= 20) { score += 15; reasons.push(`Volume dried up ${volumeDryUpPct.toFixed(0)}% — constructive base trait.`); }
  if (distanceFromPivotPct != null && distanceFromPivotPct >= -3 && distanceFromPivotPct <= 3) { score += 10; reasons.push("Price close to pivot — not extended."); }
  else if (distanceFromPivotPct != null && distanceFromPivotPct > 5) warnings.push("Price extended above pivot. Avoid chasing.");
  if (failedBreakoutCount === 0) score += 5;
  else { score -= Math.min(20, failedBreakoutCount * 8); warnings.push(`${failedBreakoutCount} failed breakout attempt(s) in the base.`); }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score, label: score >= 80 ? "ELITE BASE" : score >= 65 ? "STRONG BASE" : score >= 45 ? "FAIR BASE" : "WEAK BASE",
    baseLengthDays: recent.length,
    baseDepthPct: baseDepthPct != null ? Number(baseDepthPct.toFixed(1)) : null,
    contractionCount,
    lastContractionDepthPct: blockRanges.at(-1) != null ? Number(blockRanges.at(-1).toFixed(1)) : null,
    rangeTightness10d: tightness10Pct != null ? Number(tightness10Pct.toFixed(1)) : null,
    volumeDryUpPct: volumeDryUpPct != null ? Number(volumeDryUpPct.toFixed(1)) : null,
    pivotPrice: pivotPrice ? Number(pivotPrice.toFixed(2)) : null,
    distanceFromPivotPct: distanceFromPivotPct != null ? Number(distanceFromPivotPct.toFixed(1)) : null,
    failedBreakoutCount, reasons, warnings
  };
}

// ─── Setup-Specific Volume Scoring ────────────────────────────────────────────

function setupVolumeScore(setup, bars, volumeRatio, baseQuality = null) {
  const reasons = [], warnings = [];
  let score = 0;
  if (!Array.isArray(bars) || bars.length < 50 || !Number.isFinite(volumeRatio)) {
    return { score: 0, reasons, warnings: ["Volume data insufficient."] };
  }
  const last = bars.at(-1);
  const prev = bars.at(-2);
  const lastRed = last.close < last.open;
  const lastGreen = last.close >= last.open;
  const vol10 = avgVolume(bars.slice(-10));
  const priorVol20 = avgVolume(bars.slice(-40, -20));
  const dryUp = priorVol20 && vol10 ? ((priorVol20 - vol10) / priorVol20) * 100 : 0;
  if (setup === "Breakout") {
    if (volumeRatio >= 2.0) { score += 16; reasons.push(`Breakout volume excellent at ${volumeRatio.toFixed(1)}x average — real buyer conviction.`); }
    else if (volumeRatio >= 1.5) { score += 10; reasons.push(`Breakout volume confirms at ${volumeRatio.toFixed(1)}x average.`); }
    else if (volumeRatio >= 1.2) { score -= 4;  warnings.push(`Breakout volume only ${volumeRatio.toFixed(1)}x — needs at least 1.5x to confirm. Risk of false breakout.`); }
    else { score -= 14; warnings.push("Breakout volume weak. Real breakouts need 1.5x+ volume. High risk of failure."); }
  } else if (setup === "EMA Bounce") {
    if (lastGreen && prev && last.volume > prev.volume) { score += 8; reasons.push("Bounce volume improving from prior day."); }
    if (volumeRatio < 0.8) warnings.push("Bounce volume quiet — confirmation still light.");
  } else if (setup === "Squeeze Breakout") {
    if (dryUp >= 15 && volumeRatio >= 1.3) { score += 12; reasons.push("Volume dry-up then expansion — constructive breakout."); }
    else if (dryUp >= 15) { score += 5; reasons.push("Volume dried up during squeeze."); }
    else warnings.push("Squeeze lacks clear volume dry-up.");
  } else if (setup === "Pullback") {
    if (lastRed && volumeRatio >= 1.3) { score -= 10; warnings.push("Pullback on heavy red volume — possible distribution."); }
    else if (volumeRatio <= 0.9) { score += 6; reasons.push("Pullback volume quiet — constructive."); }
  } else if (setup === "Momentum") {
    if (volumeRatio >= 1.2) { score += 7; reasons.push("Momentum move has supportive volume."); }
  }
  if (baseQuality?.volumeDryUpPct >= 20 && volumeRatio >= 1.2) {
    score += 5; reasons.push("Volume pattern: dry-up followed by renewed demand.");
  }
  return { score, reasons, warnings };
}

// ─── Relative Strength Engine ─────────────────────────────────────────────────
// Calculates RS vs SPY over multiple timeframes — the way professional traders do it
// Higher RS = stock is outperforming the market = higher quality setup

function calcRelativeStrength(closes, spyCloses) {
  const rs = {};
  const periods = { rs1m: 21, rs3m: 63, rs6m: 126, rs12m: 252 };
  for (const [key, period] of Object.entries(periods)) {
    if (closes.length > period && spyCloses.length > period) {
      const stockMove = (closes.at(-1) - closes.at(-period - 1)) / closes.at(-period - 1) * 100;
      const spyMove   = (spyCloses.at(-1) - spyCloses.at(-period - 1)) / spyCloses.at(-period - 1) * 100;
      rs[key] = round(stockMove - spyMove, 2);
    } else {
      rs[key] = null;
    }
  }

  // RS acceleration: is 1M RS improving vs 3M RS?
  rs.rsAccelerating = rs.rs1m != null && rs.rs3m != null && rs.rs1m > rs.rs3m;

  // RS line new high: is current RS better than 63-day RS high?
  if (closes.length >= 64 && spyCloses.length >= 64) {
    const rsLine = closes.map((c, i) => {
      const sc = spyCloses[i];
      return sc && sc > 0 ? c / sc : null;
    }).filter(v => v != null);
    const rsHigh63 = rsLine.length >= 63 ? Math.max(...rsLine.slice(-63)) : null;
    const rsHigh252 = rsLine.length >= 252 ? Math.max(...rsLine.slice(-252)) : null;
    rs.rsLineNewHigh63  = rsHigh63  ? rsLine.at(-1) >= rsHigh63  * 0.995 : false;
    rs.rsLineNewHigh252 = rsHigh252 ? rsLine.at(-1) >= rsHigh252 * 0.995 : false;
  }

  return rs;
}

// Calculate RS percentile rank across all signals (call after building all signals)
function addRsPercentiles(signals) {
  const rs3mValues = signals.map(s => s.rs?.rs3m).filter(v => v != null).sort((a, b) => a - b);
  for (const s of signals) {
    if (s.rs?.rs3m != null && rs3mValues.length > 0) {
      const rank = rs3mValues.filter(v => v <= s.rs.rs3m).length;
      s.rs.rsPercentile = Math.round((rank / rs3mValues.length) * 100);
    }
  }
  return signals;
}

// ─── Stage Analysis (Stan Weinstein) ─────────────────────────────────────────
// Stage 1 = Basing  Stage 2 = Uptrend (BUY)  Stage 3 = Topping  Stage 4 = Downtrend
// Professional rule: ONLY buy Stage 2. Never buy any other stage.

function detectStage(bars) {
  if (!Array.isArray(bars) || bars.length < 30) return { stage: 0, label: "UNKNOWN", reason: "Not enough data." };
  const closes = bars.map(b => b.close);
  const price = closes.at(-1);

  // Use 30-week MA (150 trading days) as the stage divider
  const ma30w = closes.length >= 150 ? sma(closes, 150) : sma(closes, closes.length);
  const ma10w = closes.length >= 50  ? sma(closes, 50)  : null;
  if (!ma30w) return { stage: 0, label: "UNKNOWN", reason: "Not enough data for stage." };

  // Is the 30-week MA rising or falling?
  const ma30wPrev = closes.length >= 155 ? sma(closes.slice(0, -5), 150) : null;
  const maRising  = ma30wPrev ? ma30w > ma30wPrev : null;
  const maFalling = ma30wPrev ? ma30w < ma30wPrev : null;

  // Price position relative to 30-week MA
  const aboveMa  = price > ma30w;
  const pctAbove = ((price - ma30w) / ma30w) * 100;

  // RS trend — is relative strength line rising?
  const rsRising = closes.length >= 10
    ? closes.at(-1) / (closes.at(-1)) >= closes.at(-10) / (closes.at(-10))  // simplified
    : null;

  let stage, label, reason;

  if (aboveMa && maRising !== false) {
    stage = 2; label = "STAGE 2 — Uptrend";
    reason = `Price above rising 30-week MA (${round(ma30w)}) — markup phase. This is where the best gains happen.`;
  } else if (!aboveMa && maFalling) {
    stage = 4; label = "STAGE 4 — Downtrend";
    reason = `Price below falling 30-week MA — distribution/decline. Avoid completely.`;
  } else if (!aboveMa && !maFalling) {
    stage = 1; label = "STAGE 1 — Basing";
    reason = `Price below 30-week MA but MA is flattening — stock is basing. Wait for Stage 2 confirmation.`;
  } else {
    stage = 3; label = "STAGE 3 — Topping";
    reason = `Price above MA but MA turning down — potential top forming. Exit longs, don't enter.`;
  }

  return { stage, label, reason, ma30w: round(ma30w), pctAbove: round(pctAbove, 1), maRising };
}

// ─── Minervini Trend Template ─────────────────────────────────────────────────
// Mark Minervini's 7-point checklist — ALL must pass for highest quality trades
// This is the filter that separates market leaders from laggards

function trendTemplate(bars) {
  if (!Array.isArray(bars) || bars.length < 100) {
    return { passes: false, score: 0, checks: [], reason: "Not enough data for trend template." };
  }
  const closes = bars.map(b => b.close);
  const price = closes.at(-1);

  const sma150 = closes.length >= 150 ? sma(closes, 150) : null;
  const sma200v = closes.length >= 200 ? sma(closes, 200) : null;
  const sma200_20ago = closes.length >= 220 ? sma(closes.slice(0, -20), 200) : null;
  const high52 = Math.max(...closes.slice(-252));
  const low52  = Math.min(...closes.slice(-252));

  const checks = [];

  // 1. Price > 150-day MA
  checks.push({ name: "Price > 150-day MA", pass: sma150 ? price > sma150 : false,
    detail: sma150 ? `Price $${round(price)} vs 150-MA $${round(sma150)}` : "No data" });

  // 2. Price > 200-day MA
  checks.push({ name: "Price > 200-day MA", pass: sma200v ? price > sma200v : false,
    detail: sma200v ? `Price $${round(price)} vs 200-MA $${round(sma200v)}` : "No data" });

  // 3. 150-day MA > 200-day MA
  checks.push({ name: "150-MA > 200-MA", pass: sma150 && sma200v ? sma150 > sma200v : false,
    detail: sma150 && sma200v ? `150-MA $${round(sma150)} vs 200-MA $${round(sma200v)}` : "No data" });

  // 4. 200-day MA trending up (higher than 20 days ago)
  checks.push({ name: "200-MA trending up", pass: sma200v && sma200_20ago ? sma200v > sma200_20ago : false,
    detail: sma200v && sma200_20ago ? `200-MA up ${round(((sma200v - sma200_20ago)/sma200_20ago)*100, 1)}% in 20 days` : "No data" });

  // 5. Price at least 30% above 52-week low
  const aboveLow52Pct = low52 > 0 ? ((price - low52) / low52) * 100 : 0;
  checks.push({ name: "30%+ above 52-week low", pass: aboveLow52Pct >= 30,
    detail: `${round(aboveLow52Pct, 1)}% above 52-week low of $${round(low52)}` });

  // 6. Price within 25% of 52-week high
  const belowHigh52Pct = high52 > 0 ? ((high52 - price) / high52) * 100 : 100;
  checks.push({ name: "Within 25% of 52-week high", pass: belowHigh52Pct <= 25,
    detail: `${round(belowHigh52Pct, 1)}% below 52-week high of $${round(high52)}` });

  // 7. Price > 50-day MA (we use this as RS proxy)
  const ema50v = ema(closes, 50);
  checks.push({ name: "Price > 50-day MA", pass: ema50v ? price > ema50v : false,
    detail: ema50v ? `Price $${round(price)} vs 50-MA $${round(ema50v)}` : "No data" });

  const passed = checks.filter(c => c.pass).length;
  const total  = checks.length;
  const allPass = passed === total;

  return {
    passes: allPass,
    score: passed,
    total,
    checks,
    reason: allPass
      ? `All ${total} Minervini trend template checks pass — this is a true market leader.`
      : `${passed}/${total} trend template checks pass. Missing: ${checks.filter(c => !c.pass).map(c => c.name).join(", ")}.`
  };
}

// ─── Tight Weekly Closes (Minervini VCP refinement) ──────────────────────────
// Last 2-3 weeks of closes should be within 1.5% of each other
// Shows sellers completely exhausted — coiled spring ready to break out

function tightWeeklyCloses(bars) {
  if (!Array.isArray(bars) || bars.length < 15) return { tight: false, rangePct: null };
  // Use last 15 days as proxy for 3 weeks
  const recent = bars.slice(-15).map(b => b.close);
  const hi = Math.max(...recent);
  const lo = Math.min(...recent);
  const mid = (hi + lo) / 2;
  const rangePct = mid > 0 ? ((hi - lo) / mid) * 100 : null;
  return {
    tight: rangePct != null && rangePct <= 4,      // tight = 4% or less in 3 weeks
    veryTight: rangePct != null && rangePct <= 2,  // very tight = 2% or less
    rangePct: rangePct != null ? round(rangePct, 1) : null
  };
}

// ─── Market Follow-Through Day (William O'Neil) ───────────────────────────────
// After a correction, only start buying when SPY/QQQ has a follow-through day:
// A day with index up 1.7%+ on HIGHER volume than previous day, on day 4+ of rally
// This is the most reliable market re-entry signal

function detectFollowThrough(spyBars) {
  if (!Array.isArray(spyBars) || spyBars.length < 10) return { confirmed: false, reason: "Not enough SPY data." };
  const recent = spyBars.slice(-15);

  // Find the most recent low (correction bottom)
  let lowIdx = 0;
  for (let i = 1; i < recent.length - 3; i++) {
    if (recent[i].close < recent[lowIdx].close) lowIdx = i;
  }

  // Count days of rally attempt from the low
  const rallyDays = recent.length - 1 - lowIdx;
  if (rallyDays < 4) return {
    confirmed: false,
    reason: `Market only ${rallyDays} days into rally attempt. Need 4+ days before follow-through is valid.`
  };

  // Check if today is a follow-through day
  const today = recent.at(-1);
  const yesterday = recent.at(-2);
  const todayMove = yesterday.close > 0 ? ((today.close - yesterday.close) / yesterday.close) * 100 : 0;
  const volumeUp  = today.volume > yesterday.volume;
  const strongMove = todayMove >= 1.7;

  if (strongMove && volumeUp) {
    return {
      confirmed: true,
      reason: `Follow-through day confirmed — SPY up ${round(todayMove, 1)}% on higher volume on day ${rallyDays} of rally. Market re-entry signal active.`,
      rallyDays, todayMove: round(todayMove, 1)
    };
  }

  return {
    confirmed: false,
    inRally: true,
    rallyDays,
    reason: `SPY in ${rallyDays}-day rally but no follow-through yet (need 1.7%+ up day on higher volume).`
  };
}

// ─── Failed Breakout Detection ────────────────────────────────────────────────
// If price breaks out but closes in lower half of candle range = failed breakout
// Exit immediately — don't hold a failed breakout

function detectFailedBreakout(bars, setup) {
  if (setup !== "Breakout" && setup !== "Squeeze Breakout") return { failed: false };
  if (!Array.isArray(bars) || bars.length < 3) return { failed: false };

  const today = bars.at(-1);
  const yesterday = bars.at(-2);
  const twoDaysAgo = bars.at(-3);

  // Did we break out yesterday (or recently)?
  const recentHigh = Math.max(...bars.slice(-10, -1).map(b => b.high));
  const brokeOut = yesterday.close > recentHigh * 0.995;

  if (!brokeOut) return { failed: false };

  // Did today close in lower half of its range? (sign of rejection)
  const range = today.high - today.low;
  const closePosition = range > 0 ? (today.close - today.low) / range : 0.5;
  const weakClose = closePosition < 0.4; // closed in lower 40% of range

  // Did price drop back below the breakout level?
  const failedPullback = today.close < recentHigh * 0.995;

  if (weakClose || failedPullback) {
    return {
      failed: true,
      reason: weakClose
        ? `Breakout candle closed in the lower ${round((1 - closePosition) * 100, 0)}% of its range — weak close suggests rejection. Consider exiting.`
        : `Price broke out then fell back below pivot — classic failed breakout. Exit to protect capital.`
    };
  }

  return { failed: false };
}

// ─── Main Signal Builder ───────────────────────────────────────────────────

function buildSignal(symbol, bars, spyMove21, marketBias, settings = {}, historicalEdges = {}, barsBySymbol = {}, earningsCalendar = {}) {
  const closes = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume || 0);
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2] || last;
  const price = last.close;

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const sma200 = sma(closes, Math.min(200, closes.length));
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(bars, 14);
  const adxVal = adx(bars, 14);
  const macdData = macd(closes);
  const bb = bollingerBands(closes, 20, 2);

  const avgVol = sma(volumes, 20);
  const volumeRatio = avgVol && avgVol > 0 ? last.volume / avgVol : null;

  const move1 = percentMove(price, prev.close);
  const move21 = closes.length > 22 ? percentMove(closes[closes.length - 1], closes[closes.length - 22]) : 0;
  const relativeStrength = move21 - spyMove21;

  const recent20 = bars.slice(-20);
  const high20 = Math.max(...recent20.map(b => b.high));
  const low20 = Math.min(...recent20.map(b => b.low));

  const trendBull = price > ema20 && price > ema50 && (!sma200 || price > sma200);
  const setup = classifySetup(price, high20, low20, ema20, ema50, sma200, rsi14, macdData, adxVal, bb);

  // ── VWAP ──
  const vwap = calcVWAP(bars, 20);
  const aboveVwap = vwap ? price > vwap : null;
  const vwapDist = vwap ? round(((price - vwap) / vwap) * 100, 2) : null;

  // ── Candle Quality ──
  const candle = candleQuality(last);

  // ── Base Quality / VCP ──
  const baseQuality = detectBaseQuality(bars);

  // ── Relative Strength vs SPY ──
  const spyClosesForRs = (barsBySymbol.SPY || []).map(b => b.close);
  const rs = calcRelativeStrength(closes, spyClosesForRs);

  // ── Stage Analysis (Weinstein) ──
  const stageInfo = detectStage(bars);

  // ── Minervini Trend Template ──
  const trendTpl = trendTemplate(bars);

  // ── Tight Weekly Closes ──
  const weeklyTight = tightWeeklyCloses(bars);

  // ── Market Follow-Through Day ──
  const spyBarsForFTD = barsBySymbol.SPY || [];
  const followThrough = detectFollowThrough(spyBarsForFTD);

  // ── Failed Breakout Check ──
  const failedBO = detectFailedBreakout(bars, setup);

  // ── Sector ETF Check ──
  const sectorCheck = getSectorEtfScore(symbol, barsBySymbol);

  // ── Technical Scoring ──
  let technicalScore = 0;
  const reasons = [], warnings = [];

  // Trend alignment (most important)
  if (price > ema20) { technicalScore += 14; reasons.push("Price is above its 20-day moving average — short-term trend is up."); }
  else warnings.push("Price is below its 20-day moving average.");

  if (price > ema50) { technicalScore += 13; reasons.push("Price is above its 50-day moving average — medium-term trend is up."); }
  else warnings.push("Price is below its 50-day moving average.");

  if (sma200 && price > sma200) { technicalScore += 12; reasons.push("Price is above its 200-day average — big-picture trend is bullish."); }
  else if (sma200) warnings.push("Price is below its long-term 200-day average.");

  if (ema20 && ema50 && ema20 > ema50) { technicalScore += 10; reasons.push("Short-term average is above medium-term — healthy upward momentum."); }
  else warnings.push("Short-term average is not above medium-term average.");

  // MACD — new in v6
  if (macdData?.bullish) { technicalScore += 10; reasons.push("MACD shows bullish momentum."); }
  if (macdData?.crossing) { technicalScore += 5; reasons.push("MACD just crossed bullish — fresh momentum signal."); }
  if (macdData && !macdData.bullish) warnings.push("MACD is not showing bullish momentum yet.");

  // ADX — trend strength
  if (adxVal && adxVal > 25) { technicalScore += 8; reasons.push(`Trend strength (ADX ${round(adxVal)}) is strong — not a choppy market.`); }
  else if (adxVal && adxVal > 18) { technicalScore += 4; }
  else if (adxVal) warnings.push("Trend strength is weak — this could be a choppy, sideways move.");

  // Relative strength — multi-timeframe (professional standard)
  if (rs.rs3m != null && rs.rs3m > 10) { technicalScore += 12; reasons.push(`RS 3-month: +${rs.rs3m}% vs S&P 500 — strong leader.`); }
  else if (rs.rs3m != null && rs.rs3m > 3)  { technicalScore += 7;  reasons.push(`RS 3-month: +${rs.rs3m}% vs S&P 500 — outperforming.`); }
  else if (rs.rs3m != null && rs.rs3m > 0)  { technicalScore += 3; }
  else if (rs.rs3m != null)                 { technicalScore -= 6;  warnings.push(`RS 3-month: ${rs.rs3m}% vs S&P 500 — underperforming.`); }

  if (rs.rs1m != null && rs.rs1m > 5)  { technicalScore += 5; reasons.push(`RS 1-month: +${rs.rs1m}% — recent momentum.`); }
  if (rs.rsAccelerating)               { technicalScore += 5; reasons.push("RS accelerating — short-term strength improving vs long-term."); }
  if (rs.rsLineNewHigh63)              { technicalScore += 6; reasons.push("RS line at 63-day high — stock is a relative strength leader."); }
  if (rs.rsLineNewHigh252)             { technicalScore += 8; reasons.push("RS line at 52-week high — this is a true market leader."); }
  if (rs.rs6m != null && rs.rs6m < -10) warnings.push(`RS 6-month: ${rs.rs6m}% — weak on longer timeframe.`);

  // RSI
  if (rsi14 >= 50 && rsi14 <= 68) { technicalScore += 8; reasons.push(`RSI (${round(rsi14)}) is in a healthy bullish zone — not overbought.`); }
  else if (rsi14 > 68 && rsi14 <= 74) { technicalScore += 3; warnings.push(`RSI (${round(rsi14)}) is getting a bit high — risk of pullback.`); }
  else if (rsi14 > 74) warnings.push(`RSI (${round(rsi14)}) is overbought — avoid chasing this move.`);
  else warnings.push(`RSI (${round(rsi14)}) is not bullish enough yet.`);

  // Setup-specific volume scoring
  const volSetup = setupVolumeScore(setup, bars, volumeRatio, baseQuality);
  technicalScore += volSetup.score;
  for (const r of volSetup.reasons) reasons.push(r);
  for (const w of volSetup.warnings) warnings.push(w);
  // Small generic volume score still applies
  if (volumeRatio && volumeRatio >= 1.3) technicalScore += 3;
  else if (volumeRatio && volumeRatio < 0.8) technicalScore -= 3;

  // Base quality scoring
  if (baseQuality.score >= 80) { technicalScore += 12; reasons.push(`Base quality is elite: ${baseQuality.label}.`); }
  else if (baseQuality.score >= 65) { technicalScore += 8; reasons.push(`Base quality is strong: ${baseQuality.label}.`); }
  else if (baseQuality.score >= 45) technicalScore += 3;
  else if (setup === "Breakout" || setup === "Squeeze Breakout") {
    technicalScore -= 8;
    warnings.push("Breakout setup has weak base quality.");
  }
  for (const r of baseQuality.reasons || []) reasons.push(r);
  for (const w of baseQuality.warnings || []) warnings.push(w);

  // Support/resistance proximity
  const high52 = bars.length >= 252 ? Math.max(...bars.slice(-252).map(b => b.high)) : high20;
  const low52  = bars.length >= 252 ? Math.min(...bars.slice(-252).map(b => b.low))  : low20;
  const distFromResistance = ((high52 - price) / price) * 100;
  const distFromSupport    = ((price - low52) / price) * 100;
  if (distFromResistance < 1.5 && setup !== "Breakout") {
    technicalScore -= 8;
    warnings.push(`Price is within ${distFromResistance.toFixed(1)}% of 52-week high resistance — high chance of rejection here.`);
  } else if (distFromResistance > 5) {
    technicalScore += 4;
    reasons.push(`Good distance (${distFromResistance.toFixed(1)}%) from major resistance — room to run.`);
  }
  if (distFromSupport < 3) {
    warnings.push(`Price is close to 52-week low — risk of further selling.`);
  }

  // Setup bonus
  if (setup === "Breakout") { technicalScore += 7; reasons.push("Breaking out near a 20-day high."); }
  if (setup === "Momentum") { technicalScore += 6; reasons.push("Strong momentum setup — price and indicators aligned."); }
  if (setup === "EMA Bounce") { technicalScore += 5; reasons.push("Bouncing off key moving average in uptrend."); }
  if (setup === "Squeeze Breakout") { technicalScore += 7; reasons.push("Tight Bollinger Band squeeze breaking out — can lead to big moves."); }

  // ── Stage Analysis scoring ──
  if (stageInfo.stage === 2) {
    technicalScore += 12;
    reasons.push(`Stage 2 uptrend confirmed — 30-week MA is rising and price is above it. Best stage to buy.`);
  } else if (stageInfo.stage === 4) {
    technicalScore -= 20;
    warnings.push(`Stage 4 downtrend — ${stageInfo.reason} Avoid completely.`);
  } else if (stageInfo.stage === 1) {
    technicalScore -= 8;
    warnings.push(`Stage 1 basing — ${stageInfo.reason}`);
  } else if (stageInfo.stage === 3) {
    technicalScore -= 15;
    warnings.push(`Stage 3 topping — ${stageInfo.reason}`);
  }

  // ── Minervini Trend Template scoring ──
  if (trendTpl.passes) {
    technicalScore += 14;
    reasons.push(`All ${trendTpl.total} Minervini trend template checks pass — elite quality setup.`);
  } else if (trendTpl.score >= 5) {
    technicalScore += 7;
    reasons.push(`${trendTpl.score}/${trendTpl.total} trend template checks pass — strong but not elite.`);
  } else if (trendTpl.score >= 3) {
    technicalScore += 2;
  } else {
    technicalScore -= 8;
    warnings.push(`Only ${trendTpl.score}/${trendTpl.total} trend template checks pass. Missing: ${trendTpl.checks.filter(c => !c.pass).map(c => c.name).slice(0,2).join(", ")}.`);
  }

  // ── Tight Weekly Closes scoring ──
  if (weeklyTight.veryTight) {
    technicalScore += 10;
    reasons.push(`Very tight 3-week range (${weeklyTight.rangePct}%) — sellers completely exhausted. Coiled spring ready.`);
  } else if (weeklyTight.tight) {
    technicalScore += 5;
    reasons.push(`Tight 3-week range (${weeklyTight.rangePct}%) — constructive consolidation.`);
  } else if (weeklyTight.rangePct != null && weeklyTight.rangePct > 8) {
    warnings.push(`Wide 3-week range (${weeklyTight.rangePct}%) — too loose for a quality VCP entry.`);
  }

  // ── Market Follow-Through Day ──
  if (followThrough.confirmed) {
    technicalScore += 8;
    reasons.push(followThrough.reason);
  } else if (followThrough.inRally && followThrough.rallyDays >= 4) {
    reasons.push(`SPY in ${followThrough.rallyDays}-day rally attempt — watching for follow-through day.`);
  }

  // ── Failed Breakout Warning ──
  if (failedBO.failed) {
    technicalScore -= 18;
    warnings.push(failedBO.reason);
  }

  // Bollinger position
  if (bb && bb.pctB > 0.5 && bb.pctB <= 0.85) { technicalScore += 4; }
  if (bb && bb.pctB > 0.95) warnings.push("Price is at the top of Bollinger Bands — may be overextended.");

  // Market bias
  if (marketBias === "BULLISH") technicalScore += 6;
  if (marketBias === "BEARISH") { technicalScore -= 14; warnings.push("Overall market is bearish — be more selective."); }
  if (marketBias === "NEUTRAL") { technicalScore -= 5; warnings.push("Market is neutral — be selective, only take the highest-confidence setups."); }

  // SPY same-day direction (professional rule: don't fight the market today)
  const spyBars = barsBySymbol.SPY || [];
  if (spyBars.length >= 2) {
    const spyToday = spyBars.at(-1)?.close;
    const spyYest  = spyBars.at(-2)?.close;
    const spyDayMove = spyToday && spyYest ? ((spyToday - spyYest) / spyYest) * 100 : 0;
    if (spyDayMove >= 0.3) { technicalScore += 5; reasons.push(`S&P 500 is up ${spyDayMove.toFixed(1)}% today — market has a tailwind.`); }
    else if (spyDayMove <= -0.5) { technicalScore -= 8; warnings.push(`S&P 500 is down ${Math.abs(spyDayMove).toFixed(1)}% today — market headwind, be cautious.`); }
  }

  // Sector ETF momentum filter — one of the most powerful filters
  if (sectorCheck.bullish === true) {
    technicalScore += 10;
    reasons.push(`Sector (${sectorCheck.etf}) is trending up — wind in the sails.`);
  } else if (sectorCheck.bullish === false) {
    technicalScore -= 12;
    warnings.push(`Sector (${sectorCheck.etf}) is weak — this stock is fighting the tide.`);
  }

  // Extended check
  const stretched = (rsi14 && rsi14 > 74) || (ema20 && price > ema20 * 1.09);
  if (stretched) { technicalScore -= 14; warnings.push("Price looks extended — avoid chasing. Wait for a pullback."); }

  // Min share price filter ($10+) — penny stocks have unreliable technicals
  if (price < 10) { technicalScore -= 30; warnings.push("Price below $10 — penny stock territory. Technicals unreliable."); }

  // Min average daily volume (1M+) — professional standard for clean fills
  if (avgVol && avgVol < 1000000) {
    technicalScore -= 20;
    warnings.push(`Low avg volume (${Math.round(avgVol/1000)}k/day) — hard to exit cleanly. Top traders require 1M+ daily volume.`);
  }

  // VWAP filter — only long if price is above VWAP (most reliable intraday anchor)
  if (aboveVwap === true) {
    technicalScore += 8;
    reasons.push(`Price is above VWAP ($${vwap?.toFixed(2)}) — buyers in control.`);
  } else if (aboveVwap === false) {
    technicalScore -= 10;
    warnings.push(`Price is below VWAP ($${vwap?.toFixed(2)}) — sellers in control. Wait for price to reclaim VWAP before entering.`);
  }

  // Candle quality — weak wicks mean indecision
  if (!candle.strong && (setup === "Breakout" || setup === "Squeeze Breakout")) {
    technicalScore -= 8;
    warnings.push(`Last candle body is only ${candle.bodyPct}% of range — wick-dominated candle suggests indecision on breakout.`);
  } else if (candle.strong && candle.bullish) {
    technicalScore += 4;
    reasons.push(`Strong candle body (${candle.bodyPct}% of range) — conviction behind the move.`);
  }

  technicalScore = Math.max(1, Math.min(99, Math.round(technicalScore)));

  // ── Weekly trend alignment (higher timeframe) ──
  // Professional rule: only trade in direction of weekly trend
  if (bars.length >= 6) {
    const weekClose = bars.at(-1).close;
    const weekOpen  = bars.at(-6)?.close || weekClose; // ~1 week ago
    const weeklyBull = weekClose > weekOpen;
    const weeklyMove = ((weekClose - weekOpen) / weekOpen) * 100;
    if (weeklyBull && weeklyMove > 1) {
      technicalScore += 7;
      reasons.push(`Weekly trend is up ${weeklyMove.toFixed(1)}% — higher timeframe aligned.`);
    } else if (!weeklyBull && weeklyMove < -1) {
      technicalScore -= 8;
      warnings.push(`Weekly trend is down ${Math.abs(weeklyMove).toFixed(1)}% — higher timeframe is bearish.`);
    }
  }

  // ── Historical Edge ──
  const edge = historicalScore(historicalEdges[symbol], setup, settings);
  if (edge.warning) warnings.push(edge.warning);
  if (edge.passed) reasons.push("This setup has a proven edge in historical testing.");

  // ── Risk / Entry Levels ──
  // Tighter stops in v6: ATR-based is primary, low20 is fallback max
  const safeAtr = Number.isFinite(atr14) && atr14 > 0 ? atr14 : price * 0.025;
  const atrStop = price - safeAtr * 1.2;   // Tighter: 1.2x ATR vs old 1.45x
  const low20Stop = low20 * 0.988;          // Tighter: 98.8% vs old 98.5%
  const stop = round(Math.max(0.01, Math.max(atrStop, low20Stop)));  // Use the higher (closer) stop
  const risk = Math.max(0.01, price - stop);
  const target1 = round(price + risk * 2.0);  // Improved R:R from 1.8 to 2.0
  const target2 = round(price + risk * 3.0);  // Improved from 2.6 to 3.0
  const rrNumber = round((target1 - price) / risk, 2);

  if (rrNumber < settings.minRiskReward) warnings.push(`Risk-to-reward is ${rrNumber}:1 which is below the ${settings.minRiskReward}:1 minimum.`);

  // Pre-market gap check — if today's open gapped >2% above yesterday's close, flag it
  if (bars.length >= 2) {
    const todayOpen = last.open || price;
    const yesterdayClose = bars.at(-2)?.close || todayOpen;
    const gapPct = ((todayOpen - yesterdayClose) / yesterdayClose) * 100;
    if (gapPct > 2) {
      technicalScore -= 10;
      warnings.push(`Stock gapped up ${gapPct.toFixed(1)}% at open — chasing gaps is one of the top losing habits. Wait for a pullback.`);
    } else if (gapPct < -2) {
      warnings.push(`Stock gapped down ${Math.abs(gapPct).toFixed(1)}% at open — avoid catching a falling knife.`);
    }
  }
  if (marketBias !== "BULLISH") warnings.push("The market isn't fully bullish right now — trade smaller.");
  if (!trendBull) warnings.push("Not all trend filters are bullish yet.");

  // ── Confidence Score ──
  // v6: edge weight tweaked slightly, technical score uses ADX/MACD so more accurate
  const edgeW = settings.edgeWeight || 0.35;
  const techW = 1 - edgeW;
  const confidence = Math.max(1, Math.min(99, Math.round(technicalScore * techW + edge.score * edgeW)));

  // ── Multi-Factor Confirmation Count ──
  // Rule: need at least 3 independent categories confirming the same direction
  // This removes 70% of false signals
  let confirmedCategories = 0;
  const confirmationDetails = [];

  // Category 1: Trend (EMA alignment)
  if (price > ema20 && ema20 > ema50) {
    confirmedCategories++;
    confirmationDetails.push("Trend ✓");
  }

  // Category 2: Momentum (MACD + ADX)
  if (macdData?.bullish && adxVal && adxVal > 20) {
    confirmedCategories++;
    confirmationDetails.push("Momentum ✓");
  }

  // Category 3: Volume confirmation
  if (volumeRatio && volumeRatio >= 1.3) {
    confirmedCategories++;
    confirmationDetails.push("Volume ✓");
  }

  // Category 4: Price action (clean setup near key level)
  if (setup === "Breakout" || setup === "EMA Bounce" || setup === "Squeeze Breakout") {
    confirmedCategories++;
    confirmationDetails.push("Price Action ✓");
  }

  // Category 5: Market context (SPY/QQQ + sector)
  if (marketBias !== "BEARISH" && sectorCheck.bullish !== false) {
    confirmedCategories++;
    confirmationDetails.push("Market Context ✓");
  }

  // Category 6: VWAP
  if (aboveVwap === true) {
    confirmedCategories++;
    confirmationDetails.push("VWAP ✓");
  }

  const multiFactorOk = confirmedCategories >= 3;
  if (!multiFactorOk) {
    warnings.push(`Only ${confirmedCategories}/6 confirmation categories align (need 3+): ${confirmationDetails.join(", ") || "none"}.`);
    technicalScore -= 10;
  } else {
    reasons.push(`${confirmedCategories}/6 confirmation categories align: ${confirmationDetails.join(", ")}.`);
  }

  // ── Earnings Check ──
  // Block trades within 3 days of earnings — unpredictable gap risk
  const earningsEvent = earningsCalendar[symbol];
  let earningsWarning = null;
  let earningsBlocked = false;
  if (earningsEvent?.date) {
    const daysToEarnings = (new Date(earningsEvent.date) - new Date()) / 86400000;
    if (daysToEarnings >= 0 && daysToEarnings <= 3) {
      earningsBlocked = true;
      earningsWarning = `⚠️ Earnings in ${Math.ceil(daysToEarnings)} day${Math.ceil(daysToEarnings) === 1 ? "" : "s"} (${earningsEvent.date}) — trade blocked. Earnings can cause unpredictable 5-20% gaps.`;
      warnings.push(earningsWarning);
    } else if (daysToEarnings > 3 && daysToEarnings <= 14) {
      earningsWarning = `📅 Earnings in ${Math.ceil(daysToEarnings)} days (${earningsEvent.date}) — be aware. Consider reducing size.`;
      warnings.push(earningsWarning);
    }
  }

  // ── Safety Decision ──
  let safety = "REJECT";

  // Fix 2: ADX must be above 20 for TRADE_READY — no trading in choppy markets
  const trendStrong = !adxVal || adxVal >= 20;
  if (adxVal && adxVal < 20) warnings.push(`Trend is too weak (ADX ${round(adxVal)}) — market is choppy. Waiting for stronger trend.`);

  // TRADE_READY: full bullish market OR neutral market with very high confidence (85+)
  const marketOk = marketBias === "BULLISH" || (marketBias === "NEUTRAL" && confidence >= 85);

  // Sector must not be actively bearish for TRADE_READY
  const sectorOk = sectorCheck.bullish !== false; // null (no data) is OK, false is not

  if (
    confidence >= settings.minConfidence &&
    trendBull &&
    marketOk &&
    rrNumber >= settings.minRiskReward &&
    !stretched &&
    edge.passed &&
    trendStrong &&
    sectorOk &&
    multiFactorOk &&
    !earningsBlocked &&
    stageInfo.stage === 2 &&
    !failedBO.failed
  ) safety = "TRADE_READY";
  else if (confidence >= 62) safety = "WATCHLIST";

  // Grade is assigned in scanMarket() after RS percentiles are calculated
  // so grade is initially null here — scanMarket will set it
  const grade = null;

  // Why rejected summary — actionable, specific reasons with numbers
  const rejectedReasons = [];

  // 1. Market regime — explain exactly what needs to change
  if (marketBias !== "BULLISH") {
    // Estimate SPY/QQQ alignment score from barsBySymbol directly
    let indexScore = null;
    const spyB = barsBySymbol.SPY || [];
    const qqqB = barsBySymbol.QQQ || [];
    if (spyB.length >= 50 && qqqB.length >= 50) {
      let sc = 0;
      for (const etfB of [spyB, qqqB]) {
        const ec = etfB.map(b => b.close);
        const p = ec.at(-1);
        const e20v = ema(ec, 20), e50v = ema(ec, 50);
        const s200v = ec.length >= 200 ? sma(ec, 200) : null;
        if (e20v && p > e20v) sc++;
        if (e50v && p > e50v) sc++;
        if (s200v && p > s200v) sc++;
        if (e20v && e50v && e20v > e50v) sc++;
      }
      indexScore = sc;
    }
    const needed = [];
    if (indexScore != null && indexScore < 6) needed.push(`SPY/QQQ need more MAs aligned (${indexScore}/10 now, need 6+)`);
    needed.push("market breadth needs to reach 55%+ (more stocks in uptrends)");
    rejectedReasons.push(
      marketBias === "BEARISH"
        ? `Market is BEARISH — no longs until conditions improve. ${needed.join("; ")}.`
        : `Market is NEUTRAL — to go BULLISH: ${needed.join("; ")}.`
    );
  }

  // 2. Historical edge — show progress toward 20 trades
  if (!edge.passed) {
    const trades = Number(edge.stats?.trades || 0);
    const needed = Number(settings.minHistoricalTrades || 20);
    if (trades === 0) {
      rejectedReasons.push(`Historical edge not proven yet — run a Backtest first to collect data (need ${needed} trades).`);
    } else {
      rejectedReasons.push(`Historical edge building: ${trades}/${needed} trades collected. Run more backtests to prove the edge.`);
    }
  }

  // 3. Sector weak
  if (sectorCheck.bullish === false) rejectedReasons.push(`Sector ETF (${sectorCheck.etf}) is in a downtrend — avoid stocks in weak sectors.`);

  // 4. RS below market
  if (rs.rs3m != null && rs.rs3m < 0) rejectedReasons.push(`Relative strength is ${rs.rs3m}% below S&P 500 over 3 months — only trade market leaders.`);

  // 5. Volume — show actual ratio vs needed
  if (volumeRatio && volumeRatio < 1.0) {
    rejectedReasons.push(`Volume only ${round(volumeRatio, 2)}x average — needs 1.3x+ for confirmation. Buyers not yet active.`);
  } else if (volumeRatio && volumeRatio < 1.3) {
    rejectedReasons.push(`Volume ${round(volumeRatio, 2)}x average — marginal. Needs 1.3x+ for solid confirmation.`);
  }

  // 6. Extended — show exact distance from EMA20
  if (stretched) {
    const extPct = ema20 ? round(((price - ema20) / ema20) * 100, 1) : null;
    rejectedReasons.push(
      extPct != null
        ? `Price is ${extPct}% above EMA20 (max comfortable is ~9%) — too extended. Wait for a pullback to EMA20.`
        : "Price looks extended — wait for a pullback before entering."
    );
  }

  // 7. R/R too low
  if (rrNumber < settings.minRiskReward) rejectedReasons.push(`Risk/reward is ${rrNumber}:1 — below the ${settings.minRiskReward}:1 minimum. Stop is too close or target too near.`);

  // 8. Trend not aligned
  if (!trendBull) {
    const issues = [];
    if (price <= ema20) issues.push(`price (${round(price)}) is below EMA20 (${round(ema20)})`);
    if (ema20 && ema50 && ema20 <= ema50) issues.push(`EMA20 (${round(ema20)}) is below EMA50 (${round(ema50)})`);
    rejectedReasons.push(`Trend not aligned: ${issues.join(", ") || "EMAs not stacked bullishly"}.`);
  }

  // 9. Choppy market
  if (adxVal && adxVal < 20) rejectedReasons.push(`Trend strength weak — ADX is ${round(adxVal)} (need 20+). Market is choppy, not trending.`);

  // 10. Multi-factor
  if (!multiFactorOk) rejectedReasons.push(`Only ${confirmedCategories}/6 confirmation factors align (need 3+): ${confirmationDetails.join(", ") || "none"}.`);

  // 11. VWAP
  if (aboveVwap === false) rejectedReasons.push(`Price ($${round(price)}) is below VWAP ($${round(vwap)}) — sellers in control. Wait for price to reclaim VWAP.`);

  // 12. Weak candle
  if (!candle.strong && setup === "Breakout") rejectedReasons.push(`Breakout candle body is only ${candle.bodyPct}% of range — wick-heavy candle means indecision, not conviction.`);

  // 13. Earnings too close
  if (earningsBlocked) rejectedReasons.push(earningsWarning || "Earnings within 3 days — trade blocked.");

  // 14. Stage analysis
  if (stageInfo.stage !== 2) rejectedReasons.push(`${stageInfo.label} — only buy Stage 2 uptrends.`);

  // 15. Trend template
  if (!trendTpl.passes) rejectedReasons.push(`Minervini trend template: ${trendTpl.score}/${trendTpl.total} checks pass (need all 7).`);

  // 16. Failed breakout
  if (failedBO.failed) rejectedReasons.push(failedBO.reason);

  return {
    symbol,
    price: round(price),
    grade,
    rejectedReasons,
    changePct: round(move1, 2),
    setup,
    weeklyTrend: bars.length >= 6 ? round(((bars.at(-1).close - (bars.at(-6)?.close || bars.at(-1).close)) / (bars.at(-6)?.close || bars.at(-1).close)) * 100, 1) : null,
    spyDayMove: (() => { const sb = barsBySymbol.SPY||[]; return sb.length>=2 ? round(((sb.at(-1)?.close-sb.at(-2)?.close)/sb.at(-2)?.close)*100,2) : null; })(),
    confidence,
    technicalScore,
    historicalScore: edge.score,
    historicalGrade: edge.grade,
    historicalStats: edge.stats || null,
    rr: `${rrNumber}:1`,
    rrNumber,
    trend: trendBull ? "UP" : "NEUTRAL",
    regime: trendBull ? "Bullish" : "Neutral",
    action: safety === "TRADE_READY" ? "LONG" : safety === "WATCHLIST" ? "WATCH" : "IGNORE",
    safety,
    entry: round(price),
    buyLow: round(price * 0.993),
    buyHigh: round(price * 1.005),
    stop,
    // Trailing stop: starts at stop, trails up as price rises by 1 ATR
    trailingStop: round(price - safeAtr * 0.8),
    trailingAtr: round(safeAtr, 4),
    target1,
    target2,
    rsi: round(rsi14),
    adx: round(adxVal),
    macd: macdData,
    bb: bb ? { upper: round(bb.upper), middle: round(bb.middle), lower: round(bb.lower), pctB: bb.pctB } : null,
    relativeStrength: round(relativeStrength, 2),
    rs,
    vwap: vwap ? round(vwap) : null,
    aboveVwap,
    vwapDist,
    candleBodyPct: candle.bodyPct,
    candleStrong: candle.strong,
    confirmedCategories,
    confirmationDetails,
    earningsDate: earningsEvent?.date || null,
    earningsBlocked,
    earningsWarning,
    stageInfo,
    trendTemplate: trendTpl,
    weeklyTight,
    followThrough,
    failedBreakout: failedBO.failed,
    volumeRatio: round(volumeRatio, 2),
    sectorEtf: sectorCheck.etf,
    sectorBullish: sectorCheck.bullish,
    sectorScore: sectorCheck.score,
    baseQuality,
    baseQualityScore: baseQuality.score,
    baseQualityLabel: baseQuality.label,
    reasons,
    warnings,
    bars: bars.slice(-180)
  };
}

// ─── Grade Assignment ────────────────────────────────────────────────────────

function gradeRank(grade) {
  return grade === "A+" ? 5 : grade === "A" ? 4 : grade === "B" ? 3 : grade === "C" ? 2 : 1;
}

function assignSignalGrade(signal, marketRegime) {
  const rsPct      = signal.rs?.rsPercentile || 0;
  const rsNewHigh  = Boolean(signal.rs?.rsLineNewHigh252 || signal.rs?.rsLineNewHigh63);
  const baseScore  = signal.baseQualityScore || 0;
  const hasEdge    = Boolean(signal.historicalStats && Number(signal.historicalStats.trades || 0) >= 20);
  const pf         = Number(signal.historicalStats?.profitFactor || 0);
  const sectorGood = signal.sectorBullish !== false;
  const volumeOk   = Number(signal.volumeRatio || 0) >= 1.2;
  const marketBull = marketRegime === "BULLISH";
  const confidence = Number(signal.confidence || 0);
  const isReady    = signal.safety === "TRADE_READY";
  const isWatch    = signal.safety === "WATCHLIST";

  // A+ — best possible: market bullish, everything aligned, rare by design
  if (
    (isReady || (isWatch && marketBull)) &&
    marketBull && confidence >= 88 &&
    rsPct >= 85 && rsNewHigh &&
    baseScore >= 65 && hasEdge && pf >= 1.25 && sectorGood && volumeOk
  ) return "A+";

  // A — strong setup, most filters pass
  if (
    (isReady || isWatch) &&
    confidence >= 82 && rsPct >= 70 &&
    baseScore >= 50 && hasEdge && sectorGood
  ) return "A";

  // B — valid setup, above threshold, most indicators aligned
  if (
    (isReady || isWatch) &&
    confidence >= 76 && rsPct >= 50
  ) return "B";

  // C — watchlist quality, shows some strength
  if (
    (isReady || isWatch) &&
    confidence >= 65
  ) return "C";

  // D — below threshold, skip
  return "D";
}

// ─── Market Scan ───────────────────────────────────────────────────────────

function scanMarket(barsBySymbol, settings = {}, historicalEdges = {}, liveQuotes = {}, earningsCalendar = {}) {
  const spyBars = barsBySymbol.SPY || [];
  const spyCloses = spyBars.map(b => b.close);
  const spyMove21 = spyCloses.length > 22
    ? percentMove(spyCloses[spyCloses.length - 1], spyCloses[spyCloses.length - 22])
    : 0;
  const excluded = new Set(["DIA", "IWM", "VIX", "^VIX"]);

  // First pass with neutral bias to determine regime
  const preliminary = Object.keys(barsBySymbol)
    .filter(s => !excluded.has(s))
    .map(s => buildSignal(s, barsBySymbol[s], spyMove21, "NEUTRAL", settings, historicalEdges, barsBySymbol, earningsCalendar));

  // Try real VIX data first, fall back to SPY-calculated historical volatility
  // Yahoo Finance blocks ^VIX from server IPs, so we calculate it from SPY returns
  const rawVix = (barsBySymbol['^VIX'] || barsBySymbol['VIX'])?.at(-1)?.close;
  const vix = Number.isFinite(rawVix) ? rawVix : calcSpyVix(spyBars);
  const preRegime = marketRegimeFromSignals(preliminary, vix, barsBySymbol);

  // Second pass with known regime
  const signals = Object.keys(barsBySymbol)
    .filter(s => !excluded.has(s))
    .map(s => buildSignal(s, barsBySymbol[s], spyMove21, preRegime.regime, settings, historicalEdges, barsBySymbol, earningsCalendar))
    .sort((a, b) => b.confidence - a.confidence)
    .map((s, i) => ({ rank: i + 1, ...s }));

  // Add RS percentile across the full universe
  addRsPercentiles(signals);

  // Calculate final regime for grade assignment
  const finalRegime = marketRegimeFromSignals(signals, vix, barsBySymbol);

  // Assign grades using RS percentile + base quality + market regime
  for (const s of signals) {
    s.grade = assignSignalGrade(s, finalRegime.regime);
  }

  // Sort by grade first, then confidence
  signals.sort((a, b) => {
    const g = gradeRank(b.grade) - gradeRank(a.grade);
    if (g !== 0) return g;
    return b.confidence - a.confidence;
  });
  signals.forEach((s, i) => { s.rank = i + 1; });
  const spySignal = signals.find(s => s.symbol === "SPY");
  const qqqSignal = signals.find(s => s.symbol === "QQQ");
  const sectorLeader = findSectorLeader(signals.filter(s => s.trend === "UP"));

  const market = {
    regime: finalRegime.regime,
    spyTrend: spySignal?.trend === "UP" ? "BULLISH" : "NEUTRAL",
    qqqTrend: qqqSignal?.trend === "UP" ? "BULLISH" : "NEUTRAL",
    volatility: finalRegime.volatility,
    vix: round(vix),
    vixSource: Number.isFinite(rawVix) ? "LIVE" : "CALCULATED",
    breadth: `${finalRegime.breadth}%`,
    breadthScore: finalRegime.breadth,
    sectorLeader,
    confidence: Math.round((finalRegime.breadth + (spySignal?.confidence || 50)) / 2)
  };

  // Overlay live prices on signals for display (without affecting indicator calculations)
  if (liveQuotes && Object.keys(liveQuotes).length) {
    for (const signal of signals) {
      const lq = liveQuotes[signal.symbol];
      if (lq && lq.price) {
        signal.livePrice = lq.price;
        signal.livePct = lq.changePct;
        signal.isLive = true;
        // Update displayed price to live price (entry zone check uses this)
        signal.price = lq.price;
        if (lq.changePct != null) signal.changePct = lq.changePct;
      }
    }
  }

  return { market, signals };
}

module.exports = { scanMarket, buildSignal, marketRegimeFromSignals, sma, ema, rsi, atr, adx, macd, bollingerBands, historicalScore };
