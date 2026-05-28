const assert = require("assert");

const scanner = require("../src/engines/scanner");
const backtest = require("../src/engines/backtest");
const walkForward = require("../src/engines/walkForward");
const paper = require("../src/engines/paper");
const filters = require("../src/engines/filters");
const risk = require("../src/engines/risk");
const reports = require("../src/engines/reports");
const training = require("../src/engines/training");
const marketHours = require("../src/engines/marketHours");
const liveQuotes = require("../src/data/liveQuotes");
const fundamentals = require("../src/data/fundamentals");
const catalysts = require("../src/data/catalysts");

assert.equal(typeof scanner.scanMarket, "function");
assert.equal(typeof scanner.adx, "function");
assert.equal(typeof backtest.runPortfolioBacktest, "function");
assert.equal(typeof walkForward.runWalkForward, "function");
assert.equal(typeof paper.enterPaper, "function");
assert.equal(typeof filters.applyTradeFilters, "function");
assert.equal(typeof risk.canEnter, "function");
assert.equal(typeof reports.generateReport, "function");
assert.equal(typeof training.trainingDecision, "function");
assert.equal(typeof marketHours.getMarketSession, "function");
assert.equal(typeof liveQuotes.fetchLiveQuotes, "function");
assert.equal(typeof fundamentals.getFundamentalSnapshot, "function");
assert.equal(typeof catalysts.getCatalystSnapshot, "function");

console.log("All module smoke tests passed.");
