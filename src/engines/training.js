function foldPassRate(walkForwardResult) {
  const folds = walkForwardResult?.folds || [];
  if (!folds.length) return 0;
  const passed = folds.filter(f => {
    const s = f.testSummary || {};
    return Number(s.trades || 0) >= 5 && Number(s.expectancyR || 0) > 0 && Number(s.profitFactor || 0) >= 1.1;
  }).length;
  return passed / folds.length;
}

function trainingDecision(db, walkForwardResult, latestBacktest) {
  const decision = {
    createdAt: new Date().toISOString(),
    canAutoApply: false,
    reason: "",
    suggestedSettings: {},
    evidence: { walkForward: walkForwardResult?.summary || null, backtest: latestBacktest?.summary || null, foldPassRate: foldPassRate(walkForwardResult) }
  };
  const wf = walkForwardResult?.summary || {};
  const bt = latestBacktest?.summary || {};
  const passRate = decision.evidence.foldPassRate;
  const wfGood = Number(wf.trades || 0) >= Number(db.settings.minTrainingWalkForwardTrades || 60) && Number(wf.expectancyR || 0) >= Number(db.settings.minTrainingExpectancyR || 0.15) && Number(wf.profitFactor || 0) >= Number(db.settings.minTrainingProfitFactor || 1.25) && Number(wf.maxDrawdownR || 999) <= Number(db.settings.maxTrainingDrawdownR || 10) && passRate >= Number(db.settings.minTrainingFoldPassRate || 0.6);
  const btGood = Number(bt.trades || 0) >= Number(db.settings.minTrainingBacktestTrades || 100) && Number(bt.expectancyR || 0) >= Number(db.settings.minTrainingExpectancyR || 0.15) && Number(bt.profitFactor || 0) >= Number(db.settings.minTrainingProfitFactor || 1.25) && Number(bt.maxDrawdownR || 999) <= Number(db.settings.maxTrainingDrawdownR || 10);
  if (!wfGood) { decision.reason = "Walk-forward proof is not strong enough. Need more trades, stronger expectancy/profit factor, lower drawdown, and positive results across more folds."; return decision; }
  if (!btGood) { decision.reason = "Backtest proof is not strong enough. Need at least 100 trades, expectancy >= 0.15R, profit factor >= 1.25, and controlled drawdown."; return decision; }
  decision.canAutoApply = Boolean(db.settings.trainingAutoApply);
  decision.reason = decision.canAutoApply ? "Backtest and walk-forward evidence are strong enough for conservative auto-apply." : "Evidence is strong, but auto-apply is disabled. Review manually before applying.";
  decision.suggestedSettings = {
    minConfidence: Math.max(Number(db.settings.minConfidence || 82), 82),
    minHistoricalTrades: Math.max(Number(db.settings.minHistoricalTrades || 30), 30),
    minHistoricalProfitFactor: Math.max(Number(db.settings.minHistoricalProfitFactor || 1.25), 1.25),
    minHistoricalExpectancyR: Math.max(Number(db.settings.minHistoricalExpectancyR || 0.15), 0.15),
    maxDrawdownPct: Math.min(Number(db.settings.maxDrawdownPct || 10), 10),
    riskPerTradePct: Math.min(Number(db.settings.riskPerTradePct || 1), 1)
  };
  return decision;
}

function applyTrainingDecision(db, decision) {
  if (!decision || !decision.canAutoApply) return false;
  db.settings = { ...db.settings, ...decision.suggestedSettings, autoPaper: true, startingCash: 5000 };
  db.trainingDecisions ||= [];
  db.trainingDecisions.unshift(decision);
  db.trainingDecisions = db.trainingDecisions.slice(0, 100);
  return true;
}

module.exports = { trainingDecision, applyTrainingDecision, foldPassRate };
