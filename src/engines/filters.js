function earningsFilter(signal, settings, earningsCalendar = {}) {
  const event = earningsCalendar[signal.symbol];
  if (!event) {
    return {
      blocked: Boolean(settings.blockUnknownEarnings),
      reason: settings.blockUnknownEarnings ? "Unknown earnings date blocked by settings." : "Unknown earnings date allowed."
    };
  }

  const now = new Date();
  const earningsDate = new Date(event.date);
  const diffDays = Math.abs((earningsDate - now) / 86400000);
  if (diffDays <= Number(settings.earningsBlockDays || 3)) {
    return { blocked: true, reason: `Earnings within ${settings.earningsBlockDays} days.` };
  }
  return { blocked: false, reason: "Earnings filter passed." };
}

function newsRiskFilter(signal) {
  return {
    blocked: false,
    reason: "News filter shell ready. No live news source connected yet."
  };
}

function applyTradeFilters(signal, settings, earningsCalendar = {}) {
  const filters = [
    earningsFilter(signal, settings, earningsCalendar),
    newsRiskFilter(signal)
  ];
  const blocked = filters.some(filter => filter.blocked);
  return {
    ...signal,
    filterBlocked: blocked,
    filterReasons: filters.map(filter => filter.reason),
    safety: blocked ? "REJECT" : signal.safety,
    action: blocked ? "IGNORE" : signal.action
  };
}

module.exports = { earningsFilter, newsRiskFilter, applyTradeFilters };
