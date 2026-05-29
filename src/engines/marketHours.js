// ─── Market Hours Gate ────────────────────────────────────────────────────────
// US market: 9:30 AM – 4:00 PM Eastern Time (ET)
// Auto-paper trades allowed throughout the full session with these rules:
//   - Skip first 15 mins (9:30–9:45) — chaotic open
//   - Skip lunch (12:00–1:00) — low volume, unreliable
//   - Skip last 15 mins (3:45–4:00) — close-day noise
//   - Active windows: 9:45 AM–12:00 PM and 1:00–3:45 PM ET
// Sydney times (AEST = ET + 14h in May/winter, ET + 15h in Nov/summer)

function getETComponents() {
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

  const PRE_MARKET_START  = 4  * 60;        // 4:00 AM ET
  const MARKET_OPEN       = 9  * 60 + 30;   // 9:30 AM ET
  const SESSION_START     = 9  * 60 + 45;   // 9:45 AM ET — skip first 15 mins chaos
  const LUNCH_START       = 11 * 60 + 30;   // 11:30 AM ET — lunch begins
  const LUNCH_END         = 13 * 60 + 30;   // 1:30 PM ET  — lunch ends
  const CLOSE_BUFFER      = 15 * 60 + 45;   // 3:45 PM ET  — no new entries last 15 mins
  const MARKET_CLOSE      = 16 * 60;        // 4:00 PM ET
  const AFTER_HOURS_END   = 20 * 60;        // 8:00 PM ET

  const isWeekend = day === 0 || day === 6;

  // Sydney time note (AEST = ET + 14h in winter, +15h in summer)
  const etTime = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')} ET`;
  const aestSession1 = "11:45 PM – 1:30 AM AEST (morning session)";
  const aestSession2 = "3:30 AM – 5:45 AM AEST (afternoon session)";
  const aestMarket   = "11:30 PM – 6:00 AM AEST";

  if (isWeekend) {
    return {
      session: "WEEKEND", isMarketOpen: false, autoPaperAllowed: false,
      reason: "US markets are closed on weekends.",
      etTime, nextEvent: "Market opens Monday 9:30 AM ET (11:30 PM AEST)",
      aestNote: aestMarket
    };
  }

  if (totalMins < PRE_MARKET_START) {
    return {
      session: "OVERNIGHT", isMarketOpen: false, autoPaperAllowed: false,
      reason: "Overnight — waiting for market open.",
      etTime, nextEvent: `Market opens 9:30 AM ET. First entries at 9:45 AM ET (11:45 PM AEST)`,
      aestNote: aestMarket
    };
  }

  if (totalMins >= PRE_MARKET_START && totalMins < SESSION_START) {
    const rem = SESSION_START - totalMins;
    return {
      session: "PRE_MARKET", isMarketOpen: totalMins >= MARKET_OPEN, autoPaperAllowed: false,
      reason: `Pre-market / early open. Auto-paper starts in ${rem} min at 9:45 AM ET (11:45 PM AEST) — skipping first 15 mins of chaos.`,
      etTime, nextEvent: `Auto-paper opens in ${rem} mins`,
      aestNote: aestMarket
    };
  }

  // Morning session: 9:45 AM – 11:30 AM ET ✅ ACTIVE
  if (totalMins >= SESSION_START && totalMins < LUNCH_START) {
    const rem = LUNCH_START - totalMins;
    return {
      session: "MORNING_SESSION", isMarketOpen: true, autoPaperAllowed: true,
      reason: `✅ Morning session ACTIVE (9:45 AM–11:30 AM ET) — best trading window. Auto-paper ON.`,
      etTime, nextEvent: `Lunch pause in ${rem} mins at 11:30 AM ET`,
      aestNote: aestSession1
    };
  }

  // Lunch pause: 11:30 AM – 1:30 PM ET ❌ PAUSED
  if (totalMins >= LUNCH_START && totalMins < LUNCH_END) {
    const rem = LUNCH_END - totalMins;
    return {
      session: "LUNCH_HOURS", isMarketOpen: true, autoPaperAllowed: false,
      isLunchHours: true,
      reason: `Lunch hours (11:30 AM–1:30 PM ET) — low volume, choppy price action. Auto-paper paused for ${rem} mins.`,
      etTime, nextEvent: `Afternoon session resumes in ${rem} mins at 1:30 PM ET`,
      aestNote: "1:30 AM – 3:30 AM AEST (lunch pause)"
    };
  }

  // Afternoon session: 1:30 PM – 3:45 PM ET ✅ ACTIVE
  if (totalMins >= LUNCH_END && totalMins < CLOSE_BUFFER) {
    const rem = CLOSE_BUFFER - totalMins;
    return {
      session: "AFTERNOON_SESSION", isMarketOpen: true, autoPaperAllowed: true,
      reason: `✅ Afternoon session ACTIVE (1:30–3:45 PM ET) — auto-paper ON. ${rem} mins remaining.`,
      etTime, nextEvent: `Close buffer starts in ${rem} mins at 3:45 PM ET`,
      aestNote: aestSession2
    };
  }

  // Close buffer: 3:45 PM – 4:00 PM ET ❌ NO NEW ENTRIES
  if (totalMins >= CLOSE_BUFFER && totalMins < MARKET_CLOSE) {
    return {
      session: "MARKET_CLOSE_BUFFER", isMarketOpen: true, autoPaperAllowed: false,
      reason: "Last 15 mins before close — no new entries. Existing positions monitored for exit.",
      etTime, nextEvent: "Market closes at 4:00 PM ET (6:00 AM AEST)",
      aestNote: aestMarket
    };
  }

  // After hours
  if (totalMins >= MARKET_CLOSE && totalMins < AFTER_HOURS_END) {
    return {
      session: "AFTER_HOURS", isMarketOpen: false, autoPaperAllowed: false,
      reason: "After-hours trading. Prices unreliable. Auto-paper OFF.",
      etTime, nextEvent: "Market opens tomorrow 9:30 AM ET",
      aestNote: aestMarket
    };
  }

  return {
    session: "OVERNIGHT", isMarketOpen: false, autoPaperAllowed: false,
    reason: "Overnight — waiting for tomorrow's market open.",
    etTime, nextEvent: "Market opens 9:30 AM ET (11:30 PM AEST)",
    aestNote: aestMarket
  };
}

function isEntryStillValid(signal) {
  if (!signal || !signal.price || !signal.entry) return false;
  const price  = Number(signal.price);
  const entry  = Number(signal.entry);
  const stop   = Number(signal.stop);
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
