const { fetchHistory } = require('../data/marketData');

function sma(arr, n) {
  if (!Array.isArray(arr) || arr.length < n) return null;
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
}

function ema(arr, n) {
  if (!Array.isArray(arr) || arr.length < n) return null;
  const k = 2 / (n + 1);
  let val = arr[arr.length - n];
  for (let i = arr.length - n + 1; i < arr.length; i++) {
    val = arr[i] * k + val * (1 - k);
  }
  return val;
}

function atr(high, low, close, n = 14) {
  if (!Array.isArray(close) || close.length < n + 1 || !Array.isArray(high) || !Array.isArray(low)) return null;
  const trs = [];
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

function getRelativeStrength(closes, spy) {
  if (!Array.isArray(closes) || !Array.isArray(spy) || closes.length !== spy.length || !closes.length) return 0;
  const rs = closes.map((c, i) => {
    const sc = spy[i];
    return sc && sc > 0 ? c / sc : 0;
  });
  const last = rs[rs.length - 1];
  const avg = sma(rs, Math.min(50, rs.length));
  return avg ? last / avg : 0;
}

async function scanMarket({ symbols = [] }) {
  // Pull SPY for relative strength and regime filtering
  const spyData = await fetchHistory('SPY', '6mo', '1d');
  const spyClose = (spyData && spyData.indicators && spyData.indicators.quote && spyData.indicators.quote[0].close) || [];

  const results = [];
  for (const symbol of symbols) {
    try {
      const data = await fetchHistory(symbol, '6mo', '1d');
      if (!data || !data.indicators || !data.indicators.quote || !data.indicators.quote[0]) {
        continue;
      }
      const close = data.indicators.quote[0].close || [];
      const high  = data.indicators.quote[0].high  || [];
      const low   = data.indicators.quote[0].low   || [];
      const volume = data.indicators.quote[0].volume || [];
      if (close.length < 50) continue;
      const price = close[close.length - 1];
      const ema20 = ema(close, 20);
      const ema50 = ema(close, 50);
      const trend = ema20 && ema50 && price > ema20 && ema20 > ema50 ? 1 : 0;
      const momentum = close.length >= 5 && price > close[close.length - 5] ? 1 : 0;
      const avgVol = sma(volume, 20) || 1;
      const volScore = volume[volume.length - 1] / avgVol;
      const rs = getRelativeStrength(close, spyClose);
      const volatility = atr(high, low, close);
      const score =
        trend * 0.25 +
        momentum * 0.2 +
        Math.min(volScore / 2, 1) * 0.15 +
        (Math.min(rs, 2) / 2) * 0.2 +
        (volatility ? 1 : 0) * 0.1;
      results.push({ symbol, score, price, atr: volatility, rs, volume: volScore });
    } catch (err) {
      console.error(`Error scanning ${symbol}:`, err);
    }
  }
  return results.sort((a, b) => b.score - a.score);
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

module.exports = { scanMarket, ema, rsi };


