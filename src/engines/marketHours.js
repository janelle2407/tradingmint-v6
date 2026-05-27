// ─── Market Hours Gate ────────────────────────────────────────────────────────
// US market: 9:30 AM – 4:00 PM Eastern Time (ET)
// Auto-paper trades only enter in the "opening window": 9:15 AM – 10:00 AM ET
// This prevents entering trades based on stale closing prices overnight
// For users in Australia (AEST = ET + 15 hours):
//   Opening window = 11:15 PM – 12:00 AM AEST (Sydney)

function getETTime() {
  // Returns a Date object representing current time in US Eastern Time
  const now = new Date();
  const etString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  return new Date(etString);
}

function getMarketSession() {
  const et = getETTime();
  const day = et.getDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  const hours = et.getHours();
  const minutes = et.getMinutes();
  const totalMins = hours * 60 + minutes;

  const PRE_MARKET_START  = 4  * 60;       // 4:00 AM ET
  const OPEN_WINDOW_START = 9  * 60 + 15;  // 9:15 AM ET  (auto-paper ON)
  const OPEN_WINDOW_END   = 10 * 60;       // 10:00 AM ET (auto-paper OFF)
  const MARKET_OPEN       = 9  * 60 + 30;  // 9:30 AM ET
  const MARKET_CLOSE      = 16 * 60;       // 4:00 PM ET
  const AFTER_HOURS_END   = 20 * 60;       // 8:00 PM ET

  const isWeekend = day === 0 || day === 6;

  // AEST times (ET + 15 hours, next day)
  const aestOpen  = "11:15 PM – 12:00 AM AEST";
  const aestMarket = "11:30 PM – 3:00 PM AEST (next day)";

  if (isWeekend) {
    return {
      session: "WEEKEND",
      isMarketOpen: false,
      isOpeningWindow: false,
      autoPaperAllowed: false,
      reason: "US markets are closed on weekends.",
      etTime: formatET(et),
      nextEvent: "Market opens Monday 9:30 AM ET (11:30 PM AEST Sunday)",
      aestNote: aestOpen
    };
  }

  if (totalMins < PRE_MARKET_START) {
    return {
      session: "OVERNIGHT",
      isMarketOpen: false,
      isOpeningWindow: false,
      autoPaperAllowed: false,
      reason: "Overnight — market opens at 9:30 AM ET.",
      etTime: formatET(et),
      nextEvent: `Opening window starts at 9:15 AM ET (${aestOpen})`,
      aestNote: aestOpen
    };
  }

  if (totalMins >= PRE_MARKET_START && totalMins < OPEN_WINDOW_START) {
    const minsUntil = OPEN_WINDOW_START - totalMins;
    return {
      session: "PRE_MARKET",
      isMarketOpen: false,
      isOpeningWindow: false,
      autoPaperAllowed: false,
      reason: `Pre-market hours. Auto-paper entry opens in ${minsUntil} minutes at 9:15 AM ET.`,
      etTime: formatET(et),
      nextEvent: `Opening window in ${minsUntil} mins`,
      aestNote: aestOpen
    };
  }

  if (totalMins >= OPEN_WINDOW_START && totalMins < OPEN_WINDOW_END) {
    return {
      session: "OPENING_WINDOW",
      isMarketOpen: totalMins >= MARKET_OPEN,
      isOpeningWindow: true,
      autoPaperAllowed: true,
      reason: "Opening window — best time to enter trades. Auto-paper is ACTIVE.",
      etTime: formatET(et),
      nextEvent: "Opening window closes at 10:00 AM ET",
      aestNote: aestOpen
    };
  }

  if (totalMins >= OPEN_WINDOW_END && totalMins < MARKET_CLOSE) {
    return {
      session: "MARKET_OPEN",
      isMarketOpen: true,
      isOpeningWindow: false,
      autoPaperAllowed: false,
      reason: "Market is open but outside the opening window. Auto-paper is OFF to avoid mid-day chasing.",
      etTime: formatET(et),
      nextEvent: "Market closes at 4:00 PM ET",
      aestNote: aestMarket
    };
  }

  if (totalMins >= MARKET_CLOSE && totalMins < AFTER_HOURS_END) {
    return {
      session: "AFTER_HOURS",
      isMarketOpen: false,
      isOpeningWindow: false,
      autoPaperAllowed: false,
      reason: "After-hours trading. Prices are unreliable. Auto-paper is OFF.",
      etTime: formatET(et),
      nextEvent: "Next opening window: tomorrow 9:15 AM ET",
      aestNote: aestOpen
    };
  }

  return {
    session: "OVERNIGHT",
    isMarketOpen: false,
    isOpeningWindow: false,
    autoPaperAllowed: false,
    reason: "Overnight — waiting for tomorrow's opening window.",
    etTime: formatET(et),
    nextEvent: "Opening window tomorrow 9:15 AM ET",
    aestNote: aestOpen
  };
}

function formatET(date) {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: true, timeZone: "America/New_York"
  }) + " ET";
}

// Check if a signal's current price is still within acceptable entry zone
// Prevents entering if price gapped more than 2% above entry (chasing) or
// more than 1% below stop (already triggered)
function isEntryStillValid(signal) {
  if (!signal || !signal.price || !signal.entry) return false;
  const price = Number(signal.price);
  const entry = Number(signal.entry);
  const stop  = Number(signal.stop);
  const buyHigh = Number(signal.buyHigh || entry * 1.006);

  // Price gapped more than 2% above the buy zone — too late to chase
  if (price > buyHigh * 1.02) return false;

  // Price already at or below stop — trade is invalidated
  if (stop && price <= stop * 1.01) return false;

  return true;
}

module.exports = { getMarketSession, isEntryStillValid, getETTime };
