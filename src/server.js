const express = require("express");
const path = require("path");

const { scanMarket } = require("./engines/scanner");
const { runPortfolioBacktest } = require("./engines/backtest");
const { getCorrelationMatrix } = require("./engines/correlation");
const { checkRisk } = require("./engines/risk");

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   MIDDLEWARE
========================= */

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "../public")));

/* =========================
   ROUTES
========================= */

// Root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/* =========================
   SCAN (FIXED ASYNC)
========================= */

app.post("/scan", async (req, res) => {
  try {
    const { symbols = [] } = req.body;

    if (!symbols.length) {
      return res.status(400).json({ error: "No symbols provided" });
    }

    const result = await scanMarket({ symbols });

    res.json(result);
  } catch (err) {
    console.error("SCAN ERROR:", err);
    res.status(500).json({ error: "Scan failed" });
  }
});

/* =========================
   BACKTEST
========================= */

app.post("/backtest", async (req, res) => {
  try {
    const result = runPortfolioBacktest(req.body);
    res.json(result);
  } catch (err) {
    console.error("BACKTEST ERROR:", err);
    res.status(500).json({ error: "Backtest failed" });
  }
});

/* =========================
   CORRELATION
========================= */

app.post("/correlation", async (req, res) => {
  try {
    const result = await getCorrelationMatrix(req.body);
    res.json(result);
  } catch (err) {
    console.error("CORRELATION ERROR:", err);
    res.status(500).json({ error: "Correlation failed" });
  }
});

/* =========================
   RISK CHECK
========================= */

app.post("/risk", (req, res) => {
  try {
    const { symbol, config } = req.body;
    const result = checkRisk(symbol, config);
    res.json(result);
  } catch (err) {
    console.error("RISK ERROR:", err);
    res.status(500).json({ error: "Risk check failed" });
  }
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

