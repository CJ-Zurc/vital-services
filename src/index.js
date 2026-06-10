const express = require("express");
const { port, vitalWebUrl, internalServiceKey } = require("./config");
const { requireInternalService } = require("./middleware/internal-auth");
const paymongo = require("./paymongo");

const app = express();
app.use(express.json({ limit: "1mb" }));

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

app.get("/health", (_req, res) => {
  res.json({ success: true, data: { service: "vital-services" } });
});

app.post("/payments/paymongo/checkouts", requireInternalService, asyncHandler(async (req, res) => {
  const { appointmentId, amount, description, successUrl, cancelUrl } = req.body || {};
  if (!appointmentId || !amount || !successUrl || !cancelUrl) {
    return res.status(400).json({ success: false, message: "appointmentId, amount, successUrl, and cancelUrl are required." });
  }
  const checkout = await paymongo.createCheckout({
    appointmentId,
    amount,
    description: description || "VITAL consultation fee",
    successUrl,
    cancelUrl,
  });
  res.json({ success: true, data: checkout });
}));

app.get("/payments/paymongo/checkouts/:checkoutSessionId", requireInternalService, asyncHandler(async (req, res) => {
  const status = await paymongo.retrieveCheckout(req.params.checkoutSessionId);
  res.json({ success: true, data: status });
}));

app.post("/payments/paymongo/checkouts/:checkoutSessionId/expire", requireInternalService, asyncHandler(async (req, res) => {
  const result = await paymongo.expireCheckout(req.params.checkoutSessionId);
  res.json({ success: true, data: result });
}));

app.post("/payments/paymongo/refunds", requireInternalService, asyncHandler(async (req, res) => {
  const { paymentId, amount, reason, appointmentId } = req.body || {};
  if (!paymentId || !amount || !appointmentId) {
    return res.status(400).json({ success: false, message: "paymentId, appointmentId, and amount are required." });
  }
  const refund = await paymongo.createRefund({ paymentId, amount, reason });
  res.json({ success: true, data: refund });
}));

app.post("/jobs/appointments/auto-complete", requireInternalService, asyncHandler(async (_req, res) => {
  const response = await fetch(`${vitalWebUrl}/api/internal/appointments/auto-complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Service-Key": internalServiceKey,
    },
  });
  const payload = await response.json().catch(() => null);
  res.status(response.status).json(payload || { success: response.ok });
}));

app.post("/webhooks/paymongo", (_req, res) => {
  res.status(202).json({
    success: true,
    message: "Webhook endpoint reserved for a later phase. Payment sync currently uses checkout retrieval.",
  });
});

app.use((error, _req, res, _next) => {
  const status = error.status || error.response?.status || 500;
  const message =
    error.response?.data?.errors?.[0]?.detail ||
    error.response?.data?.errors?.[0]?.code ||
    error.message ||
    "Vital services request failed.";
  res.status(status).json({ success: false, message });
});

app.listen(port, () => {
  console.log(`vital-services listening on ${port}`);
});
