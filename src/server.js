const express = require("express"); const path = require("path");
const { readDb, writeDb, resetDb, addJournal } = require("./storage/db"); const { DEFAULT_SYMBOLS, fetchUniverse, round, percentMove, fetchEarningsCalendar, fetchFundamentalsForUniverse, fetchIntradayRVOL } = require("./data/marketData"); const { scanMarket } = require("./engines/scanner"); const { applyTradeFilters } = require("./engines/filters"); const { enterPaper, exitPaper, updateOpenPositions, paperStats } = require("./engines/paper"); const { runPortfolioBacktest, optimize } = require("./engines/backtest"); const { brokerStatus, placeOrder } = require("./broker/adapter");
const { runWalkForward } = require("./engines/walkForward");
const { generateReport } = require("./engines/reports");
const { buildReplay } = require("./engines/replay");
const { trainingDecision, applyTrainingDecision } = require("./engines/training");
const { exposureSummary } = require("./engines/correlation");
const { createSqliteAdapter } = require("./storage/sqliteAdapter"); const { riskLockout } = require("./engines/risk");
const { getMarketSession, isEntryStillValid } = require("./engines/marketHours");
const { fetchLiveQuotes, mergeLiveIntoBars, isMarketHours } = require("./data/liveQuotes");
const app=express(); const PORT=process.env.PORT||10000; const VERSION="7.2.0-pyramid-scaling"; app.use(express.json({limit:"1mb"})); app.use(express.static(path.join(__dirname,"../public"))); let lastUniverse=null,lastUniverseTime=0;
async function getUniverse(force=false){
  // Fix 2: Separate completed daily bars from live quotes
  // completedBarsBySymbol = historical EOD bars used for ALL indicator calculations
  // liveQuotes = current price only, used for display + entry zone validity check
  // This prevents partial-day data from distorting MACD, RSI, ADX, ATR etc.

  if(!force&&lastUniverse&&Date.now()-lastUniverseTime<180000){
    if(isMarketHours()){
      try{
        const liveResult=await fetchLiveQuotes(Object.keys(lastUniverse.completedBarsBySymbol||lastUniverse.barsBySymbol));
        if(liveResult.isLive&&liveResult.liveCount>0){
          // Store live quotes SEPARATELY — do NOT mutate barsBySymbol
          lastUniverse={
            ...lastUniverse,
            liveQuotes:liveResult.quotes,
            liveCount:liveResult.liveCount,
            isLive:true,
            liveReason:liveResult.reason
          };
        }
      }catch(e){/* live fetch failed gracefully */}
    }
    return lastUniverse;
  }

  const db=readDb();
  const universe=await fetchUniverse(DEFAULT_SYMBOLS,70,"3y");

  // Store completed bars separately — these never get overwritten by live data
  universe.completedBarsBySymbol = universe.barsBySymbol;

  if(isMarketHours()){
    try{
      const liveResult=await fetchLiveQuotes(Object.keys(universe.barsBySymbol));
      if(liveResult.isLive&&liveResult.liveCount>0){
        // Live quotes stored separately — indicators still use completedBarsBySymbol
        universe.liveQuotes=liveResult.quotes;
        universe.liveCount=liveResult.liveCount;
        universe.isLive=true;
        universe.liveReason=liveResult.reason;
      } else {
        universe.isLive=false; universe.liveCount=0; universe.liveReason=liveResult.reason;
      }
    }catch(e){ universe.isLive=false; universe.liveCount=0; universe.liveReason="Live fetch error"; }
  } else {
    universe.isLive=false; universe.liveCount=0; universe.liveReason="Market closed";
  }

  lastUniverse=universe;lastUniverseTime=Date.now();
  for(const [symbol,bars] of Object.entries(universe.barsBySymbol)){
    db.historicalBars[symbol]={range:"3y",interval:"1d",updatedAt:new Date().toISOString(),bars};
  }
  db.historicalSnapshots.unshift({time:new Date().toISOString(),range:"3y",interval:"1d",symbols:Object.keys(universe.barsBySymbol),errorCount:universe.errors.length});
  db.historicalSnapshots=db.historicalSnapshots.slice(0,500);writeDb(db);return universe;
}
function edgeFreshEnough(db){const updated=Object.values(db.historicalEdges||{}).map(e=>Date.parse(e.updatedAt||0)).filter(Number.isFinite);if(!updated.length)return false;return Date.now()-Math.max(...updated)<6*60*60*1000;}
async function ensureBacktestEdges(db,universe,force=false){if(!force&&edgeFreshEnough(db))return{reused:true,result:null};const result=runPortfolioBacktest(universe.barsBySymbol,db.settings);db.historicalEdges=result.edges||{};db.backtests.unshift(result);db.backtests=db.backtests.slice(0,30);addJournal(db,"AUTO_BACKTEST_MAX_HISTORY","-","Automatic max-history backtest completed and historical edges updated",result.summary);writeDb(db);return{reused:false,result};}
async function buildState(force=false){const db=readDb();db.settings.autoPaper=true;db.settings.startingCash=5000;if(!Number.isFinite(Number(db.paper.cash)))db.paper.cash=5000;const universe=await getUniverse(force);const edgeRun=await ensureBacktestEdges(db,universe,force);// Fix 2b: Use completed daily bars for scanner (accurate indicators)
// Apply live price overlay only for current price display on signals
const barsForScan=universe.completedBarsBySymbol||universe.barsBySymbol;
const [earningsCalendar, fundamentalsData] = await Promise.all([fetchEarningsCalendar(Object.keys(barsForScan)).catch(()=>({})), fetchFundamentalsForUniverse(Object.keys(barsForScan)).catch(()=>({}))]);const scanned=scanMarket(barsForScan,db.settings,db.historicalEdges,universe.liveQuotes||{},earningsCalendar,fundamentalsData);let signals=scanned.signals.map(s=>applyTradeFilters(s,db.settings,earningsCalendar));updateOpenPositions(db,signals);const statsBefore=paperStats(db),lockout=riskLockout(db.paper,db.settings,statsBefore);const marketSession=getMarketSession();if(db.settings.autoPaper&&!lockout.locked&&marketSession.autoPaperAllowed){for(const signal of signals.slice(0,8)){if(signal.safety==="TRADE_READY"&&isEntryStillValid(signal))enterPaper(db,signal,"auto-opening-window",barsForScan);}}else if(db.settings.autoPaper&&!lockout.locked&&!marketSession.autoPaperAllowed){addJournal(db,"AUTO_PAPER_SKIPPED","-","Auto-paper skipped: "+marketSession.reason,{session:marketSession.session,etTime:marketSession.etTime});}const stats=paperStats(db);const indices=["SPY","QQQ","DIA","IWM","VIX"].map(sym=>{const symbol=sym==="VIX"?"^VIX":sym;const bars=universe.barsBySymbol[symbol]||universe.barsBySymbol[sym]||[];const last=bars.at(-1),prev=bars.at(-2);return{symbol:sym,price:round(last?.close),changePct:round(percentMove(last?.close,prev?.close),2),bars:bars.slice(-30)};});if(lockout.locked){db.lockouts.unshift({time:new Date().toISOString(),reason:lockout.reason});db.lockouts=db.lockouts.slice(0,100);}writeDb(db);return{ok:true,version:VERSION,mode:universe.errors.length?"PARTIAL_LIVE_DATA":(universe.isLive?"LIVE_PRICES":"EOD_PRICES"),dataQuality:universe.errors.length?"PARTIAL":(universe.isLive?"LIVE":"END_OF_DAY"),liveCount:universe.liveCount||0,lookback:"max available daily",market:scanned.market,signals,indices,systems:[{name:"3-Year Data Collector",state:universe.errors.length?"PARTIAL":"RUNNING",detail:universe.errors.length?`${universe.errors.length} symbols failed`:"Max-history Yahoo daily chart data with fallback"},{name:"Historical Cache",state:"RUNNING",detail:`${Object.keys(db.historicalBars).length} symbols cached`},{name:"Auto 3-Year Backtest",state:edgeRun.reused?"REUSED":"UPDATED",detail:edgeRun.reused?"Fresh edge data reused":"Historical edges recalculated from max available data"},{name:"Proof-Based Scoring",state:"RUNNING",detail:"Technical score blended with 3-year edge score"},{name:"Risk Lockout",state:lockout.locked?"LOCKED":"CLEAR",detail:lockout.reason||"No risk lockout active"},{name:"Paper Trader",state:db.paper.open.length?"ACTIVE":"READY",detail:`${db.paper.open.length} open, ${db.paper.closed.length} closed`},{name:"Trade Journal",state:"RUNNING",detail:`${db.journal.length} journal records`},{name:"Strategy Optimizer",state:db.optimizerRuns.length?"READY":"WAITING",detail:`${db.optimizerRuns.length} optimizer runs`},{name:"Broker Adapter",state:"DISABLED",detail:"Safe mode only, no live orders"}],paper:db.paper,stats,alerts:db.alerts,journal:db.journal.slice(0,60),backtests:db.backtests.slice(0,5),optimizerRuns:db.optimizerRuns.slice(0,3),broker:brokerStatus(db.settings),settings:db.settings,lockout,historicalEdgeCount:Object.keys(db.historicalEdges||{}).length,historicalSnapshotCount:db.historicalSnapshots.length,errors:universe.errors,updatedAt:new Date().toISOString(),uptimeSeconds:Math.round(process.uptime()),marketSession:getMarketSession()};}
app.get("/api/health",(req,res)=>{const db=readDb();res.json({ok:true,version:VERSION,app:"TradingMint PRO",lookback:"max available daily",historicalEdgeCount:Object.keys(db.historicalEdges||{}).length,broker:brokerStatus(db.settings),uptimeSeconds:Math.round(process.uptime()),time:new Date().toISOString()});});
app.get("/api/state",async(req,res)=>{try{res.json(await buildState(req.query.force==="1"));}catch(error){res.status(500).json({ok:false,error:error.message,time:new Date().toISOString()});}});
app.post("/api/settings",(req,res)=>{const db=readDb();db.settings={...db.settings,...(req.body||{}),autoPaper:true,startingCash:5000};addJournal(db,"SETTINGS_UPDATED","-","Settings updated",db.settings);writeDb(db);res.json({ok:true,settings:db.settings});});
app.post("/api/paper/enter",async(req,res)=>{try{const db=readDb();const universe=await getUniverse(false);const barsForManual=universe.completedBarsBySymbol||universe.barsBySymbol;const state=await buildState(false);const symbol=String(req.body.symbol||"").toUpperCase();const signal=state.signals.find(i=>i.symbol===symbol);const result=enterPaper(db,signal,"manual",barsForManual);writeDb(db);res.json(result);}catch(error){res.status(500).json({ok:false,error:error.message});}});
app.post("/api/paper/enter/override",async(req,res)=>{try{const db=readDb();const universe=await getUniverse(false);const barsForManual=universe.completedBarsBySymbol||universe.barsBySymbol;const state=await buildState(false);const symbol=String(req.body.symbol||"").toUpperCase();let signal=state.signals.find(i=>i.symbol===symbol);if(!signal)return res.status(404).json({ok:false,error:"Symbol not found in scanner."});// Override: force safety to TRADE_READY for manual entry
signal={...signal,safety:"TRADE_READY",action:"LONG"};const result=enterPaper(db,signal,"manual-override",barsForManual);writeDb(db);res.json(result);}catch(error){res.status(500).json({ok:false,error:error.message});}});
app.post("/api/paper/exit",(req,res)=>{const db=readDb();const result=exitPaper(db,req.body.positionId||req.body.symbol,req.body.exitPrice,req.body.reason||"Manual exit");writeDb(db);res.json(result);});
app.get("/api/journal",(req,res)=>{const db=readDb();res.json({ok:true,journal:db.journal});});
app.post("/api/backtest/run",async(req,res)=>{try{const db=readDb();const universe=await getUniverse(req.query.force==="1");const result=runPortfolioBacktest(universe.barsBySymbol,{...db.settings,...(req.body||{})});db.historicalEdges=result.edges||db.historicalEdges;db.backtests.unshift(result);db.backtests=db.backtests.slice(0,30);addJournal(db,"BACKTEST_RUN_3Y","-","max-history backtest completed and historical edges updated",result.summary);writeDb(db);res.json({ok:true,result});}catch(error){res.status(500).json({ok:false,error:error.message});}});
app.post("/api/optimizer/run",async(req,res)=>{try{const db=readDb();const universe=await getUniverse(req.query.force==="1");const result=optimize(universe.barsBySymbol,{...db.settings,...(req.body||{})});db.optimizerRuns.unshift(result);db.optimizerRuns=db.optimizerRuns.slice(0,30);addJournal(db,"OPTIMIZER_RUN","-","Optimizer completed with guardrails",result.best?.summary||{});writeDb(db);res.json({ok:true,result});}catch(error){res.status(500).json({ok:false,error:error.message});}});
app.post("/api/optimizer/apply",(req,res)=>{const db=readDb();const latest=db.optimizerRuns[0];if(!latest||!latest.best||!latest.best.options)return res.status(400).json({ok:false,error:"No optimizer result available to apply."});const summary=latest.best.summary||{};if((summary.trades||0)<25||(summary.expectancyR||0)<=0)return res.status(400).json({ok:false,error:"Optimizer guardrail blocked apply. Sample size or expectancy is not strong enough."});const options=latest.best.options;db.settings.minConfidence=Number(options.minConfidence||db.settings.minConfidence);db.settings.minRiskReward=Number(options.minRiskReward||db.settings.minRiskReward);db.settings.autoPaper=true;db.settings.startingCash=5000;addJournal(db,"OPTIMIZER_APPLIED","-","Optimizer best settings applied to scanner after guardrail check",db.settings);writeDb(db);res.json({ok:true,settings:db.settings,applied:options});});

