const { round, percentMove } = require("../data/marketData");
const { sectorEtfOf } = require("../data/sectorMap");

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

// ─── Main Signal Builder ───────────────────────────────────────────────────

function buildSignal(symbol, bars, spyMove21, marketBias, settings = {}, historicalEdges = {}, barsBySymbol = {}) {
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

  // ── Relative Strength vs SPY ──
  const spyClosesForRs = (barsBySymbol.SPY || []).map(b => b.close);
  const rs = calcRelativeStrength(closes, spyClosesForRs);

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

  // Volume — raised to 1.3x in v6
  if (volumeRatio && volumeRatio >= 1.3) { technicalScore += 8; reasons.push(`Volume is ${round(volumeRatio, 1)}x above average — strong buyer interest.`); }
  else if (volumeRatio && volumeRatio >= 1.1) { technicalScore += 3; }
  else if (volumeRatio) warnings.push("Volume is not confirming the move yet.");

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

  // Min average daily volume (500k+) — need liquidity to exit cleanly
  if (avgVol && avgVol < 500000) { technicalScore -= 20; warnings.push(`Low avg volume (${Math.round(avgVol/1000)}k/day) — hard to exit cleanly. Top traders require 500k+ daily volume.`); }

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
    sectorOk
  ) safety = "TRADE_READY";
  else if (confidence >= 62) safety = "WATCHLIST";

  // ── Signal Grade (A+ to D) ──
  // Professional quality label based on all filters combined
  let grade = "D";
  const rsScore = rs.rs3m != null ? rs.rs3m : 0;
  const hasEdge = edge.passed;
  const sectorGood = sectorCheck.bullish !== false;
  const weeklyGood = bars.length >= 6 && (bars.at(-1).close > (bars.at(-6)?.close || 0));

  if (safety === "TRADE_READY" && confidence >= 88 && rsScore > 10 && hasEdge && rs.rsLineNewHigh63 && sectorGood) {
    grade = "A+"; // Best possible: everything aligned
  } else if (safety === "TRADE_READY" && confidence >= 82 && rsScore > 3 && hasEdge && sectorGood) {
    grade = "A";  // Strong valid setup
  } else if (safety === "TRADE_READY" && confidence >= 76) {
    grade = "B";  // Valid but missing one ingredient
  } else if (safety === "WATCHLIST" && confidence >= 68) {
    grade = "C";  // Watch only
  } else {
    grade = "D";  // Reject
  }

  // Why rejected summary — helps user understand what's missing
  const rejectedReasons = [];
  if (marketBias !== "BULLISH") rejectedReasons.push("Market regime not fully bullish");
  if (!edge.passed) rejectedReasons.push("Historical edge not proven (need 20+ trades)");
  if (sectorCheck.bullish === false) rejectedReasons.push(`Sector (${sectorCheck.etf}) is weak`);
  if (rs.rs3m != null && rs.rs3m < 0) rejectedReasons.push("Relative strength below S&P 500");
  if (volumeRatio && volumeRatio < 1.0) rejectedReasons.push("Volume not confirming");
  if (stretched) rejectedReasons.push("Price looks extended");
  if (rrNumber < settings.minRiskReward) rejectedReasons.push(`R/R ${rrNumber} below minimum ${settings.minRiskReward}`);
  if (!trendBull) rejectedReasons.push("Not all trend filters bullish");
  if (adxVal && adxVal < 20) rejectedReasons.push("Trend too weak (ADX < 20)");

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
    volumeRatio: round(volumeRatio, 2),
    sectorEtf: sectorCheck.etf,
    sectorBullish: sectorCheck.bullish,
    sectorScore: sectorCheck.score,
    reasons,
    warnings,
    bars: bars.slice(-180)
  };
}

// ─── Market Scan ───────────────────────────────────────────────────────────

function scanMarket(barsBySymbol, settings = {}, historicalEdges = {}, liveQuotes = {}) {
  const spyBars = barsBySymbol.SPY || [];
  const spyCloses = spyBars.map(b => b.close);
  const spyMove21 = spyCloses.length > 22
    ? percentMove(spyCloses[spyCloses.length - 1], spyCloses[spyCloses.length - 22])
    : 0;
  const excluded = new Set(["DIA", "IWM", "VIX", "^VIX"]);

  // First pass with neutral bias to determine regime
  const preliminary = Object.keys(barsBySymbol)
    .filter(s => !excluded.has(s))
    .map(s => buildSignal(s, barsBySymbol[s], spyMove21, "NEUTRAL", settings, historicalEdges, barsBySymbol));

  // Try real VIX data first, fall back to SPY-calculated historical volatility
  // Yahoo Finance blocks ^VIX from server IPs, so we calculate it from SPY returns
  const rawVix = (barsBySymbol['^VIX'] || barsBySymbol['VIX'])?.at(-1)?.close;
  const vix = Number.isFinite(rawVix) ? rawVix : calcSpyVix(spyBars);
  const preRegime = marketRegimeFromSignals(preliminary, vix, barsBySymbol);

  // Second pass with known regime
  const signals = Object.keys(barsBySymbol)
    .filter(s => !excluded.has(s))
    .map(s => buildSignal(s, barsBySymbol[s], spyMove21, preRegime.regime, settings, historicalEdges, barsBySymbol))
    .sort((a, b) => b.confidence - a.confidence)
    .map((s, i) => ({ rank: i + 1, ...s }));

  // Add RS percentile across the full universe
  addRsPercentiles(signals);

  const finalRegime = marketRegimeFromSignals(signals, vix, barsBySymbol);
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
