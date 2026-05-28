# TradingMint PRO v6.6 deploy notes

This package is paper-trading only. Live broker execution remains disabled.

## What changed

- Fixed `paper.js` runtime bug by importing `round`.
- Added VCP/base quality scoring in `src/engines/baseQuality.js`.
- Added Weinstein-style stage analysis in `src/engines/stageAnalysis.js`.
- Added optional CAN SLIM-style fundamentals feed in `src/data/fundamentals.js`.
- Added optional earnings/news/catalyst feed in `src/data/catalysts.js`.
- Upgraded `scanner.js` to use base quality, stage analysis, fundamentals/catalysts, full Wilder ADX, RS percentile grading, and stock-only signals.
- Excluded SPY/QQQ from stock trade candidates while still using them for market regime.
- Replaced `backtest.js` with historical market-regime replay and stricter optimizer guardrails.
- Updated `walkForward.js` with warm-up context and fold pass-rate guardrails.
- Updated `filters.js` to use the catalyst/earnings feed when available.
- Fixed market-hours text and Sydney-time consistency in `marketHours.js`.
- Added live quote cooldown recovery in `liveQuotes.js`.
- Strengthened self-training guardrails in `training.js`.
- Added report breakdowns by grade, regime, RS bucket, volume bucket, base quality, and source.
- Added `tests/runTests.js` smoke tests.

## Optional data files

The app includes empty placeholder files:

- `data/fundamentals.json`
- `data/catalysts.json`

Populate these later if you connect a real fundamentals/news/earnings provider.

## Deploy steps

```bash
npm install
npm test
npm start
```

For Render:

- Build command: `npm install`
- Start command: `npm start`

