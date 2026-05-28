const { sectorOf } = require("../data/sectorMap");
const { exposureSummary } = require("./correlation");

function groupBy(items, fn) {
  return (items || []).reduce((out, item) => {
    const key = fn(item);
    out[key] ||= [];
    out[key].push(item);
    return out;
  }, {});
}

function summarizeClosed(closed = []) {
  const wins = closed.filter(t => Number(t.pnl || 0) > 0);
  const losses = closed.filter(t => Number(t.pnl || 0) <= 0);
  const totalPnl = closed.reduce((sum, t) => sum + Number(t.pnl || 0), 0);
  const grossWins = wins.reduce((sum, t) => sum + Number(t.pnl || 0), 0);
  const grossLosses = Math.abs(losses.reduce((sum, t) => sum + Number(t.pnl || 0), 0));
  const avgPnl = closed.length ? totalPnl / closed.length : null;
  const best = [...closed].sort((a, b) => Number(b.pnl || 0) - Number(a.pnl || 0))[0] || null;
  const worst = [...closed].sort((a, b) => Number(a.pnl || 0) - Number(b.pnl || 0))[0] || null;
  return { trades: closed.length, wins: wins.length, losses: losses.length, winRate: closed.length ? Number(((wins.length / closed.length) * 100).toFixed(1)) : null, totalPnl: Number(totalPnl.toFixed(2)), avgPnl: avgPnl === null ? null : Number(avgPnl.toFixed(2)), profitFactor: grossLosses ? Number((grossWins / grossLosses).toFixed(2)) : null, best, worst };
}

function breakdown(closed, keyFn) {
  const grouped = groupBy(closed, keyFn);
  return Object.fromEntries(Object.entries(grouped).map(([key, rows]) => [key, summarizeClosed(rows)]));
}

function setupBreakdown(closed = []) { return breakdown(closed, t => t.setup || t.setupType || "Unknown"); }
function symbolBreakdown(closed = []) { return breakdown(closed, t => t.symbol || "Unknown"); }
function sectorBreakdown(closed = []) { return breakdown(closed, t => sectorOf(t.symbol)); }
function gradeBreakdown(closed = []) { return breakdown(closed, t => t.grade || "Unknown"); }
function regimeBreakdown(closed = []) { return breakdown(closed, t => t.marketRegime || t.regime || "Unknown"); }
function sourceBreakdown(closed = []) { return breakdown(closed, t => t.source || "Unknown"); }
function baseQualityBucket(score) { const n = Number(score); if (!Number.isFinite(n)) return "Unknown"; if (n >= 80) return "Base 80-100"; if (n >= 65) return "Base 65-79"; if (n >= 45) return "Base 45-64"; return "Base <45"; }
function baseQualityBreakdown(closed = []) { return breakdown(closed, t => baseQualityBucket(t.baseQualityScore)); }
function rsBucket(rsPercentile) { const n = Number(rsPercentile); if (!Number.isFinite(n)) return "Unknown"; if (n >= 90) return "RS 90-100"; if (n >= 80) return "RS 80-89"; if (n >= 60) return "RS 60-79"; if (n >= 40) return "RS 40-59"; return "RS <40"; }
function rsBreakdown(closed = []) { return breakdown(closed, t => rsBucket(t.rsPercentile || t.rs?.rsPercentile)); }
function volumeBucket(volumeRatio) { const n = Number(volumeRatio); if (!Number.isFinite(n)) return "Unknown"; if (n >= 2) return "Volume >=2.0x"; if (n >= 1.5) return "Volume 1.5-1.99x"; if (n >= 1.2) return "Volume 1.2-1.49x"; if (n >= 1) return "Volume 1.0-1.19x"; return "Volume <1.0x"; }
function volumeBreakdown(closed = []) { return breakdown(closed, t => volumeBucket(t.volumeRatio)); }

function buildRecommendations(summary, closed, open) {
  const recs = [];
  if (summary.trades < 30) recs.push("Sample is still small. Keep paper testing before trusting results.");
  if (summary.winRate !== null && summary.winRate < 45) recs.push("Win rate is weak. Tighten entries or improve exits.");
  if (summary.avgPnl !== null && summary.avgPnl <= 0) recs.push("Average trade is not profitable. Review filters and edge thresholds.");
  if (summary.profitFactor !== null && summary.profitFactor < 1.25) recs.push("Profit factor is below 1.25. Strategy edge is not strong enough yet.");
  if (open.length > 4) recs.push("Many positions open at once. Watch exposure and correlation risk.");
  if (!recs.length) recs.push("No major report warnings. Continue paper testing and monitor drawdown.");
  return recs;
}

function generateReport(db) {
  const closed = db.paper.closed || [];
  const open = db.paper.open || [];
  const summary = summarizeClosed(closed);
  return {
    createdAt: new Date().toISOString(),
    milestone: closed.length >= 200 ? "200+ trades" : closed.length >= 100 ? "100+ trades" : closed.length >= 50 ? "50+ trades" : closed.length >= 30 ? "30+ trades" : "early sample",
    summary,
    setupBreakdown: setupBreakdown(closed),
    symbolBreakdown: symbolBreakdown(closed),
    sectorBreakdown: sectorBreakdown(closed),
    gradeBreakdown: gradeBreakdown(closed),
    regimeBreakdown: regimeBreakdown(closed),
    rsBreakdown: rsBreakdown(closed),
    volumeBreakdown: volumeBreakdown(closed),
    baseQualityBreakdown: baseQualityBreakdown(closed),
    sourceBreakdown: sourceBreakdown(closed),
    openExposure: exposureSummary(db.paper),
    recommendations: buildRecommendations(summary, closed, open)
  };
}

module.exports = { generateReport, summarizeClosed, setupBreakdown, symbolBreakdown, sectorBreakdown, gradeBreakdown, regimeBreakdown, rsBreakdown, volumeBreakdown, baseQualityBreakdown, sourceBreakdown };
