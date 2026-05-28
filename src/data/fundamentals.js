// ─── Fundamentals and Catalyst Interfaces ────────────────────────────────────
// These interfaces are ready for future data connections.
// Until real data is connected, they clearly report inactive status.
// DO NOT pretend data is active if it isn't.

function getFundamentalSnapshot(symbol, fundamentalsBySymbol = {}) {
  const data = fundamentalsBySymbol?.[symbol] || null;

  if (!data) {
    return {
      active: false, score: 0, reasons: [],
      warnings: ["ℹ️ Fundamental data not connected yet. EPS, revenue, and institutional data unavailable."]
    };
  }

  let score = 0;
  const reasons = [], warnings = [];

  const epsGrowth       = Number(data.epsGrowthYoY);
  const revenueGrowth   = Number(data.revenueGrowthYoY);
  const epsAcceleration = Number(data.epsAcceleration);
  const salesAccel      = Number(data.salesAcceleration);
  const roe             = Number(data.returnOnEquity);
  const instTrend       = String(data.institutionalOwnershipTrend || "").toUpperCase();

  if (Number.isFinite(epsGrowth) && epsGrowth >= 25) {
    score += 25; reasons.push(`EPS growth ${epsGrowth}% is strong.`);
  } else if (Number.isFinite(epsGrowth) && epsGrowth < 10) {
    warnings.push(`EPS growth ${epsGrowth}% is weak.`);
  }

  if (Number.isFinite(revenueGrowth) && revenueGrowth >= 20) {
    score += 20; reasons.push(`Revenue growth ${revenueGrowth}% is strong.`);
  } else if (Number.isFinite(revenueGrowth) && revenueGrowth < 10) {
    warnings.push(`Revenue growth ${revenueGrowth}% is weak.`);
  }

  if (Number.isFinite(epsAcceleration) && epsAcceleration > 0) {
    score += 15; reasons.push("EPS growth is accelerating.");
  }
  if (Number.isFinite(salesAccel) && salesAccel > 0) {
    score += 10; reasons.push("Sales growth is accelerating.");
  }
  if (Number.isFinite(roe) && roe >= 17) {
    score += 15; reasons.push(`ROE ${roe}% is strong.`);
  }
  if (instTrend === "UP") {
    score += 15; reasons.push("Institutional ownership trend is improving.");
  } else if (instTrend === "DOWN") {
    warnings.push("Institutional ownership trend is weakening.");
  }

  return {
    active: true, score: Math.max(0, Math.min(100, Math.round(score))),
    reasons, warnings, raw: data
  };
}

function getCatalystSnapshot(symbol, catalystsBySymbol = {}) {
  const data = catalystsBySymbol?.[symbol] || null;

  if (!data) {
    return {
      active: false, score: 0, blocked: false, reasons: [],
      warnings: ["ℹ️ Earnings/news catalyst data not connected yet."]
    };
  }

  let score = 0, blocked = false;
  const reasons = [], warnings = [];

  const daysToEarnings = Number(data.daysToEarnings);
  const surprise       = Number(data.lastEarningsSurprisePct);
  const guidance       = String(data.guidance    || "").toUpperCase();
  const risk           = String(data.newsRisk    || "").toUpperCase();

  if (Number.isFinite(daysToEarnings) && daysToEarnings >= 0 && daysToEarnings <= 5) {
    blocked = true;
    warnings.push(`Earnings in ${daysToEarnings} days — new entries blocked.`);
  }
  if (Number.isFinite(surprise) && surprise >= 10) {
    score += 25; reasons.push(`Recent earnings surprise: +${surprise}%.`);
  }
  if (guidance === "RAISED") {
    score += 25; reasons.push("Company raised guidance.");
  }
  if (risk === "HIGH") {
    blocked = true; warnings.push("High-risk news detected.");
  } else if (risk === "MEDIUM") {
    warnings.push("Medium news risk detected.");
  }

  return {
    active: true,
    score: Math.max(0, Math.min(100, Math.round(score))),
    blocked, reasons, warnings, raw: data
  };
}

module.exports = { getFundamentalSnapshot, getCatalystSnapshot };
