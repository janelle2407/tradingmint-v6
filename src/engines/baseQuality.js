function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(decimals)) : null;
}

function maxHigh(bars) {
  const values = (bars || []).map(b => num(b.high)).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function minLow(bars) {
  const values = (bars || []).map(b => num(b.low)).filter(Number.isFinite);
  return values.length ? Math.min(...values) : null;
}

function avgVolume(bars) {
  const values = (bars || []).map(b => num(b.volume || 0)).filter(Number.isFinite);
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

function detectBaseQuality(bars) {
  if (!Array.isArray(bars) || bars.length < 80) {
    return {
      score: 0,
      label: "NO BASE DATA",
      reasons: [],
      warnings: ["Not enough history to evaluate base quality."],
      baseLengthDays: null,
      baseDepthPct: null,
      contractionCount: 0,
      lastContractionDepthPct: null,
      rangeTightness10d: null,
      volumeDryUpPct: null,
      pivotPrice: null,
      distanceFromPivotPct: null,
      breakoutVolumeVs50d: null,
      failedBreakoutCount: 0
    };
  }

  const recent = bars.slice(-63);
  const last20 = bars.slice(-20);
  const last10 = bars.slice(-10);
  const prior20 = bars.slice(-40, -20);
  const lastPrice = num(bars.at(-1)?.close);
  const baseHigh = maxHigh(recent);
  const baseLow = minLow(recent);
  const baseDepthPct = baseHigh && baseLow ? ((baseHigh - baseLow) / baseHigh) * 100 : null;

  const high10 = maxHigh(last10), low10 = minLow(last10);
  const high20 = maxHigh(last20), low20 = minLow(last20);
  const high40 = maxHigh(bars.slice(-40)), low40 = minLow(bars.slice(-40));
  const range10 = high10 != null && low10 != null ? high10 - low10 : null;
  const range20 = high20 != null && low20 != null ? high20 - low20 : null;
  const range40 = high40 != null && low40 != null ? high40 - low40 : null;
  const rangeTightness10d = lastPrice && Number.isFinite(range10) ? (range10 / lastPrice) * 100 : null;
  const rangeContracting = Number.isFinite(range10) && Number.isFinite(range20) && Number.isFinite(range40) && range10 < range20 && range20 < range40;

  const vol10 = avgVolume(last10);
  const vol50 = avgVolume(bars.slice(-50));
  const volPrior20 = avgVolume(prior20);
  const currentVol = num(bars.at(-1)?.volume || 0);
  const volumeDryUpPct = volPrior20 && vol10 ? ((volPrior20 - vol10) / volPrior20) * 100 : null;
  const breakoutVolumeVs50d = vol50 && currentVol ? (currentVol / vol50) * 100 : null;

  const pivotPrice = maxHigh(last20);
  const distanceFromPivotPct = pivotPrice && lastPrice ? ((lastPrice - pivotPrice) / pivotPrice) * 100 : null;

  const blocks = [bars.slice(-63, -42), bars.slice(-42, -21), bars.slice(-21)];
  const blockRanges = blocks.map(block => {
    if (!block.length) return null;
    const h = maxHigh(block);
    const l = minLow(block);
    if (!h || !l) return null;
    const mid = (h + l) / 2;
    return mid ? ((h - l) / mid) * 100 : null;
  }).filter(Number.isFinite);

  let contractionCount = 0;
  for (let i = 1; i < blockRanges.length; i++) {
    if (blockRanges[i] < blockRanges[i - 1]) contractionCount += 1;
  }

  let failedBreakoutCount = 0;
  for (let i = Math.max(20, bars.length - 63); i < bars.length - 3; i++) {
    const priorHigh = maxHigh(bars.slice(i - 20, i));
    if (!priorHigh) continue;
    const brokeOut = Number(bars[i]?.close) > priorHigh * 1.005;
    const failed = brokeOut && Number(bars[i + 1]?.close) < priorHigh && Number(bars[i + 2]?.close) < priorHigh;
    if (failed) failedBreakoutCount += 1;
  }

  let score = 0;
  const reasons = [];
  const warnings = [];

  if (baseDepthPct != null && baseDepthPct <= 25) {
    score += 20;
    reasons.push(`Base depth ${baseDepthPct.toFixed(1)}% is controlled.`);
  } else if (baseDepthPct != null && baseDepthPct <= 35) {
    score += 10;
    warnings.push(`Base depth ${baseDepthPct.toFixed(1)}% is a bit wide.`);
  } else if (baseDepthPct != null) {
    warnings.push(`Base depth ${baseDepthPct.toFixed(1)}% is too deep for a clean growth setup.`);
  }

  if (rangeContracting) {
    score += 20;
    reasons.push("Price ranges are contracting, suggesting supply is drying up.");
  }
  if (contractionCount >= 2) {
    score += 15;
    reasons.push("Multiple volatility contractions detected.");
  } else if (contractionCount === 1) {
    score += 8;
    reasons.push("One volatility contraction detected.");
  }
  if (rangeTightness10d != null && rangeTightness10d <= 6) {
    score += 15;
    reasons.push(`Last 10-day range is tight at ${rangeTightness10d.toFixed(1)}%.`);
  } else if (rangeTightness10d != null && rangeTightness10d > 10) {
    warnings.push(`Last 10-day range is loose at ${rangeTightness10d.toFixed(1)}%.`);
  }
  if (volumeDryUpPct != null && volumeDryUpPct >= 20) {
    score += 15;
    reasons.push(`Volume dried up by ${volumeDryUpPct.toFixed(0)}%, a constructive base trait.`);
  }
  if (distanceFromPivotPct != null && distanceFromPivotPct >= -3 && distanceFromPivotPct <= 3) {
    score += 10;
    reasons.push("Price is close to pivot and not too extended.");
  } else if (distanceFromPivotPct != null && distanceFromPivotPct > 5) {
    warnings.push("Price is extended above pivot. Avoid chasing.");
  }
  if (failedBreakoutCount === 0) score += 5;
  else {
    score -= Math.min(20, failedBreakoutCount * 8);
    warnings.push(`${failedBreakoutCount} failed breakout attempt(s) detected.`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    label: score >= 80 ? "ELITE BASE" : score >= 65 ? "STRONG BASE" : score >= 45 ? "FAIR BASE" : "WEAK BASE",
    reasons,
    warnings,
    baseLengthDays: recent.length,
    baseDepthPct: round(baseDepthPct, 1),
    contractionCount,
    lastContractionDepthPct: round(blockRanges.at(-1), 1),
    rangeTightness10d: round(rangeTightness10d, 1),
    volumeDryUpPct: round(volumeDryUpPct, 1),
    pivotPrice: round(pivotPrice, 2),
    distanceFromPivotPct: round(distanceFromPivotPct, 1),
    breakoutVolumeVs50d: round(breakoutVolumeVs50d, 0),
    failedBreakoutCount
  };
}

function setupVolumeScore(setup, bars, volumeRatio, baseQuality = null) {
  const reasons = [];
  const warnings = [];
  let score = 0;
  const vr = Number(volumeRatio);
  if (!Array.isArray(bars) || bars.length < 50 || !Number.isFinite(vr)) {
    return { score: 0, reasons, warnings: ["Volume data insufficient."] };
  }
  const last = bars.at(-1);
  const prev = bars.at(-2);
  const lastGreen = Number(last.close) >= Number(last.open);
  const lastRed = Number(last.close) < Number(last.open);
  const vol10 = avgVolume(bars.slice(-10));
  const priorVol20 = avgVolume(bars.slice(-40, -20));
  const dryUp = priorVol20 && vol10 ? ((priorVol20 - vol10) / priorVol20) * 100 : 0;

  if (setup === "Breakout") {
    if (vr >= 1.8) { score += 14; reasons.push(`Breakout volume is very strong at ${vr.toFixed(1)}x average.`); }
    else if (vr >= 1.4) { score += 10; reasons.push(`Breakout volume confirms the move at ${vr.toFixed(1)}x average.`); }
    else { score -= 8; warnings.push("Breakout volume is weak. Strong breakouts usually need clear volume expansion."); }
  } else if (setup === "EMA Bounce") {
    if (lastGreen && prev && Number(last.volume) > Number(prev.volume || 0)) { score += 8; reasons.push("Bounce volume is improving from the prior day."); }
    if (vr < 0.8) warnings.push("Bounce volume is still light.");
  } else if (setup === "Squeeze Breakout") {
    if (dryUp >= 15 && vr >= 1.3) { score += 12; reasons.push("Squeeze shows volume dry-up followed by expansion."); }
    else if (dryUp >= 15) { score += 5; reasons.push("Volume dried up during the squeeze."); }
    else warnings.push("Squeeze lacks clear volume dry-up.");
  } else if (setup === "Pullback") {
    if (lastRed && vr >= 1.3) { score -= 10; warnings.push("Pullback is happening on heavy red volume, suggesting distribution."); }
    else if (vr <= 0.9) { score += 6; reasons.push("Pullback volume is quiet, which is constructive."); }
  } else if (setup === "Momentum") {
    if (vr >= 1.2) { score += 7; reasons.push("Momentum move has supportive volume."); }
  }

  if (baseQuality?.volumeDryUpPct >= 20 && vr >= 1.2) {
    score += 5;
    reasons.push("Volume pattern shows dry-up followed by renewed demand.");
  }
  return { score, reasons, warnings };
}

module.exports = { detectBaseQuality, setupVolumeScore, maxHigh, minLow, avgVolume };
