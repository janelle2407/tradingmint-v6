// ─── Trade Filters ────────────────────────────────────────────────────────────
// Earnings filter: blocks trades too close to earnings dates
// News filter: placeholder — no live news source connected
// Both clearly report their status so the UI can show what's active

function earningsFilter(signal, settings, earningsCalendar = {}) {
  const event = earningsCalendar[signal.symbol];

  // No earnings data at all for this symbol
  if (!event) {
    const blocked = Boolean(settings.blockUnknownEarnings);
    return {
      blocked,
      active: false, // filter is not actively working — no data
      reason: blocked
        ? `⚠️ ${signal.symbol}: earnings date unknown — blocked by settings (safe mode).`
        : `ℹ️ ${signal.symbol}: no earnings date available — filter inactive.`
    };
  }

  const now = new Date();
  const earningsDate = new Date(event.date);
  const diffDays = (earningsDate - now) / 86400000; // positive = upcoming, negative = past
  const blockDays = Number(settings.earningsBlockDays || 3);

  if (Math.abs(diffDays) <= blockDays) {
    return {
      blocked: true,
      active: true,
      reason: `Earnings ${diffDays >= 0 ? 'in' : ''} ${Math.abs(diffDays).toFixed(0)} days — blocked within ${blockDays}-day window.`
    };
  }

  return {
    blocked: false,
    active: true,
    reason: `Earnings on ${event.date} — safely outside ${blockDays}-day window.`
  };
}

function newsRiskFilter(signal) {
  // No live news source connected — be honest about it
  return {
    blocked: false,
    active: false,
    reason: "ℹ️ News filter inactive — no live news source connected."
  };
}

function applyTradeFilters(signal, settings, earningsCalendar = {}) {
  const earningsResult = earningsFilter(signal, settings, earningsCalendar);
  const newsResult = newsRiskFilter(signal);

  const filters = [earningsResult, newsResult];
  const blocked = filters.some(f => f.blocked);
  const activeFilters = filters.filter(f => f.active).length;

  return {
    ...signal,
    filterBlocked: blocked,
    filterReasons: filters.map(f => f.reason),
    filtersActive: activeFilters,
    earningsFilterActive: earningsResult.active,
    safety: blocked ? "REJECT" : signal.safety,
    action: blocked ? "IGNORE" : signal.action
  };
}

module.exports = { earningsFilter, newsRiskFilter, applyTradeFilters };
