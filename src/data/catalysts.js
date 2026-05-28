const fs = require("fs");
const path = require("path");
const CATALYSTS_PATH = path.join(__dirname, "../../data/catalysts.json");

function readCatalystsFile() {
  try {
    if (!fs.existsSync(CATALYSTS_PATH)) return {};
    return JSON.parse(fs.readFileSync(CATALYSTS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function daysBetweenToday(dateString) {
  if (!dateString) return null;
  const today = new Date();
  const eventDate = new Date(dateString);
  if (Number.isNaN(eventDate.getTime())) return null;
  return Math.ceil((eventDate - today) / 86400000);
}

function getCatalystSnapshot(symbol, catalystsBySymbol = null, settings = {}) {
  const source = catalystsBySymbol || readCatalystsFile();
  const clean = String(symbol || "").toUpperCase();
  const data = source?.[clean] || null;
  if (!data) return { active: false, blocked: false, score: 0, reasons: [], warnings: ["Earnings/news/catalyst data not connected yet."] };
  let score = 0;
  let blocked = false;
  const reasons = [];
  const warnings = [];
  const blockDays = Number(settings.earningsBlockDays || 3);
  const daysToEarnings = Number.isFinite(Number(data.daysToEarnings)) ? Number(data.daysToEarnings) : daysBetweenToday(data.earningsDate);
  if (Number.isFinite(daysToEarnings)) {
    if (daysToEarnings >= 0 && daysToEarnings <= blockDays) { blocked = true; warnings.push(`Earnings in ${daysToEarnings} day(s), inside the ${blockDays}-day block window.`); }
    else reasons.push(`Earnings risk checked: ${daysToEarnings} day(s) away.`);
  }
  const surprise = Number(data.lastEarningsSurprisePct);
  if (Number.isFinite(surprise) && surprise >= 10) { score += 20; reasons.push(`Recent earnings surprise was strong at ${surprise}%.`); }
  else if (Number.isFinite(surprise) && surprise < -5) warnings.push(`Recent earnings surprise was negative at ${surprise}%.`);
  const guidance = String(data.guidance || "").toUpperCase();
  if (guidance === "RAISED") { score += 25; reasons.push("Company raised guidance."); }
  else if (guidance === "LOWERED") { score -= 25; warnings.push("Company lowered guidance."); }
  const analyst = String(data.analystAction || "").toUpperCase();
  if (analyst === "UPGRADE") { score += 10; reasons.push("Recent analyst upgrade detected."); }
  else if (analyst === "DOWNGRADE") { score -= 10; warnings.push("Recent analyst downgrade detected."); }
  const newsRisk = String(data.newsRisk || "").toUpperCase();
  if (newsRisk === "HIGH") { blocked = true; warnings.push("High-risk news detected."); }
  else if (newsRisk === "MEDIUM") warnings.push("Medium news risk detected.");
  else if (newsRisk === "LOW") { score += 5; reasons.push("News risk marked low."); }
  if (data.offeringRisk === true) { blocked = true; warnings.push("Offering/dilution risk detected."); }
  if (data.legalRisk === true || data.secRisk === true) { blocked = true; warnings.push("Legal/SEC risk detected."); }
  if (data.positiveCatalyst) { score += 10; reasons.push(`Positive catalyst: ${data.positiveCatalyst}`); }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    active: true,
    blocked,
    score,
    label: blocked ? "BLOCKED CATALYST RISK" : score >= 60 ? "POSITIVE CATALYST" : score >= 30 ? "MIXED CATALYST" : "NO STRONG CATALYST",
    daysToEarnings: Number.isFinite(daysToEarnings) ? daysToEarnings : null,
    reasons,
    warnings,
    raw: data
  };
}

function getEarningsCalendarFromCatalysts(catalystsBySymbol = null) {
  const source = catalystsBySymbol || readCatalystsFile();
  const out = {};
  for (const [symbol, data] of Object.entries(source || {})) {
    if (data.earningsDate) out[symbol.toUpperCase()] = { date: data.earningsDate, when: data.earningsWhen || data.reportTime || null };
  }
  return out;
}

module.exports = { getCatalystSnapshot, getEarningsCalendarFromCatalysts, readCatalystsFile };
