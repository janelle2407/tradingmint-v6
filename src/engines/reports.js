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
  const wins = closed.filter(t => Number(t.pnl || 0) > 0);
  const losses = closed.filter(t => Number(t.pnl || 0) <= 0);
  const totalPnl = closed.reduce((sum, t) => sum + Number(t.pnl || 0), 0);
  const avgPnl = closed.length ? totalPnl / closed.length : null;
  const best = [...closed].sort((a, b) => Number(b.pnl || 0) - Number(a.pnl || 0))[0] || null;
  const worst = [...closed].sort((a, b) => Number(a.pnl || 0) - Number(b.pnl || 0))[0] || null;

  return {
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? Number((wins.length / closed.length * 100).toFixed(1)) : null,
    totalPnl: Number(totalPnl.toFixed(2)),
    avgPnl: avgPnl === null ? null : Number(avgPnl.toFixed(2)),
    best,
    worst
  };
}

function setupBreakdown(closed = []) {
  const grouped = groupBy(closed, t => t.setup || "Unknown");
  return Object.fromEntries(Object.entries(grouped).map(([setup, rows]) => [setup, summarizeClosed(rows)]));
}

function symbolBreakdown(closed = []) {
  const grouped = groupBy(closed, t => t.symbol || "Unknown");
  return Object.fromEntries(Object.entries(grouped).map(([symbol, rows]) => [symbol, summarizeClosed(rows)]));
}

function sectorBreakdown(closed = []) {
  const grouped = groupBy(closed, t => sectorOf(t.symbol));
  return Object.fromEntries(Object.entries(grouped).map(([sector, rows]) => [sector, summarizeClosed(rows)]));
}

function generateReport(db) {
  const closed = db.paper.closed || [];
  const open = db.paper.open || [];
  const summary = summarizeClosed(closed);
  return {
    createdAt: new Date().toISOString(),
    milestone: closed.length >= 200 ? "200+ trades" : closed.length >= 100 ? "100+ trades" : closed.length >= 50 ? "50+ trades" : closed.length >= 25 ? "25+ trades" : "early sample",
    summary,
    setupBreakdown: setupBreakdown(closed),
    symbolBreakdown: symbolBreakdown(closed),
    sectorBreakdown: sectorBreakdown(closed),
    openExposure: exposureSummary(db.paper),
    recommendations: buildRecommendations(summary, closed, open)
  };
}

function buildRecommendations(summary, closed, open) {
  const recs = [];
  if (summary.trades < 25) recs.push("Sample is still small. Keep paper testing before trusting results.");
  if (summary.winRate !== null && summary.winRate < 45) recs.push("Win rate is weak. Tighten entries or improve exits.");
  if (summary.avgPnl !== null && summary.avgPnl <= 0) recs.push("Average trade is not profitable. Review setup filters and historical edge thresholds.");
  if (open.length > 4) recs.push("Many positions open at once. Watch exposure and correlation risk.");
  if (!recs.length) recs.push("No major report warnings. Continue paper testing and monitor drawdown.");
  return recs;
}

module.exports = { generateReport, summarizeClosed, setupBreakdown, symbolBreakdown, sectorBreakdown };
