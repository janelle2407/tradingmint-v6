const SECTOR_MAP = {
  SPY: "Market ETF", QQQ: "Market ETF", DIA: "Market ETF", IWM: "Market ETF", VIX: "Volatility", "^VIX": "Volatility",
  XLK: "Technology ETF", XLE: "Energy ETF", XLF: "Financial ETF", XLV: "Health ETF", XLY: "Consumer ETF",
  XLI: "Industrial ETF", XLP: "Staples ETF", XLU: "Utilities ETF", XLB: "Materials ETF", XLRE: "Real Estate ETF",
  SMH: "Semiconductor ETF", SOXX: "Semiconductor ETF", IGV: "Software ETF", SKYY: "Cloud ETF",
  CIBR: "Cybersecurity ETF", IHAK: "Cybersecurity ETF", XBI: "Biotech ETF", IBB: "Biotech ETF",
  KRE: "Regional Bank ETF", KBE: "Bank ETF", XRT: "Retail ETF",

  NVDA: "Semiconductors", AVGO: "Semiconductors", AMD: "Semiconductors", SMCI: "Semiconductors",
  MU: "Semiconductors", QCOM: "Semiconductors", LRCX: "Semiconductors", KLAC: "Semiconductors",
  AMAT: "Semiconductors", INTC: "Semiconductors", MRVL: "Semiconductors", ARM: "Semiconductors",
  TSM: "Semiconductors", ASML: "Semiconductors", ON: "Semiconductors", MCHP: "Semiconductors", TXN: "Semiconductors",

  AAPL: "Mega Cap Tech", MSFT: "Mega Cap Tech", META: "Mega Cap Tech", GOOGL: "Mega Cap Tech",
  AMZN: "Mega Cap Tech", NFLX: "Mega Cap Tech", TSLA: "Mega Cap Tech",

  CRWD: "Software", ORCL: "Software", CRM: "Software", ADBE: "Software", PANW: "Cybersecurity",
  NOW: "Software", SNOW: "Software", NET: "Software", DDOG: "Software", ZS: "Cybersecurity",
  ANET: "Networking", APP: "Software", TTD: "Software", MDB: "Software", TEAM: "Software", OKTA: "Cybersecurity", DUOL: "Software",

  SHOP: "Ecommerce", MELI: "Ecommerce", UBER: "Transport", ABNB: "Travel", DASH: "Delivery",
  RBLX: "Gaming", ROKU: "Streaming", SQ: "Fintech", PYPL: "Fintech", SOFI: "Fintech",
  MSTR: "Crypto Proxy", COIN: "Crypto Proxy", HOOD: "Fintech",

  COST: "Retail", WMT: "Retail", HD: "Retail", CAVA: "Retail", ELF: "Retail", CELH: "Retail", WING: "Retail",
  DASH: "Delivery", SPOT: "Streaming",
  AXON: "Industrials", PWR: "Industrials", FAST: "Industrials", VRT: "Industrials",
  ZS: "Cybersecurity", FTNT: "Cybersecurity",
  QCOM: "Semiconductors", MU: "Semiconductors", ON: "Semiconductors",
  TTD: "Software", OKTA: "Cybersecurity",
  VRTX: "Biotech", REGN: "Biotech", ABBV: "Healthcare",
  SCHW: "Financials", KKR: "Financials",
  DUOL: "Software", HIMS: "Healthcare",
  ASTS: "Industrials", LUNR: "Industrials", RXRX: "Biotech",
  MELI: "Ecommerce",
  LLY: "Healthcare", NVO: "Healthcare", ISRG: "Healthcare", VRTX: "Biotech", REGN: "Biotech",
  JPM: "Banks", BAC: "Banks", SCHW: "Financials", GS: "Financials", MS: "Financials", KKR: "Financials",
  XOM: "Energy", CVX: "Energy", FSLR: "Solar", ENPH: "Solar",
  CAT: "Industrials", DE: "Industrials", GE: "Industrials", VRT: "Industrials", DELL: "Hardware"
};

function sectorOf(symbol) {
  return SECTOR_MAP[String(symbol || "").toUpperCase()] || "Other";
}

const SECTOR_ETF = {
  "Semiconductors": "SMH",
  "Semiconductor ETF": "SMH",
  "Mega Cap Tech": "XLK",
  "Software": "IGV",
  "Software ETF": "IGV",
  "Cloud ETF": "SKYY",
  "Cybersecurity": "CIBR",
  "Cybersecurity ETF": "CIBR",
  "Networking": "IGV",
  "Technology ETF": "XLK",
  "Banks": "KBE",
  "Regional Bank ETF": "KRE",
  "Bank ETF": "KBE",
  "Financial ETF": "XLF",
  "Financials": "XLF",
  // Fintech tracks with growth tech (QQQ), not traditional banks (XLF)
  // SQ, PYPL, SOFI, HOOD move with Nasdaq growth, not financials
  "Fintech": "QQQ",
  "Healthcare": "XLV",
  "Biotech": "XBI",
  "Biotech ETF": "XBI",
  "Health ETF": "XLV",
  "Energy": "XLE",
  "Energy ETF": "XLE",
  "Solar": "XLE",
  "Industrials": "XLI",
  "Industrial ETF": "XLI",
  "Hardware": "XLK",
  "Retail": "XRT",
  "Retail ETF": "XRT",
  "Consumer ETF": "XLY",
  "Ecommerce": "XRT",   // SHOP, MELI track closer to retail than broad consumer
  "Transport": "XLY",
  "Travel": "XLY",
  "Delivery": "XLY",
  "Streaming": "QQQ",   // NFLX, ROKU track with growth tech
  "Gaming": "QQQ",      // RBLX tracks with growth tech, not broad consumer
  // Crypto proxies track with QQQ/Nasdaq growth, not XLK hardware/software
  "Crypto Proxy": "QQQ",
  "Staples ETF": "XLP",
  "Utilities ETF": "XLU",
  "Materials ETF": "XLB",
  "Real Estate ETF": "XLRE",
  "Market ETF": "SPY",
  "Other": "SPY"
};

function sectorEtfOf(symbol) {
  const sector = sectorOf(symbol);
  return SECTOR_ETF[sector] || "SPY";
}

module.exports = { SECTOR_MAP, sectorOf, sectorEtfOf, SECTOR_ETF };
