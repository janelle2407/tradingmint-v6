// ─── Paper Trading Engine v2 ─────────────────────────────────────────────────
// v2: Position Pyramid Scaling
//   Entry 1: 50% of position at initial signal
//   Entry 2: +25% if price pulls back to VWAP or EMA20 (without hitting stop)
//   Entry 3: +25% when price makes a new high (trade proven itself)
// This reduces risk on entries that don't immediately work

const { applyCosts, canEnter } = require("./risk");
const { addAlert, addJournal } = require("../storage/db");
const { exposureBlocked } = require("./correlation");
function round(v, d = 2) { const n = Number(v); return Number.isFinite(n) ? Number(n.toFixed(d)) : null; }
function money(v) { return v == null ? '--' : '$' + Number(v).toFixed(2); }

// ─── Enter Paper Trade (initial 50% position) ─────────────────────────────────

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

  // ── Pyramid Scaling: enter at 50% of full position size ──
  // Full size would be check.shares. We enter half now.
  // Remaining 50% added in two 25% tranches as trade proves itself.
  const fullShares  = check.shares;
  const initShares  = Math.max(1, Math.floor(fullShares * 0.5)); // 50% now
  const addShares1  = Math.max(0, Math.floor(fullShares * 0.25)); // 25% on pullback
  const addShares2  = Math.max(0, fullShares - initShares - addShares1); // remaining ~25% on new high

  const cost = entry * initShares + Number(db.settings.commissionPerTrade || 0);
  if (cost > db.paper.cash) {
    return { ok: false, reasons: ["Not enough paper cash."] };
  }

  // Recalculate stop/targets based on actual entry price
  const actualEntry  = Number(entry.toFixed(4));
  const originalRisk = Math.max(0.01, Number(signal.entry) - Number(signal.stop));
  const priceDiff    = actualEntry - Number(signal.entry);
  const adjustedStop    = round(Number(signal.stop)    + priceDiff);
  const adjustedTarget1 = round(Number(signal.target1) + priceDiff);
  const adjustedTarget2 = round(Number(signal.target2) + priceDiff);
  const trailingStop = signal.trailingStop ? round(Number(signal.trailingStop) + priceDiff) : adjustedStop;
  const trailingAtr  = signal.trailingAtr || originalRisk * 0.5;

  const position = {
    id: "POS-" + Date.now() + "-" + Math.random().toString(16).slice(2),
    symbol:    signal.symbol,
    setup:     signal.setup,
    action:    signal.action,
    shares:    initShares,
    originalShares: initShares,
    entry:     actualEntry,
    avgEntry:  actualEntry,
    totalCost: Number((actualEntry * initShares).toFixed(4)),
    rawEntry:  signal.entry,
    stop:      adjustedStop,
    originalStop: signal.stop,
    trailingStop,
    trailingAtr,
    target1:   adjustedTarget1,
    target2:   adjustedTarget2,
    highSinceEntry: actualEntry, // track highest price for pyramid entry 3
    confidence: signal.confidence,
    rrNumber:  signal.rrNumber,
    source,
    sectorEtf: signal.sectorEtf || null,
    entryTime: new Date().toISOString(),
    lastPrice: signal.price,
    reasons:   signal.reasons,
    warnings:  signal.warnings,
    // Pyramid scaling state
    pyramidEnabled:  addShares1 > 0 || addShares2 > 0,
    pyramidEntry2Done: false,   // pullback add
    pyramidEntry3Done: false,   // new high add
    pyramidAddShares1: addShares1,
    pyramidAddShares2: addShares2,
    pyramidVwap:    signal.vwap    || null,
    pyramidEma20:   signal.ema20   || null, // passed from signal
    pyramidPhase:   "WAITING_PULLBACK",     // WAITING_PULLBACK → WAITING_NEW_HIGH → COMPLETE
    fullShares,
    scalingNote: addShares1 > 0
      ? `Entered ${initShares} of ${fullShares} shares (50%). Will add ${addShares1} on pullback to VWAP/EMA, then ${addShares2} on new high.`
      : `Entered full ${initShares} shares (position too small to pyramid).`
  };

  db.paper.cash -= cost;
  db.paper.open.push(position);
  addAlert(db, "PAPER_ENTRY", signal.symbol, `${signal.symbol} initial entry (50% position)`, position);
  addJournal(db, "PAPER_ENTRY", signal.symbol,
    `${signal.symbol} pyramid entry 1/3 — ${initShares} shares at ${money(actualEntry)}. ${position.scalingNote}`,
    position);
  return { ok: true, position };
}

// ─── Scale Into Position (add shares) ────────────────────────────────────────

