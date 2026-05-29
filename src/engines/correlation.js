const { fetchHistory } = require("../data/marketData");

/* =========================
   CORRELATION MATRIX
========================= */

async function getCorrelationMatrix({ symbols = [], config = {} }) {
  const lookback = config.lookback || "120d";

  const results = await Promise.all(
    symbols.map((symbol) =>
      fetchHistory(symbol, lookback, "1d")
    )
  );

  const closes = results.map((res) =>
    res?.indicators?.quote[0]?.close || []
  );

  const matrix = symbols.map(() =>
    Array(symbols.length).fill(0)
  );

  for (let i = 0; i < symbols.length; i++) {
    for (let j = 0; j < symbols.length; j++) {
      const xi = closes[i];
      const xj = closes[j];

      if (!xi.length || !xj.length || xi.length !== xj.length) {
        matrix[i][j] = 0;
        continue;
      }

      const meanXi = xi.reduce((a, b) => a + b, 0) / xi.length;
      const meanXj = xj.reduce((a, b) => a + b, 0) / xj.length;

      let num = 0;
      let denXi = 0;
      let denXj = 0;

      for (let k = 0; k < xi.length; k++) {
        const dx = xi[k] - meanXi;
        const dy = xj[k] - meanXj;

        num += dx * dy;
        denXi += dx * dx;
        denXj += dy * dy;
      }

      // ✅ FIXED NaN bug
      if (!denXi || !denXj) {
        matrix[i][j] = 0;
      } else {
        matrix[i][j] = num / Math.sqrt(denXi * denXj);
      }
    }
  }

  return { symbols, matrix };
}

module.exports = { getCorrelationMatrix };
