function brokerStatus(settings) {
  const mode = process.env.BROKER_MODE || settings.brokerMode || "disabled";
  return {
    mode,
    enabled: false,
    liveTrading: false,
    message: "Broker integration is intentionally disabled. Paper trading only."
  };
}

function placeOrder() {
  return {
    ok: false,
    error: "Live broker execution is disabled. Use paper trading until long-term testing passes."
  };
}

module.exports = { brokerStatus, placeOrder };
