const { runPortfolioBacktest, summarizeTrades } = require("./backtest");

function splitPeriods(bars, trainBars = 504, testBars = 252, stepBars = 126) {
  const periods = [];
  if (!Array.isArray(bars) || bars.length < trainBars + testBars + 80) return periods;
  for (let start = 0; start + trainBars + testBars <= bars.length; start += stepBars) {
    periods.push({ trainStart: start, trainEnd: start + trainBars, testStart: start + trainBars, testEnd: start + trainBars + testBars });
  }
  return periods;
}

function runWalkForward(barsBySymbol, options = {}) {
  const symbols = Object.keys(barsBySymbol || {}).filter(s => !["SPY", "QQQ", "DIA", "IWM", "VIX", "^VIX"].includes(s));
  const allTrades = [];
  const folds = [];
  const reference = barsBySymbol.SPY || barsBySymbol[symbols[0]] || [];
  const trainBars = Number(options.trainBars || 504);
  const testBars = Number(options.testBars || 252);
  const stepBars = Number(options.stepBars || 126);
  const warmupBars = Number(options.walkForwardWarmupBars || 252);
  const periods = splitPeriods(reference, trainBars, testBars, stepBars);

  for (const period of periods) {
    const trainSet = {};
    const testSet = {};
    const allSymbols = new Set([...symbols, "SPY", "QQQ", "DIA", "IWM", "VIX", "^VIX"]);

    for (const symbol of allSymbols) {
      const bars = barsBySymbol[symbol] || [];
      if (bars.length >= period.testEnd) {
        trainSet[symbol] = bars.slice(period.trainStart, period.trainEnd);
        const warmupStart = Math.max(period.trainStart, period.testStart - warmupBars);
        testSet[symbol] = bars.slice(warmupStart, period.testEnd);
      }
    }

    const testStartDate = reference[period.testStart]?.date;
    const testEndDate = reference[period.testEnd - 1]?.date;

    const trainResult = runPortfolioBacktest(trainSet, { ...options, lookback: "walk-forward train" });
    const testResult = runPortfolioBacktest(testSet, { ...options, lookback: "walk-forward test", countTradesFromDate: testStartDate, countTradesToDate: testEndDate });
    const foldPassed = Boolean((testResult.summary.trades || 0) >= Number(options.minFoldTrades || 5) && (testResult.summary.expectancyR || 0) > 0 && (testResult.summary.profitFactor || 0) >= 1.1);

    folds.push({
      trainWindow: { start: reference[period.trainStart]?.date, end: reference[period.trainEnd - 1]?.date },
      testWindow: { start: testStartDate, end: testEndDate },
      trainSummary: trainResult.summary,
      testSummary: testResult.summary,
      passed: foldPassed
    });

    allTrades.push(...testResult.trades);
  }

  const summary = summarizeTrades(allTrades);
  const positiveFolds = folds.filter(f => f.passed).length;
  const foldPassRate = folds.length ? positiveFolds / folds.length : 0;
  const passed = (summary.trades || 0) >= Number(options.minWalkForwardTrades || 30) && (summary.expectancyR || 0) > Number(options.minHistoricalExpectancyR || 0.1) && (summary.profitFactor || 0) >= Number(options.minHistoricalProfitFactor || 1.15) && foldPassRate >= Number(options.minWalkForwardFoldPassRate || 0.6);

  return {
    createdAt: new Date().toISOString(),
    method: "walk-forward with warm-up context",
    trainBars,
    testBars,
    stepBars,
    warmupBars,
    folds,
    positiveFolds,
    foldPassRate: Number((foldPassRate * 100).toFixed(1)),
    summary,
    passed,
    guardrail: passed ? "Walk-forward test passed on unseen windows with warm-up context." : "Walk-forward failed or did not pass enough folds.",
    trades: allTrades.slice(-1000)
  };
}

module.exports = { splitPeriods, runWalkForward };
