const fs = require("fs");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../../data/tradingmint-db.json");

const defaultDb = {
  version: "7.4.0",
  createdAt: new Date().toISOString(),
  settings: {
    startingCash: 5000,
    autoPaper: true,
    maxOpenPositions: 4,
    maxDailyEntries: 2,
    maxTradePct: 10,
    riskPerTradePct: 1,
    minConfidence: 78,
    minRiskReward: 2.0,
    minHistoricalTrades: 10,
    minHistoricalExpectancyR: 0.1,
    minHistoricalProfitFactor: 1.1,
    slippagePct: 0.05,
    spreadPct: 0.03,
    commissionPerTrade: 0,
    blockUnknownEarnings: true,
    earningsBlockDays: 5,
    maxDailyLossPct: 2,
    maxDrawdownPct: 10,
    requireHistoricalEdge: true,
    historicalRange: process.env.HISTORICAL_RANGE || "max",
    minHistoricalBars: 840,  // walk-forward needs 504+252+84 = 840 minimum
    minHistoricalYearsPreferred: 5,
    edgeWeight: 0.45,
    technicalWeight: 0.55,
    maxSameSectorOpen: 2,
    maxCorrelation: 0.78,
    autoTraining: true,
    walkForwardAuto: true,
    trainingAutoApply: false,
    brokerMode: "disabled",
    regimeRiskMultipliers: { BULLISH: 1, NEUTRAL: 0.5, BEARISH: 0 }
  },
  paper: { cash: 5000, open: [], closed: [] },
  journal: [], alerts: [], backtests: [], optimizerRuns: [], historicalSnapshots: [],
  historicalBars: {}, historicalMeta: {}, historicalEdges: {}, lockouts: [],
  trainingDecisions: [], reports: [], walkForwardRuns: []
};

function cloneDefaultDb() { return structuredClone(defaultDb); }
function ensureDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify(defaultDb, null, 2));
}
function mergeDefaults(db) {
  const merged = cloneDefaultDb();
  return {
    ...merged,
    ...db,
    version: merged.version,
    settings: {
      ...merged.settings,
      ...(db.settings || {}),
      autoPaper: true,
      startingCash: 5000,
      regimeRiskMultipliers: {
        ...merged.settings.regimeRiskMultipliers,
        ...((db.settings || {}).regimeRiskMultipliers || {})
      }
    },
    paper: { ...merged.paper, ...(db.paper || {}) },
    journal: Array.isArray(db.journal) ? db.journal : [],
    alerts: Array.isArray(db.alerts) ? db.alerts : [],
    backtests: Array.isArray(db.backtests) ? db.backtests : [],
    optimizerRuns: Array.isArray(db.optimizerRuns) ? db.optimizerRuns : [],
    historicalSnapshots: Array.isArray(db.historicalSnapshots) ? db.historicalSnapshots : [],
    historicalBars: db.historicalBars && typeof db.historicalBars === "object" ? db.historicalBars : {},
    historicalMeta: db.historicalMeta && typeof db.historicalMeta === "object" ? db.historicalMeta : {},
    historicalEdges: db.historicalEdges && typeof db.historicalEdges === "object" ? db.historicalEdges : {},
    lockouts: Array.isArray(db.lockouts) ? db.lockouts : [],
    trainingDecisions: Array.isArray(db.trainingDecisions) ? db.trainingDecisions : [],
    reports: Array.isArray(db.reports) ? db.reports : [],
    walkForwardRuns: Array.isArray(db.walkForwardRuns) ? db.walkForwardRuns : []
  };
}
function readDb() {
  ensureDb();
  try { return mergeDefaults(JSON.parse(fs.readFileSync(DB_PATH, "utf8"))); }
  catch (error) {
    const backup = `${DB_PATH}.broken-${Date.now()}`;
    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, backup);
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultDb, null, 2));
    return cloneDefaultDb();
  }
}
function writeDb(db) { ensureDb(); fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); return db; }
function resetDb() { const fresh = cloneDefaultDb(); fresh.createdAt = new Date().toISOString(); writeDb(fresh); return fresh; }
function addAlert(db, type, symbol, message, details = {}) {
  const alert = { id: "ALERT-" + Date.now() + "-" + Math.random().toString(16).slice(2), time: new Date().toISOString(), type, symbol, message, details };
  db.alerts ||= []; db.alerts.unshift(alert); db.alerts = db.alerts.slice(0, 200); return alert;
}
function addJournal(db, eventType, symbol, note, details = {}) {
  const entry = { id: "JRN-" + Date.now() + "-" + Math.random().toString(16).slice(2), time: new Date().toISOString(), eventType, symbol, note, details };
  db.journal ||= []; db.journal.unshift(entry); db.journal = db.journal.slice(0, 1000); return entry;
}
module.exports = { readDb, writeDb, resetDb, addAlert, addJournal, DB_PATH, defaultDb };