function scalePyramid(db, position, addShares, price, reason) {
  if (!addShares || addShares < 1) return null;
  const entry = applyCosts(price, "buy", db.settings);
  const cost  = entry * addShares + Number(db.settings.commissionPerTrade || 0) / 2;
  if (cost > db.paper.cash) return null;

  const priorShares = Number(position.shares || 0);
  const priorCost = Number.isFinite(Number(position.totalCost))
    ? Number(position.totalCost)
    : Number(position.avgEntry || position.entry) * priorShares;

  position.shares += addShares;
  db.paper.cash -= cost;
  position.totalCost = Number((priorCost + entry * addShares).toFixed(4));
  position.avgEntry = round(position.totalCost / position.shares, 4);

  addAlert(db, "PYRAMID_ADD", position.symbol,
    `${position.symbol} pyramid add — ${reason}`, { addShares, price: entry, avgEntry: position.avgEntry });
  addJournal(db, "PYRAMID_ADD", position.symbol,
    `${position.symbol} added ${addShares} shares at ${money(entry)} — ${reason}. Total: ${position.shares} shares, avg entry ${money(position.avgEntry)}`,
    { addShares, newTotal: position.shares, avgEntry: position.avgEntry });
  return { ok: true, addShares, avgEntry: position.avgEntry };
}

// ─── Exit Paper Trade ─────────────────────────────────────────────────────────

function exitPaper(db, positionId, exitPrice, reason = "Manual exit") {
  const index = db.paper.open.findIndex(pos => pos.id === positionId || pos.symbol === positionId);
  if (index === -1) return { ok: false, error: "Position not found." };

  const position = db.paper.open[index];
  const adjustedExit = applyCosts(Number(exitPrice || position.lastPrice || position.entry), "sell", db.settings);
  const effectiveEntry = position.avgEntry || position.entry;
  const proceeds = adjustedExit * position.shares - Number(db.settings.commissionPerTrade || 0);
  const cost = effectiveEntry * position.shares + Number(db.settings.commissionPerTrade || 0);
  const pnl  = proceeds - cost;
  const pnlPct = cost ? (pnl / cost) * 100 : 0;

  const closed = {
    ...position,
    exit:      Number(adjustedExit.toFixed(4)),
    exitTime:  new Date().toISOString(),
    exitReason: reason,
    proceeds:  Number(proceeds.toFixed(2)),
    pnl:       Number(pnl.toFixed(2)),
    pnlPct:    Number(pnlPct.toFixed(2))
  };

  db.paper.open.splice(index, 1);
  db.paper.cash += proceeds;
  db.paper.closed.unshift(closed);
  addAlert(db, "PAPER_EXIT", position.symbol, `${position.symbol} paper exit`, closed);
  addJournal(db, "PAPER_EXIT", position.symbol,
    `${position.symbol} exited ${position.shares} shares at ${money(adjustedExit)}. P/L: ${money(pnl)}`, closed);
  return { ok: true, closed };
}

// ─── Partial Exit at Target 1 ────────────────────────────────────────────────

function partialExitPaper(db, position, exitPrice, reason) {
  const halfShares = Math.floor(position.shares / 2);
  if (halfShares < 1) return null;

  const effectiveEntry = Number(position.avgEntry || position.entry);
  const adjustedExit = applyCosts(Number(exitPrice), "sell", db.settings);
  const proceeds = adjustedExit * halfShares - Number(db.settings.commissionPerTrade || 0) / 2;
  const cost = effectiveEntry * halfShares;
  const pnl  = proceeds - cost;

  const partial = {
    ...position,
    shares:    halfShares,
    exit:      Number(adjustedExit.toFixed(4)),
    exitTime:  new Date().toISOString(),
    exitReason: reason + " (partial — half position)",
    proceeds:  Number(proceeds.toFixed(2)),
    pnl:       Number(pnl.toFixed(2)),
    pnlPct:    Number(((pnl / cost) * 100).toFixed(2)),
    isPartial: true
  };

  position.shares -= halfShares;
  position.totalCost = Number(Math.max(0, Number(position.totalCost || effectiveEntry * (position.shares + halfShares)) - cost).toFixed(4));
  position.avgEntry = position.shares > 0 ? round(position.totalCost / position.shares, 4) : effectiveEntry;
  position.stop = effectiveEntry;
  position.trailingStop = effectiveEntry;
  position.partialExitDone = true;
  position.partialExitPrice = adjustedExit;
  position.partialExitPnl = pnl;
  position.pyramidEntry2Done = true;
  position.pyramidEntry3Done = true;
  position.pyramidPhase = "COMPLETE";

  db.paper.cash += proceeds;
  db.paper.closed.unshift(partial);
  addAlert(db, "PARTIAL_EXIT", position.symbol,
    `${position.symbol} partial exit at T1 — stop moved to breakeven`, partial);
  addJournal(db, "PARTIAL_EXIT", position.symbol,
    `${position.symbol} sold half at ${money(adjustedExit)} — stop to breakeven ${money(effectiveEntry)}. P/L: ${money(pnl)}`,
    { partial, remainingShares: position.shares, newStop: effectiveEntry });
  return { ok: true, partial, remainingShares: position.shares };
}

// ─── Update Open Positions ────────────────────────────────────────────────────

