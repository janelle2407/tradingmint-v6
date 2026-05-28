function getETComponents() {
  const now = new Date();
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const parts = formatter.formatToParts(now);
    const get = type => parts.find(p => p.type === type)?.value;
    const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const h = parseInt(get("hour"), 10) % 24;
    const m = parseInt(get("minute"), 10);
    const s = parseInt(get("second"), 10);
    const day = days[get("weekday")] ?? now.getUTCDay();
    return { h, m, s, day, totalMins: h * 60 + m };
  } catch {
    const month = now.getUTCMonth();
    const isDstApprox = month >= 2 && month <= 10;
    const offset = isDstApprox ? -4 : -5;
    const et = new Date(now.getTime() + offset * 3600000);
    return { h: et.getUTCHours(), m: et.getUTCMinutes(), s: et.getUTCSeconds(), day: et.getUTCDay(), totalMins: et.getUTCHours() * 60 + et.getUTCMinutes() };
  }
}

function formatSydneyNow() {
  try {
    return new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: true, timeZoneName: "short" }).format(new Date());
  } catch { return "Sydney time unavailable"; }
}

function getMarketSession() {
  const { h, m, s, day, totalMins } = getETComponents();
  const PRE_MARKET_START = 4 * 60;
  const MARKET_OPEN = 9 * 60 + 30;
  const OPEN_WINDOW_START = 9 * 60 + 45;
  const OPEN_WINDOW_END = 10 * 60 + 30;
  const CLOSE_BUFFER = 15 * 60 + 45;
  const MARKET_CLOSE = 16 * 60;
  const AFTER_HOURS_END = 20 * 60;
  const isWeekend = day === 0 || day === 6;
  const etTime = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")} ET`;
  const base = { etTime, sydneyNow: formatSydneyNow(), openingWindowEt: "9:45 AM to 10:30 AM ET", marketHoursEt: "9:30 AM to 4:00 PM ET" };
  if (isWeekend) return { ...base, session: "WEEKEND", isMarketOpen: false, isOpeningWindow: false, autoPaperAllowed: false, reason: "US markets are closed on weekends.", nextEvent: "Next regular open is Monday 9:30 AM ET." };
  if (totalMins < PRE_MARKET_START) return { ...base, session: "OVERNIGHT", isMarketOpen: false, isOpeningWindow: false, autoPaperAllowed: false, reason: "Overnight. US pre-market begins at 4:00 AM ET.", nextEvent: "Opening window begins at 9:45 AM ET." };
  if (totalMins >= PRE_MARKET_START && totalMins < MARKET_OPEN) return { ...base, session: "PRE_MARKET", isMarketOpen: false, isOpeningWindow: false, autoPaperAllowed: false, reason: "Pre-market. Auto-paper waits until 9:45 AM ET to avoid the first 15 minutes of volatility.", nextEvent: "Opening window begins at 9:45 AM ET." };
  if (totalMins >= MARKET_OPEN && totalMins < OPEN_WINDOW_START) return { ...base, session: "MARKET_OPEN_INITIAL_VOLATILITY", isMarketOpen: true, isOpeningWindow: false, autoPaperAllowed: false, reason: "Market is open, but auto-paper waits until 9:45 AM ET to skip the first 15 minutes.", nextEvent: "Opening window begins at 9:45 AM ET." };
  if (totalMins >= OPEN_WINDOW_START && totalMins < OPEN_WINDOW_END) return { ...base, session: "OPENING_WINDOW", isMarketOpen: true, isOpeningWindow: true, autoPaperAllowed: true, reason: "Opening window active: 9:45 AM to 10:30 AM ET. Auto-paper entries allowed.", nextEvent: "Opening window closes at 10:30 AM ET." };
  if (totalMins >= OPEN_WINDOW_END && totalMins < CLOSE_BUFFER) return { ...base, session: "MARKET_OPEN", isMarketOpen: true, isOpeningWindow: false, autoPaperAllowed: false, reason: "Market open, but entry window has passed. Existing paper positions are still monitored.", nextEvent: "No new auto-paper entries until the next opening window." };
  if (totalMins >= CLOSE_BUFFER && totalMins < MARKET_CLOSE) return { ...base, session: "MARKET_CLOSE_BUFFER", isMarketOpen: true, isOpeningWindow: false, autoPaperAllowed: false, reason: "Last 15 minutes before close. No new entries.", nextEvent: "Market closes at 4:00 PM ET." };
  if (totalMins >= MARKET_CLOSE && totalMins < AFTER_HOURS_END) return { ...base, session: "AFTER_HOURS", isMarketOpen: false, isOpeningWindow: false, autoPaperAllowed: false, reason: "After-hours session. Auto-paper entries are off.", nextEvent: "Next opening window begins at 9:45 AM ET." };
  return { ...base, session: "OVERNIGHT", isMarketOpen: false, isOpeningWindow: false, autoPaperAllowed: false, reason: "Overnight. Waiting for next US market session.", nextEvent: "Next opening window begins at 9:45 AM ET." };
}

function isEntryStillValid(signal) {
  if (!signal || !signal.price || !signal.entry) return false;
  const price = Number(signal.price);
  const entry = Number(signal.entry);
  const stop = Number(signal.stop);
  const buyHigh = Number(signal.buyHigh || entry * 1.006);
  if (!Number.isFinite(price) || !Number.isFinite(entry)) return false;
  if (price > buyHigh * 1.02) return false;
  if (Number.isFinite(stop) && price <= stop * 1.01) return false;
  return true;
}

function getETTime() {
  const { h, m, s } = getETComponents();
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")} ET`;
}

module.exports = { getMarketSession, isEntryStillValid, getETTime };
