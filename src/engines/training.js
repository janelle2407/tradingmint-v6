function trainingDecision(db, walkForwardResult, latestBacktest) {
  const decision = {
    createdAt: new Date().toISOString(),
    canAutoApply: false,
    reason: "",
    suggestedSettings: {},
    evidence: {
      walkForward: walkForwardResult?.summary || null,
      backtest: latestBacktest?.summary || null
    }
  };

  const wf = walkForwardResult?.summary || {};
  const bt = latestBacktest?.summary || {};

  const wfGood = (wf.trades || 0) >= 20 && (wf.expectancyR || 0) > 0 && (wf.profitFactor || 0) >= 1.15;
  const btGood = (bt.trades || 0) >= 30 && (bt.expectancyR || 0) > 0 && (bt.profitFactor || 0) >= 1.15;

  if (!wfGood) {
    decision.reason = "Walk-forward proof is not strong enough to auto-apply.";
    return decision;
  }

  if (!btGood) {
    decision.reason = "Backtest proof is not strong enough to auto-apply.";
    return decision;
  }

  decision.canAutoApply = true;
  decision.reason = "Backtest and walk-forward evidence are positive. Conservative settings can be tightened gradually.";
  decision.suggestedSettings = {
    minConfidence: Math.max(Number(db.settings.minConfidence || 82), 82),
    minHistoricalTrades: Math.max(Number(db.settings.minHistoricalTrades || 12), 12),
    minHistoricalProfitFactor: Math.max(Number(db.settings.minHistoricalProfitFactor || 1.2), 1.2),
    minHistoricalExpectancyR: Math.max(Number(db.settings.minHistoricalExpectancyR || 0.15), 0.15)
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

module.exports = { trainingDecision, applyTrainingDecision };
