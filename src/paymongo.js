const axios = require("axios");
const { paymongoSecret } = require("./config");
const { errorFields, log, safeTarget } = require("./logger");

const api = axios.create({
  baseURL: "https://api.paymongo.com/v1",
  auth: { username: paymongoSecret, password: "" },
  headers: { "Content-Type": "application/json" },
  timeout: 15000,
});

api.interceptors.request.use((config) => {
  config.requestStartedAt = Date.now();
  return config;
});

api.interceptors.response.use(
  (response) => {
    log("info", "http.outbound.completed", {
      service: "paymongo",
      method: response.config.method?.toUpperCase(),
      target: safeTarget(`${response.config.baseURL || ""}${response.config.url || ""}`),
      status: response.status,
      durationMs: Date.now() - (response.config.requestStartedAt || Date.now()),
    });
    return response;
  },
  (error) => {
    const config = error.config || {};
    log("error", "http.outbound.failed", {
      service: "paymongo",
      method: config.method?.toUpperCase(),
      target: safeTarget(`${config.baseURL || ""}${config.url || ""}`),
      status: error.response?.status,
      durationMs: Date.now() - (config.requestStartedAt || Date.now()),
      ...errorFields(error),
    });
    return Promise.reject(error);
  },
);

function requirePaymongoSecret() {
  if (!paymongoSecret) {
    const error = new Error("PayMongo sandbox secret key is not configured.");
    error.status = 500;
    throw error;
  }
}

function amountToCentavos(amount) {
  return Math.round(Number(amount) * 100);
}

function mapCheckoutStatus(checkout) {
  const attributes = checkout?.attributes || {};
  const payments = attributes.payments || [];
  const paidPayment = payments.find((payment) => payment?.attributes?.status === "paid") || null;
  const failedPayment = payments.find((payment) => payment?.attributes?.status === "failed") || null;
  const paymentIntentId = attributes.payment_intent?.id || attributes.payment_intent_id || null;

  return {
    checkoutSessionId: checkout?.id,
    checkoutUrl: attributes.checkout_url || null,
    paymentIntentId,
    paymentId: paidPayment?.id || failedPayment?.id || null,
    status: paidPayment ? "paid" : failedPayment ? "failed" : attributes.status === "expired" ? "failed" : "pending",
    paidAt: paidPayment?.attributes?.paid_at ? new Date(paidPayment.attributes.paid_at * 1000).toISOString() : null,
  };
}

async function createCheckout({ appointmentId, amount, description, successUrl, cancelUrl }) {
  requirePaymongoSecret();
  const response = await api.post("/checkout_sessions", {
    data: {
      attributes: {
        billing: { name: `Appointment ${appointmentId}` },
        description,
        line_items: [
          {
            name: "Consultation Fee",
            quantity: 1,
            amount: amountToCentavos(amount),
            currency: "PHP",
          },
        ],
        payment_method_types: ["gcash", "paymaya", "card", "qrph"],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: { appointment_id: appointmentId },
      },
    },
  });
  const checkout = response.data?.data;
  return {
    checkoutSessionId: checkout.id,
    checkoutUrl: checkout.attributes.checkout_url,
    paymentIntentId: checkout.attributes.payment_intent?.id || null,
    status: checkout.attributes.status || "active",
  };
}

async function retrieveCheckout(checkoutSessionId) {
  requirePaymongoSecret();
  const response = await api.get(`/checkout_sessions/${checkoutSessionId}`);
  return mapCheckoutStatus(response.data?.data);
}

async function expireCheckout(checkoutSessionId) {
  requirePaymongoSecret();
  try {
    const response = await api.post(`/checkout_sessions/${checkoutSessionId}/expire`);
    return { checkoutSessionId, status: response.data?.data?.attributes?.status || "expired" };
  } catch (error) {
    if (error.response?.status === 400 || error.response?.status === 404) {
      return { checkoutSessionId, status: "not_expired" };
    }
    throw error;
  }
}

async function createRefund({ paymentId, amount, reason }) {
  requirePaymongoSecret();
  const response = await api.post("/refunds", {
    data: {
      attributes: {
        amount: amountToCentavos(amount),
        payment_id: paymentId,
        reason: reason || "requested_by_customer",
      },
    },
  });
  const refund = response.data?.data;
  return {
    refundId: refund.id,
    status: refund.attributes?.status || "pending",
  };
}

module.exports = {
  createCheckout,
  retrieveCheckout,
  expireCheckout,
  createRefund,
};
