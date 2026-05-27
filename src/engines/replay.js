function buildReplay(db, symbol) {
  const events = [];
  for (const entry of db.journal || []) {
    if (!symbol || entry.symbol === symbol) {
      events.push({
        time: entry.time,
        type: entry.eventType,
        symbol: entry.symbol,
        note: entry.note,
        details: entry.details
      });
    }
  }

  const closed = (db.paper.closed || []).filter(t => !symbol || t.symbol === symbol);
  for (const trade of closed) {
    events.push({
      time: trade.exitTime,
      type: "CLOSED_TRADE",
      symbol: trade.symbol,
      note: trade.exitReason,
      details: trade
    });
  }

  return events.sort((a, b) => Date.parse(a.time || 0) - Date.parse(b.time || 0));
}

module.exports = { buildReplay };
