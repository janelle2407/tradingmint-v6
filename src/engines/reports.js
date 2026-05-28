// ─── Reports Engine v2 ───────────────────────────────────────────────────────
// v2: Grade breakdown, market regime breakdown, RS bucket breakdown

const { sectorOf } = require("../data/sectorMap");
const { exposureSummary } = require("./correlation");

function groupBy(items, fn) {
  return items.reduce((out, item) => {
    const key = fn(item);
    out[key] ||= [];
    out[key].push(item);
    return out;
  }, {});
}

function summarizeClosed(closed = []) {
  const wins   = closed.filter(t => Number(t.pnl || 0) > 0);
  const losses = closed.filter(t => Number(t.pnl || 0) <= 0);
  const totalPnl = closed.reduce((sum, t) => sum + Number(t.pnl || 0), 0);
  const avgPnl   = closed.length ? totalPnl / closed.length : null;
  const best  = [...closed].sort((a, b) => Number(b.pnl || 0) - Number(a.pnl || 0))[0] || null;
  const worst = [...closed].sort((a, b) => Number(a.pnl || 0) - Number(b.pnl || 0))[0] || null;
  return {
    trades: closed.length, wins: wins.length, losses: losses.length,
    winRate: closed.length ? Number((wins.length / closed.length * 100).toFixed(1)) : null,
    totalPnl: Number(totalPnl.toFixed(2)),
    avgPnl: avgPnl === null ? null : Number(avgPnl.toFixed(2)),
    best, worst
  };
}

function setupBreakdown(closed = []) {
  const grouped = groupBy(closed, t => t.setup || "Unknown");
  return Object.fromEntries(Object.entries(grouped).map(([k, rows]) => [k, summarizeClosed(rows)]));
}

function symbolBreakdown(closed = []) {
  const grouped = groupBy(closed, t => t.symbol || "Unknown");
  return Object.fromEntries(Object.entries(grouped).map(([k, rows]) => [k, summarizeClosed(rows)]));
}

function sectorBreakdown(closed = []) {
  const grouped = groupBy(closed, t => sectorOf(t.symbol));
  return Object.fromEntries(Object.entries(grouped).map(([k, rows]) => [k, summarizeClosed(rows)]));
}

function gradeBreakdown(closed = []) {
  const grouped = groupBy(closed, t => t.grade || "Unknown");
  return Object.fromEntries(
    Object.entries(grouped)
      .sort(([a], [b]) => {
        const order = { "A+": 0, "A": 1, "B": 2, "C": 3, "D": 4, "Unknown": 5 };
        return (order[a] ?? 5) - (order[b] ?? 5);
      })
      .map(([k, rows]) => [k, summarizeClosed(rows)])
  );
}

function regimeBreakdown(closed = []) {
  const grouped = groupBy(closed, t => t.marketRegime || "Unknown");
  return Object.fromEntries(Object.entries(grouped).map(([k, rows]) => [k, summarizeClosed(rows)]));
}

function rsBucket(rsPercentile) {
  const n = Number(rsPercentile);
  if (!Number.isFinite(n)) return "Unknown";
  if (n >= 90) return "RS 90-100";
  if (n >= 80) return "RS 80-89";
  if (n >= 60) return "RS 60-79";
  if (n >= 40) return "RS 40-59";
  return "RS < 40";
}

function rsBreakdown(closed = []) {
  const grouped = groupBy(closed, t => rsBucket(t.rsPercentile));
  return Object.fromEntries(Object.entries(grouped).map(([k, rows]) => [k, summarizeClosed(rows)]));
}

function generateReport(db) {
  const closed = db.paper.closed || [];
  const open   = db.paper.open   || [];
  const summary = summarizeClosed(closed);
  return {
    createdAt: new Date().toISOString(),
    milestone: closed.length >= 200 ? "200+ trades" : closed.length >= 100 ? "100+ trades" : closed.length >= 50 ? "50+ trades" : closed.length >= 25 ? "25+ trades" : "early sample",
    summary,
    setupBreakdown:  setupBreakdown(closed),
    symbolBreakdown: symbolBreakdown(closed),
    sectorBreakdown: sectorBreakdown(closed),
    gradeBreakdown:  gradeBreakdown(closed),
    regimeBreakdown: regimeBreakdown(closed),
    rsBreakdown:     rsBreakdown(closed),
    openExposure: exposureSummary(db.paper),
    recommendations: buildRecommendations(summary, closed, open)
  };
}

function buildRecommendations(summary, closed, open) {
  const recs = [];
  if (summary.trades < 25) recs.push("Sample is still small. Keep paper testing before trusting results.");
  if (summary.winRate !== null && summary.winRate < 45) recs.push("Win rate is weak. Tighten entries or improve exits.");
  if (summary.avgPnl !== null && summary.avgPnl <= 0) recs.push("Average trade not profitable. Review setup filters and historical edge thresholds.");
  if (open.length > 4) recs.push("Many positions open. Watch exposure and correlation risk.");
  if (!recs.length) recs.push("No major warnings. Continue paper testing and monitor drawdown.");
  return recs;
}

module.exports = {
  generateReport, summarizeClosed,
  setupBreakdown, symbolBreakdown, sectorBreakdown,
  gradeBreakdown, regimeBreakdown, rsBreakdown
};
