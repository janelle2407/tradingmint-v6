function applyCosts(price,side,settings){const slippage=Number(settings.slippagePct||0)/100,spread=Number(settings.spreadPct||0)/100;if(side==="buy")return price*(1+slippage+spread/2);if(side==="sell")return price*(1-slippage-spread/2);return price;}
function accountEquity(account){return account.cash+account.open.reduce((s,p)=>s+Number(p.lastPrice||p.avgEntry||p.entry)*Number(p.shares),0);}
function dailyPnl(account){const today=new Date().toISOString().slice(0,10);return account.closed.filter(p=>String(p.exitTime||"").startsWith(today)).reduce((s,p)=>s+Number(p.pnl||0),0);}
function riskLockout(account,settings,stats={}){const starting=Number(settings.startingCash||5000),dailyLoss=dailyPnl(account),dailyLossPct=starting?Math.abs(Math.min(0,dailyLoss))/starting*100:0;if(dailyLossPct>=Number(settings.maxDailyLossPct||3))return{locked:true,reason:`Daily loss lockout hit: ${dailyLossPct.toFixed(2)}%.`};if(Number(stats.maxDrawdown||0)>=Number(settings.maxDrawdownPct||10))return{locked:true,reason:`Max drawdown lockout hit: ${stats.maxDrawdown}%.`};return{locked:false,reason:""};}
function positionSize(account,signal,settings){
  const equity = accountEquity(account);
  const entryCost = applyCosts(signal.entry, "buy", settings);
  const stopDist = Math.max(0.01, signal.entry - signal.stop);

  // ATR-based sizing: risk a fixed percent of equity, then throttle by market regime.
  // Example defaults: BULLISH 100%, NEUTRAL 50%, BEARISH 0%.
  const riskPct = Number(settings.riskPerTradePct || 1) / 100;
  const multipliers = settings.regimeRiskMultipliers || {};
  const regime = String(signal.marketRegime || signal.market || "BULLISH").toUpperCase();
  const riskMultiplier = Number.isFinite(Number(multipliers[regime])) ? Number(multipliers[regime]) : 1;
  const riskDollars = equity * riskPct * Math.max(0, riskMultiplier);
  const atrShares = Math.floor(riskDollars / stopDist);

  // Also cap by max trade % of account
  const maxTradeValue = equity * (Number(settings.maxTradePct || 10) / 100);
  const maxShares = Math.floor(maxTradeValue / entryCost);

  // Use smaller of ATR-based and max-trade-based sizing
  let shares = Math.min(atrShares, maxShares);

  // Safety net: if sizing produced 0 but equity covers at least 1 share,
  // allow 1 share. This handles high-priced stocks (e.g. $500+ with a $5k
  // account where maxTradePct cap < share price).
  // Only applies when regime multiplier > 0 — BEARISH multiplier of 0 must
  // still produce 0 shares (canEnter uses this to block BEARISH entries).
  if (shares <= 0 && equity >= entryCost && riskMultiplier > 0) shares = 1;

  return Math.max(0, shares);
}
function canEnter(account, signal, settings, stats={}) {
  const reasons = [];
  const lockout = riskLockout(account, settings, stats);
  if (lockout.locked) reasons.push(lockout.reason);
  if (!signal) reasons.push("No signal.");
  if (signal && signal.safety !== "TRADE_READY") reasons.push("Signal is not TRADE_READY.");
  if (signal && Number(signal.confidence) < Number(settings.minConfidence)) reasons.push("Confidence below minimum.");
  if (signal && Number(signal.rrNumber) < Number(settings.minRiskReward)) reasons.push("Risk/reward below minimum.");
  if (signal) {
    const multipliers = settings.regimeRiskMultipliers || {};
    const regime = String(signal.marketRegime || signal.market || "BULLISH").toUpperCase();
    const riskMultiplier = Number.isFinite(Number(multipliers[regime])) ? Number(multipliers[regime]) : 1;
    if (riskMultiplier <= 0) reasons.push(`Market regime ${regime} blocks new long entries.`);
  }
  if (signal && settings.requireHistoricalEdge && (!signal.historicalStats || Number(signal.historicalStats.trades||0) < Number(settings.minHistoricalTrades))) reasons.push("Historical sample too small.");
  if (account.open.length >= Number(settings.maxOpenPositions)) reasons.push("Max open positions reached.");
  if (signal && account.open.some(pos => pos.symbol === signal.symbol)) reasons.push("Position already open for symbol.");

  // Max daily entries
  const today = new Date().toISOString().slice(0, 10);
  const entriesToday = account.open.filter(p => String(p.entryTime||"").startsWith(today)).length
    + account.closed.filter(p => String(p.entryTime||"").startsWith(today)).length;
  if (entriesToday >= Number(settings.maxDailyEntries)) reasons.push("Max daily entries reached.");

  // Min share price ($10+) — professional standard
  if (signal && Number(signal.price) < 10) reasons.push("Price below $10 — penny stock territory.");

  // Max risk per trade — hard enforce 2% of account
  if (signal) {
    const equity = accountEquity(account);
    const stopDist = Math.max(0.01, signal.entry - signal.stop);
    const shares = positionSize(account, signal, settings);
    const dollarRisk = shares * stopDist;
    const riskPct = equity > 0 ? (dollarRisk / equity) * 100 : 0;
    if (riskPct > 2.5) reasons.push(`Trade risks ${riskPct.toFixed(1)}% of account — max allowed is 2.5%. Position too large.`);
    if (shares <= 0) reasons.push("Not enough cash for position size.");
  }

  // Correlation check — don't hold two highly correlated stocks
  if (signal && account.open.length > 0 && settings.maxCorrelation) {
    const sameEtf = account.open.filter(p => p.sectorEtf && p.sectorEtf === signal.sectorEtf);
    if (sameEtf.length >= Number(settings.maxSameSectorOpen || 2)) {
      reasons.push(`Already have ${sameEtf.length} positions in ${signal.sectorEtf} sector — max allowed is ${settings.maxSameSectorOpen}.`);
    }
  }

  const shares = signal ? positionSize(account, signal, settings) : 0;
  return { ok: reasons.length === 0, reasons, shares, lockout };
}
module.exports={applyCosts,positionSize,canEnter,accountEquity,dailyPnl,riskLockout};