// v5.3 walk-forward/training/report/replay endpoints
app.post("/api/walkforward/run", async (req, res) => {
  try {
    const db = readDb();
    const universe = await getUniverse(req.query.force === "1");
    const result = runWalkForward(universe.barsBySymbol, { ...db.settings, ...(req.body || {}) });
    db.walkForwardRuns ||= [];
    db.walkForwardRuns.unshift(result);
    db.walkForwardRuns = db.walkForwardRuns.slice(0, 30);
    addJournal(db, "WALK_FORWARD_RUN", "-", "Manual walk-forward validation completed", result.summary);
    writeDb(db);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/training/run", async (req, res) => {
  try {
    const db = readDb();
    const universe = await getUniverse(req.query.force === "1");
    const walkForward = runWalkForward(universe.barsBySymbol, db.settings);
    const latestBacktest = db.backtests?.[0] || runPortfolioBacktest(universe.barsBySymbol, db.settings);
    const decision = trainingDecision(db, walkForward, latestBacktest);
    db.walkForwardRuns ||= [];
    db.trainingDecisions ||= [];
    db.walkForwardRuns.unshift(walkForward);
    db.trainingDecisions.unshift(decision);
    if (req.body?.apply === true && decision.canAutoApply) {
      applyTrainingDecision(db, decision);
      addJournal(db, "TRAINING_APPLIED", "-", "Manual self-training decision applied", decision);
    } else {
      addJournal(db, "TRAINING_REVIEW", "-", decision.reason, decision);
    }
    writeDb(db);
    res.json({ ok: true, walkForward, decision, settings: db.settings });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/report", (req, res) => {
  const db = readDb();
  const report = generateReport(db);
  db.reports ||= [];
  db.reports.unshift(report);
  db.reports = db.reports.slice(0, 100);
  writeDb(db);
  res.json({ ok: true, report });
});

app.get("/api/replay", (req, res) => {
  const db = readDb();
  res.json({ ok: true, symbol: req.query.symbol || null, events: buildReplay(db, req.query.symbol) });
});

app.post("/api/broker/order",(req,res)=>res.status(403).json(placeOrder(req.body))); app.post("/api/reset",(req,res)=>{const db=resetDb();res.json({ok:true,db});}); app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"../public/index.html"))); app.listen(PORT,()=>{
  console.log(`TradingMint PRO ${VERSION} running on port ${PORT}`);

  // Self-wake scheduler — keeps server alive around the opening window
  // Checks every minute if we need to pre-warm or run auto-paper
  setInterval(async () => {
    try {
      const { getMarketSession: _getMs } = require("./engines/marketHours");
      const session = _getMs();
      // Use Intl API for reliable timezone on Linux/Render (avoids toLocaleString bug)
      const _now2 = new Date();
      const _fmt2 = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false });
      const _p2 = _fmt2.formatToParts(_now2);
      const _h2 = parseInt(_p2.find(p => p.type === "hour")?.value || "0") % 24;
      const _m2 = parseInt(_p2.find(p => p.type === "minute")?.value || "0");
      const _wd = _p2.find(p => p.type === "weekday")?.value;
      const mins = _h2 * 60 + _m2;
      const PRE_WARM_START = 9 * 60 + 30; // 9:30 AM ET — pre-warm at market open
      const PRE_WARM_END   = 10 * 60 + 35; // 10:35 AM ET — stop after window closes

      // Only run during the pre-warm + window period on weekdays
      const day = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(_wd);
      if (day === 0 || day === 6) return;
      if (mins < PRE_WARM_START || mins > PRE_WARM_END) return;

      // Pre-warm: fetch universe data so it's ready when window opens
      if (mins >= PRE_WARM_START && mins < 9 * 60 + 45) {
        console.log(`[AUTO-WARM] Pre-warming data at ${session.etTime}`);
        await getUniverse(false); // warm cache without forcing refresh
        return;
      }

      // During opening window: run buildState to enter trades
      if (session.autoPaperAllowed) {
        console.log(`[AUTO-PAPER] Running auto-paper check at ${session.etTime}`);
        await buildState(false);
      }
    } catch(e) {
      console.log(`[AUTO-WARM] Error: ${e.message}`);
    }
  }, 60 * 1000); // every 60 seconds
});
// historicalMeta
