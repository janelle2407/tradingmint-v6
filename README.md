# TradingMint PRO v7.4.0

## What's New in v6.0

### Trading Accuracy Improvements
- **MACD added** — measures momentum crossovers, adds to signal scoring
- **ADX added** — measures trend strength (ADX > 25 = real trend, not chop)
- **Bollinger Bands added** — squeeze breakout setup + overextension detection
- **Tighter stops** — now uses `ATR × 1.2` instead of `low20 × 0.985`, closer to entry, better R:R
- **Higher volume threshold** — raised from 1.15× to 1.3× average for breakout confirmation
- **2 new setups** — "Momentum" (MACD + ADX + trend aligned) and "EMA Bounce" (pullback to EMA20)
- **Improved R:R** — targets now use 2.0R and 3.0R (was 1.8R and 2.6R)
- **Dynamic sector leader** — no longer hardcoded to "TECHNOLOGY", calculated from live data
- **Longer correlation lookback** — 120 bars (was 60) for more accurate correlation detection
- **Longer walk-forward test window** — 252 bars (~1 year) per fold (was 126)

### UI Improvements
- Complete visual redesign — clean dark theme with sky blue + emerald accent
- **No more raw JSON** — all pages now show proper formatted cards and tables
- **Plain English everywhere** — every metric has a description a beginner can understand
- Color-coded score bars instead of raw numbers
- Visual entry/stop/target boxes on every trade detail
- MACD, ADX, Bollinger Band status shown per signal
- Historical edge stats shown in a clear 4-column grid
- Walk-forward fold results in a proper table with pass/fail per fold
- Report breakdowns in formatted tables
- Equity curve with fill gradient
- Toast notifications for all actions
- Ticker bar at the bottom with live prices

## Architecture

```
src/
  data/marketData.js       — Yahoo Finance fetcher with range fallbacks
  data/sectorMap.js        — Sector classification for 70+ symbols
  engines/scanner.js       — NEW: MACD, ADX, Bollinger Bands, 5 setups
  engines/backtest.js      — NEW: tighter stops, 2.0R targets
  engines/walkForward.js   — NEW: 252-bar test windows
  engines/correlation.js   — NEW: 120-bar lookback
  engines/paper.js         — Paper trading engine
  engines/risk.js          — Risk/lockout checks
  engines/filters.js       — Earnings/news filters
  engines/training.js      — Self-training review
  engines/reports.js       — Report generation
  engines/replay.js        — Trade replay
  storage/db.js            — JSON database
  storage/sqliteAdapter.js — SQLite optional adapter
  broker/adapter.js        — Broker stub (paper only)
  server.js               — Express API server
public/
  index.html              — Full rebuilt frontend (single file)
```

## Deploy on Render

Build Command: `npm install`
Start Command: `npm start`

## Paper Account

- Starts at $5,000 (fixed)
- Auto paper trading is always ON
- Live broker trading is permanently disabled
- Reset any time from the Settings page
