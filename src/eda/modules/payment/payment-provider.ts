import { z } from "zod";
import { boundedJsonReceipt } from "../../infrastructure/http-receipt.js";

export interface CheckoutObservation {
  checkoutSessionId: string;
  checkoutUrl: string | null;
  paymentIntentId: string | null;
  paymentId: string | null;
  status: "pending" | "paid" | "failed";
  checkoutState: "active" | "expired";
  amountCentavos: number;
  currency: "PHP";
  paidAt: string | null;
  livemode: false;
  appointmentId: string | null;
  billingLineageId: string | null;
}

export interface RefundObservation {
  refundId: string;
  paymentId: string;
  amountCentavos: number;
  currency: "PHP";
  status: "pending" | "processing" | "succeeded" | "failed";
  livemode: false;
}

export interface PaymentProvider {
  createCheckout(input: {
    operationId: string; appointmentId: string; billingLineageId: string;
    amountCentavos: number; currency: "PHP"; successUrl: string; cancelUrl: string;
  }): Promise<CheckoutObservation>;
  retrieveCheckout(id: string): Promise<CheckoutObservation>;
  expireCheckout(id: string): Promise<CheckoutObservation>;
  createRefund(input: {
    operationId: string; paymentId: string; amountCentavos: number; currency: "PHP"; reason: "others";
  }): Promise<RefundObservation>;
  retrieveRefund(id: string): Promise<RefundObservation>;
}

export class ProviderError extends Error {
  constructor(readonly code: string, readonly definite: boolean, readonly retryAfterSeconds?: number) {
    super(code);
    this.name = "ProviderError";
  }
}

