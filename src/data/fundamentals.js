const fs = require("fs");
const path = require("path");
const FUNDAMENTALS_PATH = path.join(__dirname, "../../data/fundamentals.json");

function readFundamentalsFile() {
  try {
    if (!fs.existsSync(FUNDAMENTALS_PATH)) return {};
    return JSON.parse(fs.readFileSync(FUNDAMENTALS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function getFundamentalSnapshot(symbol, fundamentalsBySymbol = null) {
  const source = fundamentalsBySymbol || readFundamentalsFile();
  const data = source?.[String(symbol || "").toUpperCase()] || null;
  if (!data) return { active: false, score: 0, reasons: [], warnings: ["Fundamental data not connected yet."] };
  let score = 0;
  const reasons = [];
  const warnings = [];
  const epsGrowth = Number(data.epsGrowthYoY);
  const revenueGrowth = Number(data.revenueGrowthYoY);
  const epsAcceleration = Number(data.epsAcceleration);
  const salesAcceleration = Number(data.salesAcceleration);
  const roe = Number(data.returnOnEquity);
  const grossMarginTrend = String(data.grossMarginTrend || "").toUpperCase();
  const instTrend = String(data.institutionalOwnershipTrend || "").toUpperCase();
  const estimateRevisions = String(data.analystEstimateRevisionTrend || "").toUpperCase();

  if (Number.isFinite(epsGrowth) && epsGrowth >= 25) { score += 25; reasons.push(`EPS growth ${epsGrowth}% meets CAN SLIM-style strength.`); }
  else if (Number.isFinite(epsGrowth) && epsGrowth < 10) warnings.push(`EPS growth ${epsGrowth}% is weak.`);
  if (Number.isFinite(revenueGrowth) && revenueGrowth >= 20) { score += 20; reasons.push(`Revenue growth ${revenueGrowth}% is strong.`); }
  else if (Number.isFinite(revenueGrowth) && revenueGrowth < 10) warnings.push(`Revenue growth ${revenueGrowth}% is weak.`);
  if (Number.isFinite(epsAcceleration) && epsAcceleration > 0) { score += 15; reasons.push("EPS growth is accelerating."); }
  if (Number.isFinite(salesAcceleration) && salesAcceleration > 0) { score += 10; reasons.push("Sales growth is accelerating."); }
  if (Number.isFinite(roe) && roe >= 17) { score += 10; reasons.push(`ROE ${roe}% is strong.`); }
  if (grossMarginTrend === "UP") { score += 8; reasons.push("Gross margin trend is improving."); }
  else if (grossMarginTrend === "DOWN") warnings.push("Gross margin trend is weakening.");
  if (instTrend === "UP") { score += 7; reasons.push("Institutional ownership trend is improving."); }
  else if (instTrend === "DOWN") warnings.push("Institutional ownership trend is weakening.");
  if (estimateRevisions === "UP") { score += 5; reasons.push("Analyst estimate revisions are improving."); }
  else if (estimateRevisions === "DOWN") warnings.push("Analyst estimate revisions are falling.");
  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    active: true,
    score,
    label: score >= 80 ? "ELITE FUNDAMENTALS" : score >= 65 ? "STRONG FUNDAMENTALS" : score >= 45 ? "FAIR FUNDAMENTALS" : "WEAK FUNDAMENTALS",
    reasons,
    warnings,
    raw: data
  };
}

module.exports = { getFundamentalSnapshot, readFundamentalsFile };
