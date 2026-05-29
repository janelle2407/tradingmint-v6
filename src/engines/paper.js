const { applyCosts, canEnter } = require("./risk");
const { addAlert, addJournal } = require("../storage/db");
const { exposureBlocked } = require("./correlation");
function round(v, d = 2) { const n = Number(v); return Number.isFinite(n) ? Number(n.toFixed(d)) : null; }

function enterPaper(db, signal, source = "manual", barsBySymbol = {}) {
  const exposure = signal ? exposureBlocked(signal, db.paper, db.settings, barsBySymbol) : { blocked: false };
  if (exposure.blocked) {
    addJournal(db, "ENTRY_REJECTED_EXPOSURE", signal?.symbol || "-", exposure.reason, { signal, exposure });
    return { ok: false, reasons: [exposure.reason], exposure };
  }

  const check = canEnter(db.paper, signal, db.settings, paperStats(db));
  if (!check.ok) {
    addJournal(db, "ENTRY_REJECTED", signal?.symbol || "-", check.reasons.join(" "), { signal });
    return { ok: false, reasons: check.reasons };
  }

  const entry = applyCosts(signal.entry, "buy", db.settings);
  const shares = check.shares;
  const cost = entry * shares + Number(db.settings.commissionPerTrade || 0);
  if (cost > db.paper.cash) {
    return { ok: false, reasons: ["Not enough paper cash."] };
  }

  // Fix 1: Recalculate stop/targets based on ACTUAL entry price (not yesterday's close)
  // This prevents the gap problem where stop was calculated for a different price
  const actualEntry = Number(entry.toFixed(4));
  const originalRisk = Math.max(0.01, Number(signal.entry) - Number(signal.stop));
  const priceDiff = actualEntry - Number(signal.entry);
  // Shift stop and targets by the same amount the entry shifted
  const adjustedStop = round(Number(signal.stop) + priceDiff);
  const adjustedTarget1 = round(Number(signal.target1) + priceDiff);
  const adjustedTarget2 = round(Number(signal.target2) + priceDiff);
  // Trailing stop starts at adjusted stop
  const trailingStop = signal.trailingStop ? round(Number(signal.trailingStop) + priceDiff) : adjustedStop;
  const trailingAtr = signal.trailingAtr || originalRisk * 0.5;

  const position = {
    id: "POS-" + Date.now() + "-" + Math.random().toString(16).slice(2),
    symbol: signal.symbol,
    setup: signal.setup,
    action: signal.action,
    shares,
    entry: actualEntry,
    rawEntry: signal.entry,
    stop: adjustedStop,
    originalStop: signal.stop,
    trailingStop,
    trailingAtr,
    target1: adjustedTarget1,
    target2: adjustedTarget2,
    confidence: signal.confidence,
    rrNumber: signal.rrNumber,
    source,
    sectorEtf: signal.sectorEtf || null,
    entryTime: new Date().toISOString(),
    lastPrice: signal.price,
    reasons: signal.reasons,
    warnings: signal.warnings
  };

  db.paper.cash -= cost;
  db.paper.open.push(position);
  addAlert(db, "PAPER_ENTRY", signal.symbol, `${signal.symbol} paper entry`, position);
  addJournal(db, "PAPER_ENTRY", signal.symbol, `${signal.symbol} entered at ${position.entry}`, position);
  return { ok: true, position };
}

function exitPaper(db, positionId, exitPrice, reason = "Manual exit") {
  const index = db.paper.open.findIndex(pos => pos.id === positionId || pos.symbol === positionId);
  if (index === -1) return { ok: false, error: "Position not found." };

  const position = db.paper.open[index];
  const adjustedExit = applyCosts(Number(exitPrice || position.lastPrice || position.entry), "sell", db.settings);
  const proceeds = adjustedExit * position.shares - Number(db.settings.commissionPerTrade || 0);
  const cost = position.entry * position.shares + Number(db.settings.commissionPerTrade || 0);
  const pnl = proceeds - cost;
  const pnlPct = cost ? (pnl / cost) * 100 : 0;

  const closed = {
    ...position,
    exit: Number(adjustedExit.toFixed(4)),
    exitTime: new Date().toISOString(),
    exitReason: reason,
    proceeds: Number(proceeds.toFixed(2)),
    pnl: Number(pnl.toFixed(2)),
    pnlPct: Number(pnlPct.toFixed(2))
  };

  db.paper.open.splice(index, 1);
  db.paper.cash += proceeds;
  db.paper.closed.unshift(closed);
  addAlert(db, "PAPER_EXIT", position.symbol, `${position.symbol} paper exit`, closed);
  addJournal(db, "PAPER_EXIT", position.symbol, `${position.symbol} exited. P/L ${closed.pnl}`, closed);
  return { ok: true, closed };
}

