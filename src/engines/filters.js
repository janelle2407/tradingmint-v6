const { getCatalystSnapshot, getEarningsCalendarFromCatalysts } = require("../data/catalysts");

function earningsFilter(signal, settings, earningsCalendar = {}) {
  const event = earningsCalendar[signal.symbol];
  if (!event) {
    const blocked = Boolean(settings.blockUnknownEarnings);
    return {
      blocked,
      active: false,
      reason: blocked ? `${signal.symbol}: earnings date unknown, blocked by safe-mode settings.` : `${signal.symbol}: no earnings date available, earnings filter inactive.`
    };
  }
  const now = new Date();
  const earningsDate = new Date(event.date);
  const diffDays = Math.ceil((earningsDate - now) / 86400000);
  const blockDays = Number(settings.earningsBlockDays || 3);
  if (Number.isFinite(diffDays) && diffDays >= 0 && diffDays <= blockDays) {
    return { blocked: true, active: true, reason: `Earnings in ${diffDays} day(s), blocked within ${blockDays}-day window.` };
  }
  return { blocked: false, active: true, reason: `Earnings on ${event.date}, outside the ${blockDays}-day block window.` };
}

function newsRiskFilter(signal, settings) {
  const catalyst = getCatalystSnapshot(signal.symbol, null, settings);
  if (!catalyst.active) {
    return { blocked: false, active: false, reason: "News/catalyst filter inactive. Add data/catalysts.json to enable." };
  }
  return {
    blocked: Boolean(catalyst.blocked),
    active: true,
    reason: catalyst.blocked ? catalyst.warnings.join(" ") : catalyst.reasons.join(" ") || "Catalyst/news check passed.",
    catalyst
  };
}

function applyTradeFilters(signal, settings, earningsCalendar = {}) {
  const feedCalendar = getEarningsCalendarFromCatalysts();
  const mergedCalendar = { ...feedCalendar, ...(earningsCalendar || {}) };
  const earningsResult = earningsFilter(signal, settings, mergedCalendar);
  const newsResult = newsRiskFilter(signal, settings);
  const filters = [earningsResult, newsResult];
  const blocked = filters.some(f => f.blocked);
  const activeFilters = filters.filter(f => f.active).length;
  return {
    ...signal,
    filterBlocked: blocked,
    filterReasons: filters.map(f => f.reason).filter(Boolean),
    filtersActive: activeFilters,
    earningsFilterActive: earningsResult.active,
    newsFilterActive: newsResult.active,
    catalyst: newsResult.catalyst || signal.catalyst || null,
    safety: blocked ? "REJECT" : signal.safety,
    action: blocked ? "IGNORE" : signal.action
  };
}

module.exports = { earningsFilter, newsRiskFilter, applyTradeFilters };
