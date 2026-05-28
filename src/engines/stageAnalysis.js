function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(-period).filter(Number.isFinite);
  if (slice.length < period) return null;
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

function toWeeklyBars(dailyBars) {
  if (!Array.isArray(dailyBars) || dailyBars.length < 10) return [];
  const weeks = [];
  for (let i = 0; i < dailyBars.length; i += 5) {
    const chunk = dailyBars.slice(i, i + 5);
    if (!chunk.length) continue;
    const highs = chunk.map(b => Number(b.high)).filter(Number.isFinite);
    const lows = chunk.map(b => Number(b.low)).filter(Number.isFinite);
    const close = Number(chunk.at(-1)?.close);
    if (!Number.isFinite(close) || !highs.length || !lows.length) continue;
    weeks.push({
      date: chunk.at(-1)?.date,
      open: chunk[0]?.open,
      high: Math.max(...highs),
      low: Math.min(...lows),
      close,
      volume: chunk.reduce((sum, b) => sum + Number(b.volume || 0), 0)
    });
  }
  return weeks;
}

function percentMove(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return 0;
  return ((current - previous) / previous) * 100;
}

function analyzeStage(dailyBars, spyBars = []) {
  const weekly = toWeeklyBars(dailyBars);
  const spyWeekly = toWeeklyBars(spyBars);
  if (weekly.length < 35) {
    return { stage: "UNKNOWN", score: 50, passed: false, reasons: [], warnings: ["Not enough weekly data for Weinstein stage analysis."] };
  }
  const closes = weekly.map(w => w.close);
  const price = closes.at(-1);
  const ma30 = sma(closes, 30);
  const ma30Prev = sma(closes.slice(0, -4), 30);
  const maRising = ma30 && ma30Prev && ma30 > ma30Prev;
  const above30 = ma30 && price > ma30;
  let rsWeekly = null;
  if (spyWeekly.length >= weekly.length) {
    const spyCloses = spyWeekly.slice(-weekly.length).map(w => w.close);
    const stockMove13 = closes.length > 13 ? percentMove(closes.at(-1), closes.at(-14)) : 0;
    const spyMove13 = spyCloses.length > 13 ? percentMove(spyCloses.at(-1), spyCloses.at(-14)) : 0;
    rsWeekly = stockMove13 - spyMove13;
  }
  let score = 0;
  const reasons = [];
  const warnings = [];
  if (above30) { score += 35; reasons.push("Price is above the 30-week moving average."); }
  else warnings.push("Price is below the 30-week moving average.");
  if (maRising) { score += 35; reasons.push("30-week moving average is rising."); }
  else warnings.push("30-week moving average is not rising yet.");
  if (rsWeekly != null && rsWeekly > 5) { score += 20; reasons.push(`Weekly relative strength is outperforming SPY by ${rsWeekly.toFixed(1)}%.`); }
  else if (rsWeekly != null && rsWeekly < 0) { score -= 15; warnings.push(`Weekly relative strength is lagging SPY by ${Math.abs(rsWeekly).toFixed(1)}%.`); }
  const recentVolume = weekly.slice(-4).reduce((s, w) => s + Number(w.volume || 0), 0) / 4;
  const priorVolume = weekly.slice(-12, -4).reduce((s, w) => s + Number(w.volume || 0), 0) / 8;
  if (priorVolume && recentVolume > priorVolume * 1.2 && price > ma30) {
    score += 10;
    reasons.push("Recent weekly volume is expanding while price is above the 30-week average.");
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  let stage = "STAGE 1 / BASE";
  if (above30 && maRising && score >= 70) stage = "STAGE 2 UPTREND";
  else if (!above30 && !maRising) stage = "STAGE 4 DOWNTREND";
  else if (above30 && !maRising) stage = "STAGE 3 / LATE";
  else if (!above30 && maRising) stage = "STAGE 1 / RECOVERY";
  return {
    stage,
    score,
    passed: stage === "STAGE 2 UPTREND",
    weeklyRsVsSpy: rsWeekly == null ? null : Number(rsWeekly.toFixed(1)),
    priceAbove30Week: Boolean(above30),
    ma30WeekRising: Boolean(maRising),
    reasons,
    warnings
  };
}

module.exports = { analyzeStage, toWeeklyBars };
