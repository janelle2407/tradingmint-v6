const SECTOR_MAP = {
  SPY: "Market ETF", QQQ: "Market ETF", DIA: "Market ETF", IWM: "Market ETF", VIX: "Volatility",
  XLK: "Technology ETF", XLE: "Energy ETF", XLF: "Financial ETF", XLV: "Health ETF", XLY: "Consumer ETF",
  XLI: "Industrial ETF", XLP: "Staples ETF", XLU: "Utilities ETF", XLB: "Materials ETF", XLRE: "Real Estate ETF",

  NVDA: "Semiconductors", AVGO: "Semiconductors", AMD: "Semiconductors", SMCI: "Semiconductors",
  MU: "Semiconductors", QCOM: "Semiconductors", LRCX: "Semiconductors", KLAC: "Semiconductors",
  AMAT: "Semiconductors", INTC: "Semiconductors", MRVL: "Semiconductors", ARM: "Semiconductors",

  AAPL: "Mega Cap Tech", MSFT: "Mega Cap Tech", META: "Mega Cap Tech", GOOGL: "Mega Cap Tech",
  AMZN: "Mega Cap Tech", NFLX: "Mega Cap Tech", TSLA: "Mega Cap Tech",

  CRWD: "Software", ORCL: "Software", CRM: "Software", ADBE: "Software", PANW: "Cybersecurity",
  NOW: "Software", SNOW: "Software", NET: "Software", DDOG: "Software", ZS: "Cybersecurity",

  SHOP: "Ecommerce", MELI: "Ecommerce", UBER: "Transport", ABNB: "Travel", DASH: "Delivery",
  RBLX: "Gaming", ROKU: "Streaming", SQ: "Fintech", PYPL: "Fintech", SOFI: "Fintech",
  MSTR: "Crypto Proxy", COIN: "Crypto Proxy", HOOD: "Fintech",

  COST: "Retail", WMT: "Retail", HD: "Retail",
  LLY: "Healthcare", JPM: "Banks", BAC: "Banks",
  XOM: "Energy", CVX: "Energy",
  CAT: "Industrials", DE: "Industrials", GE: "Industrials"
};

function sectorOf(symbol) {
  return SECTOR_MAP[String(symbol || "").toUpperCase()] || "Other";
}

// Maps each sector to its tracking ETF for momentum check
const SECTOR_ETF = {
  "Semiconductors":   "XLK",
  "Mega Cap Tech":    "XLK",
  "Software":         "XLK",
  "Cybersecurity":    "XLK",
  "Technology ETF":   "XLK",
  "Banks":            "XLF",
  "Financial ETF":    "XLF",
  "Fintech":          "XLF",
  "Healthcare":       "XLV",
  "Health ETF":       "XLV",
  "Energy":           "XLE",
  "Energy ETF":       "XLE",
  "Industrials":      "XLI",
  "Industrial ETF":   "XLI",
  "Retail":           "XLY",
  "Consumer ETF":     "XLY",
  "Ecommerce":        "XLY",
  "Transport":        "XLY",
  "Travel":           "XLY",
  "Delivery":         "XLY",
  "Streaming":        "XLY",
  "Gaming":           "XLY",
  "Crypto Proxy":     "XLK",
  "Staples ETF":      "XLP",
  "Utilities ETF":    "XLU",
  "Materials ETF":    "XLB",
  "Real Estate ETF":  "XLRE",
  "Market ETF":       "SPY",
  "Other":            "SPY"
};

function sectorEtfOf(symbol) {
  const sector = sectorOf(symbol);
  return SECTOR_ETF[sector] || "SPY";
}

module.exports = { SECTOR_MAP, sectorOf, sectorEtfOf, SECTOR_ETF };