function updateOpenPositions(db, signals) {
  const bySymbol = new Map(signals.map(s => [s.symbol, s]));
  const exits = [];

  for (const position of [...db.paper.open]) {
    const signal = bySymbol.get(position.symbol);
    if (!signal) continue;
    position.lastPrice = signal.price;
    const price = signal.price;

    // Track highest price since entry (for pyramid entry 3)
    if (price > (position.highSinceEntry || position.entry)) {
      position.highSinceEntry = price;
    }

    // ── Trailing stop update ──
    const effectiveEntryForTrail = position.avgEntry || position.entry;
    if (position.trailingAtr && price > effectiveEntryForTrail) {
      const newTrailing = round(price - position.trailingAtr * 1.5);
      if (newTrailing > (position.trailingStop || position.stop)) {
        position.trailingStop = newTrailing;
        if (newTrailing > position.stop) position.stop = newTrailing;
      }
    }

    // ── Pyramid Scale-In Logic ──
    if (position.pyramidEnabled && !position.partialExitDone) {

      // Entry 2: Add 25% on pullback to VWAP or EMA20 (without hitting stop)
      if (!position.pyramidEntry2Done && position.pyramidAddShares1 > 0 &&
          position.pyramidPhase === "WAITING_PULLBACK") {
        const vwap  = position.pyramidVwap  || null;
        const ema20 = position.pyramidEma20 || null;
        const nearVwap  = vwap  && price <= vwap  * 1.005 && price >= vwap  * 0.98;
        const nearEma20 = ema20 && price <= ema20 * 1.005 && price >= ema20 * 0.98;
        const aboveStop = price > position.stop * 1.005;

        if ((nearVwap || nearEma20) && aboveStop) {
          const reason = nearVwap
            ? `Price pulled back to VWAP ($${round(vwap)}) — adding 25%`
            : `Price pulled back to EMA20 ($${round(ema20)}) — adding 25%`;
          scalePyramid(db, position, position.pyramidAddShares1, price, reason);
          position.pyramidEntry2Done = true;
          position.pyramidPhase      = "WAITING_NEW_HIGH";
        }
      }

      // Entry 3: Add final 25% on new high (trade has proven itself)
      if (!position.pyramidEntry3Done && position.pyramidAddShares2 > 0 &&
          position.pyramidPhase === "WAITING_NEW_HIGH") {
        // New high = price exceeds entry by at least 1.5% AND is the highest since entry
        const provenEntry = position.avgEntry || position.entry;
        const isNewHigh = price >= provenEntry * 1.015 &&
                          price >= (position.highSinceEntry || provenEntry) * 0.998;
        if (isNewHigh && position.pyramidEntry2Done) {
          scalePyramid(db, position, position.pyramidAddShares2, price,
            `Price at new high ($${round(price)}) — trade proven, adding final 25%`);
          position.pyramidEntry3Done = true;
          position.pyramidPhase      = "COMPLETE";
        }
      }
    }

    // ── Exit checks ──
    if (price <= position.stop) {
      exits.push(exitPaper(db, position.id, price, "Stop hit"));
    } else if (price >= position.target2 && position.partialExitDone) {
      exits.push(exitPaper(db, position.id, price, "Target 2 hit — full exit"));
    } else if (price >= position.target1 && !position.partialExitDone && position.shares >= 2) {
      partialExitPaper(db, position, price, "Target 1 hit");
    } else if (price >= position.target1 && !position.partialExitDone && position.shares < 2) {
      exits.push(exitPaper(db, position.id, price, "Target 1 hit"));
    } else if (signal.safety === "REJECT" && signal.confidence < 55) {
      exits.push(exitPaper(db, position.id, price, "Signal deteriorated"));
    }
  }

  return exits;
}

// ─── Paper Stats ──────────────────────────────────────────────────────────────

function paperStats(db) {
  const closed = db.paper.closed || [];
  if (!closed.length) return {
    totalTrades: 0, winRate: null, expectancy: null,
    profitFactor: null, maxDrawdown: null, totalReturn: null, equityCurve: []
  };

  const wins        = closed.filter(t => t.pnl > 0);
  const losses      = closed.filter(t => t.pnl <= 0);
  const grossWins   = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalPnl    = closed.reduce((s, t) => s + t.pnl, 0);
  const expectancy  = totalPnl / closed.length;

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
    maxDrawdown    = Math.max(maxDrawdown, drawdown);
  }

  return {
    totalTrades:  closed.length,
    winRate:      Number(((wins.length / closed.length) * 100).toFixed(1)),
    expectancy:   Number(expectancy.toFixed(2)),
    profitFactor: grossLosses ? Number((grossWins / grossLosses).toFixed(2)) : null,
    maxDrawdown:  Number(maxDrawdown.toFixed(2)),
    totalReturn:  Number(((totalPnl / Number(db.settings.startingCash || 5000)) * 100).toFixed(2)),
    equityCurve
  };
}

module.exports = { enterPaper, exitPaper, updateOpenPositions, paperStats, scalePyramid };