const base = "https://api.paymongo.com/v1";
const deadlineMs = 15_000;
const maxReceiptBytes = 65_536;
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const operationId = z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const amount = z.number().int().positive().max(2_147_483_647);
const currency = z.literal("PHP");
const resourceId = (prefix: string) => z.string().max(128).regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`));
const checkoutId = resourceId("cs");
const paymentId = resourceId("pay");
const intentId = resourceId("pi");
const refundId = resourceId("ref");

function validReturnUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash && !/[\s\\]/.test(value)
      && (url.protocol === "https:" || (url.protocol === "http:"
        && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}

const returnUrl = z.string().max(2048).refine(validReturnUrl);
const createCheckoutInput = z.object({
  operationId, appointmentId: identifier, billingLineageId: identifier,
  amountCentavos: amount, currency, successUrl: returnUrl, cancelUrl: returnUrl,
}).strict();
const createRefundInput = z.object({
  operationId, paymentId, amountCentavos: amount.min(100), currency, reason: z.literal("others"),
}).strict();
const payment = z.object({
  id: paymentId, type: z.literal("payment"), attributes: z.object({
    amount, currency, livemode: z.literal(false), status: z.enum(["pending", "paid", "failed"]),
    paid_at: z.number().int().positive().max(253_402_300_799).nullish(),
    payment_intent_id: intentId.nullish(),
  }),
});
const checkout = z.object({
  data: z.object({
    id: checkoutId, type: z.literal("checkout_session"), attributes: z.object({
      livemode: z.literal(false), status: z.enum(["active", "expired"]),
      checkout_url: z.string().max(2048).nullish(),
      line_items: z.array(z.object({ amount, currency, quantity: z.number().int().positive().max(999) })).min(1).max(999),
      payments: z.array(payment).max(100),
      payment_intent_id: intentId.nullish(),
      payment_intent: z.object({
        id: intentId, type: z.literal("payment_intent"), attributes: z.object({
          amount, currency, livemode: z.literal(false), status: z.string().max(64),
          payments: z.array(payment).max(100).optional(),
        }),
      }).nullish(),
      metadata: z.object({ appointment_id: identifier.optional(), billing_lineage_id: identifier.optional() }).nullish(),
    }),
  }),
});
const refund = z.object({
  data: z.object({ id: refundId, type: z.literal("refund"), attributes: z.object({
    amount: amount.min(100), currency, payment_id: paymentId,
    livemode: z.literal(false), status: z.enum(["pending", "processing", "succeeded", "failed"]),
  }) }),
});

function parse<T>(schema: z.ZodType<T>, value: unknown, code: string, definite: boolean): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProviderError(code, definite);
  return result.data;
}

function invalid(): never { throw new ProviderError("PAYMONGO_INVALID_RESPONSE", false); }

function safeCheckoutUrl(value: string | null | undefined): string | null {
  if (value == null) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "checkout.paymongo.com" || url.port
      || url.username || url.password || /[\s\\]/.test(value) || !value.startsWith("https://checkout.paymongo.com/")) invalid();
    return value;
  } catch { return invalid(); }
}

function observeCheckout(value: unknown, expectedId?: string): CheckoutObservation {
  const { data } = parse(checkout, value, "PAYMONGO_INVALID_RESPONSE", false);
  if (expectedId && data.id !== expectedId) invalid();
  const a = data.attributes;
  const total = a.line_items.reduce((sum, item) => sum + item.amount * item.quantity, 0);
  if (!Number.isSafeInteger(total) || total > 2_147_483_647) invalid();
  const pi = a.payment_intent;
  if (pi && (pi.attributes.amount !== total || (a.payment_intent_id && a.payment_intent_id !== pi.id))) invalid();
  let resolvedIntentId = pi?.id ?? a.payment_intent_id ?? null;
  // Both v1 arrays can expose the same payment; conflicting duplicates are not evidence.
  const payments = new Map<string, z.infer<typeof payment>>();
  for (const p of [...a.payments, ...(pi?.attributes.payments ?? [])]) {
    if (p.attributes.amount !== total) invalid();
    if (p.attributes.payment_intent_id) {
      resolvedIntentId ??= p.attributes.payment_intent_id;
      if (p.attributes.payment_intent_id !== resolvedIntentId) invalid();
    }
    const previous = payments.get(p.id);
    if (previous && JSON.stringify(previous.attributes) !== JSON.stringify(p.attributes)) invalid();
    payments.set(p.id, p);
  }
  const paid = [...payments.values()].filter(p => p.attributes.status === "paid");
  if (paid.length > 1 || (pi?.attributes.status === "succeeded" && paid.length === 0)) invalid();
  const paidPayment = paid[0];
  if (paidPayment && !paidPayment.attributes.paid_at) invalid();
  const checkoutUrl = safeCheckoutUrl(a.checkout_url);
  if (a.status === "active" && !paidPayment && !checkoutUrl) invalid();
  return {
    checkoutSessionId: data.id, checkoutUrl,
    paymentIntentId: resolvedIntentId,
    paymentId: paidPayment?.id ?? null,
    status: paidPayment ? "paid" : a.status === "expired" ? "failed" : "pending",
    checkoutState: a.status, amountCentavos: total, currency: "PHP",
    paidAt: paidPayment ? new Date(paidPayment.attributes.paid_at! * 1000).toISOString() : null,
    livemode: false, appointmentId: a.metadata?.appointment_id ?? null,
    billingLineageId: a.metadata?.billing_lineage_id ?? null,
  };
}

function observeRefund(value: unknown, expectedId?: string): RefundObservation {
  const { data } = parse(refund, value, "PAYMONGO_INVALID_RESPONSE", false);
  if (expectedId && data.id !== expectedId) invalid();
  return {
    refundId: data.id, paymentId: data.attributes.payment_id,
    amountCentavos: data.attributes.amount, currency: "PHP", status: data.attributes.status, livemode: false,
  };
}

const rejectionCodes = new Set([
  "parameter_invalid", "parameter_data_type_invalid", "parameter_format_invalid", "parameter_required",
  "parameter_below_minimum", "parameter_above_maximum", "authentication_invalid",
  "api_key_invalid", "authentication_failed", "resource_not_found", "organization_not_allowed",
]);
const rejectionBody = z.object({ errors: z.array(z.object({ code: z.string() })).min(1).max(100) });

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

export function createPaymongoProvider(options: {
  secret: string; fetcher?: typeof fetch; baseUrl?: string;
}): PaymentProvider {
  if (typeof options.secret !== "string" || !/^sk_test_[A-Za-z0-9]+$/.test(options.secret)) {
    throw new ProviderError("PAYMONGO_SANDBOX_SECRET_REQUIRED", true);
  }
  if (options.baseUrl !== undefined && options.baseUrl !== base) {
    throw new ProviderError("PAYMONGO_BASE_URL_FORBIDDEN", true);
  }
  const fetcher = options.fetcher ?? fetch;
  const authorization = `Basic ${Buffer.from(`${options.secret}:`).toString("base64")}`;

  async function request(method: "GET" | "POST", path: string, body?: unknown, key?: string): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderError("PAYMONGO_TIMEOUT", false));
      }, deadlineMs);
    });
    const run = async (): Promise<unknown> => {
      const response = await fetcher(`${base}${path}`, {
        method, redirect: "error", signal: controller.signal,
        headers: { Authorization: authorization, Accept: "application/json", "Content-Type": "application/json",
          ...(key ? { "Idempotency-Key": key } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const wait = retryAfter(response);
      let value: unknown;
      try { value = await boundedJsonReceipt(response, maxReceiptBytes); }
      catch { throw new ProviderError(response.ok ? "PAYMONGO_INVALID_RESPONSE" : `PAYMONGO_HTTP_${response.status}`, false, wait); }
      if (!response.ok) {
        const errors = rejectionBody.safeParse(value);
        const definite = [400, 401, 403, 404, 422].includes(response.status)
          && errors.success && errors.data.errors.every(error => rejectionCodes.has(error.code));
        throw new ProviderError(`PAYMONGO_HTTP_${response.status}`, definite, wait);
      }
      return value;
    };
    try { return await Promise.race([run(), deadline]); }
    catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("PAYMONGO_TRANSPORT_ERROR", false);
    } finally { if (timer) clearTimeout(timer); }
  }

  return {
    async createCheckout(input) {
      const i = parse(createCheckoutInput, input, "PAYMONGO_INVALID_INPUT", true);
      const observation = observeCheckout(await request("POST", "/checkout_sessions", { data: { attributes: {
        line_items: [{ name: "Consultation Fee", quantity: 1, amount: i.amountCentavos, currency: i.currency }],
        payment_method_types: ["gcash", "paymaya", "card", "qrph"], send_email_receipt: false,
        success_url: i.successUrl, cancel_url: i.cancelUrl,
        metadata: { appointment_id: i.appointmentId, billing_lineage_id: i.billingLineageId },
      } } }, i.operationId));
      if (observation.amountCentavos !== i.amountCentavos || observation.appointmentId !== i.appointmentId
        || observation.billingLineageId !== i.billingLineageId) invalid();
      return observation;
    },
    async retrieveCheckout(id) {
      parse(checkoutId, id, "PAYMONGO_INVALID_INPUT", true);
      return observeCheckout(await request("GET", `/checkout_sessions/${id}`), id);
    },
    async expireCheckout(id) {
      parse(checkoutId, id, "PAYMONGO_INVALID_INPUT", true);
      const observation = observeCheckout(await request("POST", `/checkout_sessions/${id}/expire`), id);
      if (observation.checkoutState !== "expired") invalid();
      return observation;
    },
    async createRefund(input) {
      const i = parse(createRefundInput, input, "PAYMONGO_INVALID_INPUT", true);
      const observation = observeRefund(await request("POST", "/refunds", { data: { attributes: {
        amount: i.amountCentavos, payment_id: i.paymentId, reason: "others",
      } } }, i.operationId));
      if (observation.paymentId !== i.paymentId || observation.amountCentavos !== i.amountCentavos) invalid();
      return observation;
    },
    async retrieveRefund(id) {
      parse(refundId, id, "PAYMONGO_INVALID_INPUT", true);
      return observeRefund(await request("GET", `/refunds/${id}`), id);
    },
  };
}
