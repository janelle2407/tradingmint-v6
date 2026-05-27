// ─── Market Hours Gate ────────────────────────────────────────────────────────
// US market: 9:30 AM – 4:00 PM Eastern Time (ET)
// Auto-paper trades only enter in the "opening window": 9:15 AM – 10:00 AM ET
// Sydney times (AEST = ET + 14h in May/winter, ET + 15h in summer/daylight saving)
// Uses UTC math directly — most reliable approach on cloud servers

function getETComponents() {
  // Get current time components in US Eastern Time
  // Uses Intl API which is reliable on all Node.js/Linux environments
  const now = new Date();
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      weekday: "short", hour12: false
    });
    const parts = fmt.formatToParts(now);
    const get = t => parts.find(p => p.type === t)?.value;
    const days = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
    const h = parseInt(get("hour")) % 24;
    const m = parseInt(get("minute"));
    const s = parseInt(get("second"));
    const day = days[get("weekday")] ?? new Date().getDay();
    return { h, m, s, day, totalMins: h * 60 + m };
  } catch(e) {
    // Fallback: UTC offset
    // EDT (Mar-Nov) = UTC-4, EST (Nov-Mar) = UTC-5
    const month = now.getUTCMonth();
    const isDST = month >= 2 && month <= 10;
    const offset = isDST ? -4 : -5;
    const et = new Date(now.getTime() + offset * 3600000);
    return {
      h: et.getUTCHours(), m: et.getUTCMinutes(), s: et.getUTCSeconds(),
      day: et.getUTCDay(), totalMins: et.getUTCHours() * 60 + et.getUTCMinutes()
    };
  }
}

function getMarketSession() {
  const { h, m, s, day, totalMins } = getETComponents();

  const PRE_MARKET_START  = 4  * 60;       // 4:00 AM ET
  const OPEN_WINDOW_START = 9  * 60 + 15;  // 9:15 AM ET  (auto-paper ON)
  const OPEN_WINDOW_END   = 10 * 60;       // 10:00 AM ET (auto-paper OFF)
  const MARKET_OPEN       = 9  * 60 + 30;  // 9:30 AM ET
  const MARKET_CLOSE      = 16 * 60;       // 4:00 PM ET
  const AFTER_HOURS_END   = 20 * 60;       // 8:00 PM ET

  const isWeekend = day === 0 || day === 6;
  const etTime = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')} ET`;
  const aestWindow = "11:15 PM – 12:00 AM AEST";
  const aestMarket = "11:30 PM – 6:00 AM AEST";

  if (isWeekend) {
    return {
      session: "WEEKEND", isMarketOpen: false, isOpeningWindow: false,
      autoPaperAllowed: false,
      reason: "US markets are closed on weekends.",
      etTime, nextEvent: "Market opens Monday 9:30 AM ET (11:30 PM AEST)",
      aestNote: aestWindow
    };
  }

  if (totalMins < PRE_MARKET_START) {
    return {
      session: "OVERNIGHT", isMarketOpen: false, isOpeningWindow: false,
      autoPaperAllowed: false,
      reason: "Overnight — market opens at 9:30 AM ET.",
      etTime, nextEvent: `Opening window at 9:15 AM ET (${aestWindow})`,
      aestNote: aestWindow
    };
  }

  if (totalMins >= PRE_MARKET_START && totalMins < OPEN_WINDOW_START) {
    const rem = OPEN_WINDOW_START - totalMins;
    return {
      session: "PRE_MARKET", isMarketOpen: false, isOpeningWindow: false,
      autoPaperAllowed: false,
      reason: `Pre-market. Auto-paper opens in ${Math.floor(rem/60)}h ${rem%60}m at 9:15 AM ET (${aestWindow}).`,
      etTime, nextEvent: `Opening window in ${rem} mins`,
      aestNote: aestWindow
    };
  }

  if (totalMins >= OPEN_WINDOW_START && totalMins < OPEN_WINDOW_END) {
    return {
      session: "OPENING_WINDOW", isMarketOpen: totalMins >= MARKET_OPEN,
      isOpeningWindow: true, autoPaperAllowed: true,
      reason: "✅ Opening window ACTIVE — auto-paper is entering trades now.",
      etTime, nextEvent: "Window closes at 10:00 AM ET (12:00 AM AEST)",
      aestNote: aestWindow
    };
  }

  if (totalMins >= OPEN_WINDOW_END && totalMins < MARKET_CLOSE) {
    return {
      session: "MARKET_OPEN", isMarketOpen: true, isOpeningWindow: false,
      autoPaperAllowed: false,
      reason: "Market open but past opening window. Auto-paper OFF to avoid mid-day chasing.",
      etTime, nextEvent: "Market closes at 4:00 PM ET",
      aestNote: aestMarket
    };
  }

  if (totalMins >= MARKET_CLOSE && totalMins < AFTER_HOURS_END) {
    return {
      session: "AFTER_HOURS", isMarketOpen: false, isOpeningWindow: false,
      autoPaperAllowed: false,
      reason: "After-hours trading. Prices unreliable. Auto-paper OFF.",
      etTime, nextEvent: "Next opening window tomorrow 9:15 AM ET",
      aestNote: aestWindow
    };
  }

  return {
    session: "OVERNIGHT", isMarketOpen: false, isOpeningWindow: false,
    autoPaperAllowed: false,
    reason: "Overnight — waiting for tomorrow's opening window.",
    etTime, nextEvent: "Opening window tomorrow 9:15 AM ET",
    aestNote: aestWindow
  };
}

// Check if signal price is still valid for entry
function isEntryStillValid(signal) {
  if (!signal || !signal.price || !signal.entry) return false;
  const price = Number(signal.price);
  const entry = Number(signal.entry);
  const stop  = Number(signal.stop);
  const buyHigh = Number(signal.buyHigh || entry * 1.006);
  if (price > buyHigh * 1.02) return false;
  if (stop && price <= stop * 1.01) return false;
  return true;
}

function getETTime() {
  const { h, m, s } = getETComponents();
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')} ET`;
}

module.exports = { getMarketSession, isEntryStillValid, getETTime };
