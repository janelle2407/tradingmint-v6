const { fetchHistory } = require("../data/marketData");

/* =========================
   INDICATORS
========================= */

function sma(arr, n) {
  if (!arr || arr.length < n) return null;
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
}

function ema(arr, n) {
  if (!arr || arr.length < n) return null;
  const k = 2 / (n + 1);
  let val = arr[arr.length - n];
  for (let i = arr.length - n + 1; i < arr.length; i++) {
    val = arr[i] * k + val * (1 - k);
  }
  return val;
}

function rsi(values, period = 14) {
  if (!values || values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  if (losses === 0) return 100;

  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function atr(high, low, close, n = 14) {
  if (!close || close.length < n + 1) return null;

  let trs = [];

  for (let i = 1; i < close.length; i++) {
    const tr = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1])
    );
    trs.push(tr);
  }

  return sma(trs, n);
}

function adx(high, low, close, period = 14) {
  if (!high || high.length < period * 2) return null;

  let trs = [];
  let plusDM = [];
  let minusDM = [];

  for (let i = 1; i < high.length; i++) {
    const upMove = high[i] - high[i - 1];
    const downMove = low[i - 1] - low[i];

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const tr = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1])
    );

    trs.push(tr);
  }

  let atrVal = sma(trs.slice(0, period), period);
  let pDM = sma(plusDM.slice(0, period), period);
  let mDM = sma(minusDM.slice(0, period), period);

  let dx = [];

  for (let i = period; i < trs.length; i++) {
    atrVal = (atrVal * (period - 1) + trs[i]) / period;
    pDM = (pDM * (period - 1) + plusDM[i]) / period;
    mDM = (mDM * (period - 1) + minusDM[i]) / period;

    const pDI = (pDM / atrVal) * 100;
    const mDI = (mDM / atrVal) * 100;

    dx.push(Math.abs(pDI - mDI) / (pDI + mDI) * 100);
  }

  return sma(dx, period);
}

/* =========================
   HELPERS
========================= */

function getRelativeStrength(closes, spy) {
  if (!spy || closes.length !== spy.length) return 0;

  const rsLine = closes.map((c, i) => c / spy[i]);
  const rsAvg = sma(rsLine, 50);

  if (!rsAvg) return 0;

  return rsLine[rsLine.length - 1] / rsAvg;
}

/* =========================
   MAIN SCANNER
========================= */

async function scanMarket({ symbols = [] }) {
  const spyData = await fetchHistory("SPY", "6mo", "1d");
  const spyClose = spyData?.indicators?.quote[0]?.close || [];

  const results = [];

  for (const symbol of symbols) {
    const data = await fetchHistory(symbol, "6mo", "1d");
    if (!data) continue;

    const { close, high, low, volume } = data.indicators.quote[0];
    if (!close || close.length < 50) continue;

    const price = close[close.length - 1];

    // Indicators
    const ema20 = ema(close, 20);
    const ema50 = ema(close, 50);
    const rsiVal = rsi(close);
    const atrVal = atr(high, low, close);
    const adxVal = adx(high, low, close);

    // Trend
    const trend = price > ema20 && ema20 > ema50 ? 1 : 0;

    // Momentum
    const momentum = price > close[close.length - 5] ? 1 : 0;

    // Volume
    const avgVol = sma(volume, 20);
    const volScore = avgVol ? volume[volume.length - 1] / avgVol : 0;

    // Relative Strength
    const rs = getRelativeStrength(close, spyClose);

    // Scoring (weighted model)
    const score =
      trend * 0.25 +
      momentum * 0.2 +
      Math.min(volScore / 2, 1) * 0.15 +
      Math.min(rs, 2) / 2 * 0.2 +
      (adxVal && adxVal > 20 ? 1 : 0) * 0.1 +
      (rsiVal && rsiVal < 70 ? 1 : 0) * 0.1;

    results.push({
      symbol,
      score,
      price,
      atr: atrVal,
      rs,
      volume: volScore,
      rsi: rsiVal,
      adx: adxVal
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

/* =========================
   EXPORT EVERYTHING
========================= */

module.exports = {
  scanMarket,
  ema,
  sma,
  rsi,
  atr,
  adx
};
