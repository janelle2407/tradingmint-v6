# TradingMint PRO v7.4

Paper-only US stock swing-trading scanner with technical scoring, historical edge checks, walk-forward validation, paper trading, risk limits, and deployment hardening.

## What changed in v7.4

### Runtime and scanner fixes
- Fixed the `pocketPivot` runtime crash by detecting pocket pivots before setup classification.
- Fixed Fibonacci golden-pocket logic so the 50%-61.8% zone can actually trigger.
- Replaced the ADX shortcut with Wilder-smoothed ADX.
- Clarified the daily volume-weighted price anchor so it is not confused with true intraday VWAP.
- Kept completed daily bars separate from live prices so indicators are not distorted by partial intraday bars.
- Added intraday RVOL support when the market is open, using real time-of-day volume instead of inflating completed daily bars.

### Swing-trader methodology upgrades
- Expanded the default universe with extra growth leaders and industry/group ETFs.
- Added closer industry ETF proxies such as SMH/SOXX for semiconductors, IGV for software, CIBR/IHAK for cybersecurity, XBI/IBB for biotech, KRE/KBE for banks, and XRT for retail.
- Strengthened Minervini-style trend-template checks with 50-day MA alignment.
- Safer default earnings handling: unknown earnings dates are blocked by default and the earnings block window is 5 days.

### Fundamentals and catalysts
- EPS and revenue growth now use true year-over-year quarter comparisons instead of quarter-over-quarter comparisons.
- Fundamentals remain optional and degrade safely if Yahoo data is unavailable.
- News/catalyst filter still reports inactive unless you connect a live news source.

### Backtest and risk improvements
- Backtests now use the live scanner signal engine more closely and apply historical market regime.
- Portfolio simulation now enforces overlapping-position limits, same-sector caps, and daily-entry caps.
- Added a time-stop concept in the historical test path.
- Paper-trading pyramids now maintain cumulative cost basis, correct average entry, and better partial-exit accounting.

### Deployment hardening
- `DB_PATH` and `SQLITE_PATH` support persistent Render disks.
- `render.yaml` includes a persistent disk mounted at `/var/data`.
- Optional `ADMIN_TOKEN` protects write endpoints such as settings, paper entries/exits, reset, backtest, optimizer, and training actions.
- Broker mode remains disabled. This project is paper-only.

## Install and run locally

```bash
npm install
npm test
npm start
```

Open the local URL shown in your terminal, usually:

```text
http://localhost:10000
```

## Environment variables

Copy `.env.example` to `.env` for local use if desired.

```text
PORT=10000
BROKER_MODE=disabled
ADMIN_TOKEN=
DB_PATH=/var/data/tradingmint-db.json
SQLITE_PATH=/var/data/tradingmint.sqlite
UNIVERSE_LIMIT=120
HISTORICAL_RANGE=3y
EXTRA_SYMBOLS=
```

For public deployment, set `ADMIN_TOKEN` in Render. In the browser, store the same token once with:

```js
localStorage.setItem("TRADINGMINT_ADMIN_TOKEN", "your-token")
```

## Deploy on Render

Use the included `render.yaml`, or configure manually:

```text
Build Command: npm install
Start Command: npm start
Persistent disk mount: /var/data
DB_PATH: /var/data/tradingmint-db.json
SQLITE_PATH: /var/data/tradingmint.sqlite
BROKER_MODE: disabled
```

## Project structure

```text
src/
  data/marketData.js       Yahoo Finance daily bars, earnings, fundamentals, intraday RVOL
  data/liveQuotes.js       Live quote overlay, separate from indicator bars
  data/sectorMap.js        Sector and industry ETF mapping
  engines/scanner.js       Main scanner and signal scoring engine
  engines/backtest.js      Scanner-equivalent historical testing and portfolio simulation
  engines/walkForward.js   Walk-forward validation
  engines/paper.js         Paper trading engine with pyramiding and cost-basis tracking
  engines/risk.js          Position sizing and lockouts
  engines/filters.js       Earnings/news filters
  engines/correlation.js   Exposure and correlation checks
  storage/db.js            JSON database with DB_PATH support
  storage/sqliteAdapter.js Optional SQLite event/snapshot adapter
  broker/adapter.js        Broker stub, permanently disabled
public/index.html          Single-file dashboard UI
tests/runTests.js          Runtime regression tests
```

## Safety notes

This is a scanner and paper-trading tool, not financial advice. Live broker execution is intentionally disabled. Always validate any strategy with out-of-sample testing, small position sizes, and a written risk plan before risking real capital.
