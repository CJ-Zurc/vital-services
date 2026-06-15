const express = require("express");
const {
  port,
  vitalWebUrl,
  servicesToWebInternalServiceKey,
  validateConfig,
} = require("./config");
const { requireInternalService } = require("./middleware/internal-auth");
const correlationId = require("./middleware/correlationId");
const trustedGateway = require("./middleware/trustedGateway");
const vitalRouter = require("./routes/vital");
const paymongo = require("./paymongo");
const { runPaymentOperation } = require("./payment-operations");

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(correlationId);
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ success: true, data: { service: "vital-services" } });
  });

  app.post(
    "/payments/paymongo/checkouts",
    requireInternalService,
    asyncHandler(async (req, res) => {
      const {
        operationKey,
        appointmentId,
        amount,
        description,
        successUrl,
        cancelUrl,
      } = req.body || {};
      if (!operationKey || !appointmentId || !amount || !successUrl || !cancelUrl) {
        return res.status(400).json({
          success: false,
          message: "operationKey, appointmentId, amount, successUrl, and cancelUrl are required.",
        });
      }
      const operation = await runPaymentOperation({
        operationKey,
        operationType: "checkout",
        payload: { appointmentId, amount, description, successUrl, cancelUrl },
        correlationId: req.correlationId,
        execute: () =>
          paymongo.createCheckout({
            appointmentId,
            amount,
            description: description || "VITAL consultation fee",
            successUrl,
            cancelUrl,
          }),
      });
      res.status(operation.operationStatus === "pending" ? 202 : 200).json({
        success: operation.operationStatus === "completed",
        ...operation,
      });
    }),
  );

  app.get(
    "/payments/paymongo/checkouts/:checkoutSessionId",
    requireInternalService,
    asyncHandler(async (req, res) => {
      const status = await paymongo.retrieveCheckout(req.params.checkoutSessionId);
      res.json({ success: true, data: status });
    }),
  );

  app.post(
    "/payments/paymongo/checkouts/:checkoutSessionId/expire",
    requireInternalService,
    asyncHandler(async (req, res) => {
      const result = await paymongo.expireCheckout(req.params.checkoutSessionId);
      res.json({ success: true, data: result });
    }),
  );

  app.post(
    "/payments/paymongo/refunds",
    requireInternalService,
    asyncHandler(async (req, res) => {
      const { operationKey, paymentId, amount, reason, appointmentId } = req.body || {};
      if (!operationKey || !paymentId || !amount || !appointmentId) {
        return res.status(400).json({
          success: false,
          message: "operationKey, paymentId, appointmentId, and amount are required.",
        });
      }
      const operation = await runPaymentOperation({
        operationKey,
        operationType: "refund",
        payload: { paymentId, amount, reason, appointmentId },
        correlationId: req.correlationId,
        execute: () => paymongo.createRefund({ paymentId, amount, reason }),
      });
      res.status(operation.operationStatus === "pending" ? 202 : 200).json({
        success: operation.operationStatus === "completed",
        ...operation,
      });
    }),
  );

  app.post(
    "/jobs/appointments/auto-complete",
    requireInternalService,
    asyncHandler(async (req, res) => {
      const response = await fetch(
        `${vitalWebUrl}/api/internal/appointments/auto-complete`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Service": "vital-services",
            "X-Internal-Service-Key": servicesToWebInternalServiceKey,
            "X-Correlation-ID": req.correlationId,
          },
        },
      );
      const payload = await response.json().catch(() => null);
      res.status(response.status).json(payload || { success: response.ok });
    }),
  );

  app.post("/webhooks/paymongo", (_req, res) => {
    res.status(202).json({
      success: true,
      message: "Webhook endpoint reserved for a later phase. Payment sync currently uses checkout retrieval.",
    });
  });

  app.use(trustedGateway, vitalRouter);

  app.use((error, _req, res, _next) => {
    const status = error.status || error.response?.status || 500;
    const message =
      error.response?.data?.errors?.[0]?.detail ||
      error.response?.data?.errors?.[0]?.code ||
      error.message ||
      "Vital services request failed.";
    res.status(status).json({
      success: false,
      message,
      ...(error.operationStatus
        ? { operationStatus: error.operationStatus }
        : {}),
    });
  });

  return app;
}

if (require.main === module) {
  validateConfig();
  createApp().listen(port, () => {
    console.log(`vital-services listening on ${port}`);
  });
}

module.exports = { createApp };
