const assert = require("assert");
const { buildSignal, calcFibLevels, scanMarket, adx, trendTemplate } = require("../src/engines/scanner");
const { applyTradeFilters } = require("../src/engines/filters");
const { enterPaper, updateOpenPositions } = require("../src/engines/paper");
const { simulatePortfolioTrades } = require("../src/engines/backtest");

function makeTrendBars(count = 260, start = 50, drift = 0.18) {
  const bars = [];
  let close = start;
  const startDate = new Date("2023-01-02T00:00:00Z");
  for (let i = 0; i < count; i++) {
    close += drift + Math.sin(i / 9) * 0.05;
    const open = close - 0.12;
    const high = close + 0.5;
    const low = close - 0.55;
    const volume = 1_000_000 + i * 1500 + (i % 11 === 0 ? 250_000 : 0);
    const d = new Date(startDate.getTime() + i * 86400000);
    bars.push({ date: d.toISOString().slice(0, 10), open, high, low, close, volume });
  }
  return bars;
}

function testBuildSignalDoesNotCrash() {
  const bars = makeTrendBars();
  const spy = makeTrendBars(260, 400, 0.08);
  const signal = buildSignal(
    "TEST",
    bars,
    0,
    "BULLISH",
    { minConfidence: 1, minRiskReward: 1, requireHistoricalEdge: false, technicalWeight: 1, edgeWeight: 0 },
    {},
    { SPY: spy, TEST: bars },
    {},
    {},
    {}
  );
  assert.strictEqual(signal.symbol, "TEST");
  assert.ok(Object.prototype.hasOwnProperty.call(signal, "pocketPivot"));
}

function testGoldenPocketCanTrigger() {
  const bars = [];
  for (let i = 0; i < 50; i++) {
    bars.push({ date: `2024-01-${String((i % 28) + 1).padStart(2, "0")}`, open: 70, high: 71, low: 69, close: 70, volume: 1000 });
  }
  bars[0].high = 100;
  bars[1].low = 50;
  bars[49].close = 70;
  const fib = calcFibLevels(bars, 50);
  assert.strictEqual(fib.inGoldenPocket, true, JSON.stringify(fib));
  assert.ok(fib.goldenPocketLow <= fib.goldenPocketHigh);
}

function testUnknownEarningsBlocksWhenSafeModeOn() {
  const signal = { symbol: "TEST", safety: "TRADE_READY", action: "LONG" };
  const filtered = applyTradeFilters(signal, { blockUnknownEarnings: true, earningsBlockDays: 5 }, {});
  assert.strictEqual(filtered.filterBlocked, true);
  assert.strictEqual(filtered.action, "IGNORE");
}

function testPyramidAverageEntryUsesCumulativeCost() {
  const db = {
    settings: {
      startingCash: 5000,
      minConfidence: 1,
      minRiskReward: 1,
      requireHistoricalEdge: false,
      maxOpenPositions: 10,
      maxDailyEntries: 10,
      maxTradePct: 10,
      riskPerTradePct: 1,
      slippagePct: 0,
      spreadPct: 0,
      commissionPerTrade: 0,
      maxSameSectorOpen: 10,
      maxCorrelation: 0.99
    },
    paper: { cash: 5000, open: [], closed: [] },
    alerts: [],
    journal: []
  };
  const signal = {
    symbol: "TEST",
    setup: "Pullback",
    action: "LONG",
    safety: "TRADE_READY",
    confidence: 90,
    rrNumber: 2,
    entry: 100,
    rawEntry: 100,
    stop: 95,
    target1: 110,
    target2: 115,
    trailingStop: 96,
    trailingAtr: 2,
    price: 100,
    vwap: 100,
    ema20: 100,
    sectorEtf: "SPY",
    reasons: [],
    warnings: []
  };
  const entered = enterPaper(db, signal, "test", { TEST: makeTrendBars(), SPY: makeTrendBars() });
  assert.strictEqual(entered.ok, true, JSON.stringify(entered));
  updateOpenPositions(db, [{ ...signal, price: 100, safety: "TRADE_READY" }]);
  updateOpenPositions(db, [{ ...signal, price: 103, safety: "TRADE_READY" }]);
  const pos = db.paper.open[0];
  assert.ok(pos.shares >= 4, JSON.stringify(pos));
  assert.ok(pos.avgEntry > 100 && pos.avgEntry < 103.1, JSON.stringify(pos));
  assert.ok(Number.isFinite(pos.totalCost));
}


function testScanMarketReturnsRankedSignals() {
  const testBars = makeTrendBars(280, 50, 0.2);
  const spyBars = makeTrendBars(280, 400, 0.1);
  const qqqBars = makeTrendBars(280, 300, 0.12);
  const result = scanMarket(
    { SPY: spyBars, QQQ: qqqBars, TEST: testBars },
    { minConfidence: 1, minRiskReward: 1, requireHistoricalEdge: false, technicalWeight: 1, edgeWeight: 0 },
    {}, {}, {}, {}, {}
  );
  assert.ok(result.market && result.market.regime);
  assert.ok(result.signals.some(s => s.symbol === "TEST"));
  assert.ok(result.signals.every((s, i) => s.rank === i + 1));
}

function testAdxAndTrendTemplateProduceValues() {
  const bars = makeTrendBars(260, 40, 0.25);
  assert.ok(Number.isFinite(adx(bars, 14)));
  const tpl = trendTemplate(bars);
  assert.ok(tpl.total >= 9, JSON.stringify(tpl));
  assert.ok(Array.isArray(tpl.checks));
}

function testPortfolioSimulationLimitsOverlap() {
  const trades = [
    { symbol: "AAPL", entryDate: "2024-01-02", exitDate: "2024-01-10", confidence: 90, pnlR: 1 },
    { symbol: "MSFT", entryDate: "2024-01-02", exitDate: "2024-01-11", confidence: 89, pnlR: 1 },
    { symbol: "NVDA", entryDate: "2024-01-03", exitDate: "2024-01-12", confidence: 88, pnlR: 1 }
  ];
  const result = simulatePortfolioTrades(trades, { maxOpenPositions: 2, maxDailyEntries: 2, maxSameSectorOpen: 5 });
  assert.strictEqual(result.trades.length, 2);
  assert.strictEqual(result.rejected.length, 1);
}

const tests = [
  testBuildSignalDoesNotCrash,
  testGoldenPocketCanTrigger,
  testUnknownEarningsBlocksWhenSafeModeOn,
  testPyramidAverageEntryUsesCumulativeCost,
  testScanMarketReturnsRankedSignals,
  testAdxAndTrendTemplateProduceValues,
  testPortfolioSimulationLimitsOverlap
];

for (const test of tests) {
  test();
  console.log(`✓ ${test.name}`);
}
console.log(`\n${tests.length} tests passed.`);