// Partial exit — sell half the position at Target 1, move stop to breakeven
function partialExitPaper(db, position, exitPrice, reason) {
  const halfShares = Math.floor(position.shares / 2);
  if (halfShares < 1) return null; // Can't split 1 share

  const adjustedExit = applyCosts(Number(exitPrice), "sell", db.settings);
  const proceeds = adjustedExit * halfShares - Number(db.settings.commissionPerTrade || 0) / 2;
  const cost = position.entry * halfShares;
  const pnl = proceeds - cost;

  // Record the partial exit
  const partial = {
    ...position,
    shares: halfShares,
    exit: Number(adjustedExit.toFixed(4)),
    exitTime: new Date().toISOString(),
    exitReason: reason + " (partial — half position)",
    proceeds: Number(proceeds.toFixed(2)),
    pnl: Number(pnl.toFixed(2)),
    pnlPct: Number(((pnl / cost) * 100).toFixed(2)),
    isPartial: true
  };

  // Update remaining position
  position.shares -= halfShares;
  position.stop = position.entry; // Move stop to breakeven — now risk-free!
  position.trailingStop = position.entry;
  position.partialExitDone = true;
  position.partialExitPrice = adjustedExit;
  position.partialExitPnl = pnl;

  db.paper.cash += proceeds;
  db.paper.closed.unshift(partial);
  addAlert(db, "PARTIAL_EXIT", position.symbol, `${position.symbol} partial exit at T1 — stop moved to breakeven`, partial);
  addJournal(db, "PARTIAL_EXIT", position.symbol,
    `${position.symbol} sold half at ${money(adjustedExit)} — stop moved to breakeven ${money(position.entry)}. P/L: ${money(pnl)}`,
    { partial, remainingShares: position.shares, newStop: position.entry });

  return { ok: true, partial, remainingShares: position.shares };
}

function money(v) { return v == null ? '--' : '$' + Number(v).toFixed(2); }

function updateOpenPositions(db, signals) {
  const bySymbol = new Map(signals.map(signal => [signal.symbol, signal]));
  const exits = [];
  for (const position of [...db.paper.open]) {
    const signal = bySymbol.get(position.symbol);
    if (!signal) continue;
    position.lastPrice = signal.price;

    // Fix 5: Update trailing stop as price moves in our favour
    if (position.trailingAtr && signal.price > position.entry) {
      const newTrailing = round(signal.price - position.trailingAtr * 1.5);
      if (newTrailing > (position.trailingStop || position.stop)) {
        position.trailingStop = newTrailing;
        // Only raise the hard stop if trailing is higher
        if (newTrailing > position.stop) {
          position.stop = newTrailing;
        }
      }
    }

    // Check exits — partial exit at T1, full exit at T2 or stop
    if (signal.price <= position.stop) {
      exits.push(exitPaper(db, position.id, signal.price, "Stop hit"));
    } else if (signal.price >= position.target2 && position.partialExitDone) {
      // Full exit at Target 2 after partial exit already taken
      exits.push(exitPaper(db, position.id, signal.price, "Target 2 hit — full exit"));
    } else if (signal.price >= position.target1 && !position.partialExitDone && position.shares >= 2) {
      // Partial exit at Target 1 — sell half, move stop to breakeven
      partialExitPaper(db, position, signal.price, "Target 1 hit");
    } else if (signal.price >= position.target1 && !position.partialExitDone && position.shares < 2) {
      // Only 1 share — do full exit
      exits.push(exitPaper(db, position.id, signal.price, "Target 1 hit"));
    } else if (signal.safety === "REJECT" && signal.confidence < 55) {
      exits.push(exitPaper(db, position.id, signal.price, "Signal deteriorated"));
    }
  }
  return exits;
}

function paperStats(db) {
  const closed = db.paper.closed || [];
  if (!closed.length) {
    return {
      totalTrades: 0,
      winRate: null,
      expectancy: null,
      profitFactor: null,
      maxDrawdown: null,
      totalReturn: null,
      equityCurve: []
    };
  }

  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const grossWins = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLosses = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
  const totalPnl = closed.reduce((sum, t) => sum + t.pnl, 0);
  const expectancy = totalPnl / closed.length;
  const equityCurve = [];
  let equity = Number(db.settings.startingCash || 5000);
  for (const trade of [...closed].reverse()) {
    equity += Number(trade.pnl || 0);
    equityCurve.push({ time: trade.exitTime, equity: Number(equity.toFixed(2)) });
  }

  let peak = Number(db.settings.startingCash || 5000);
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    const drawdown = peak ? ((peak - point.equity) / peak) * 100 : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  return {
    totalTrades: closed.length,
    winRate: Number(((wins.length / closed.length) * 100).toFixed(1)),
    expectancy: Number(expectancy.toFixed(2)),
    profitFactor: grossLosses ? Number((grossWins / grossLosses).toFixed(2)) : null,
    maxDrawdown: Number(maxDrawdown.toFixed(2)),
    totalReturn: Number(((totalPnl / Number(db.settings.startingCash || 5000)) * 100).toFixed(2)),
    equityCurve
  };
}

module.exports = { enterPaper, exitPaper, updateOpenPositions, paperStats };
