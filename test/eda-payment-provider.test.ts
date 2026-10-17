import assert from "node:assert/strict";
import test from "node:test";
import { createPaymongoProvider, ProviderError } from "../src/eda/modules/payment/payment-provider.js";

const secret = "sk_test_fixture123";
const input = {
  operationId: "22222222-2222-4222-8222-222222222222",
  appointmentId: "11111111-1111-4111-8111-111111111111",
  billingLineageId: "33333333-3333-4333-8333-333333333333",
  amountCentavos: 125050, currency: "PHP" as const,
  successUrl: "https://vital.example/payment/success", cancelUrl: "https://vital.example/payment/cancel",
};
const refundInput = {
  operationId: "44444444-4444-4444-8444-444444444444",
  paymentId: "pay_fixture", amountCentavos: input.amountCentavos, currency: "PHP" as const, reason: "others" as const,
};

function payment(attributes: Record<string, unknown> = {}) {
  return { id: "pay_fixture", type: "payment", attributes: {
    amount: input.amountCentavos, currency: "PHP", livemode: false,
    status: "paid", paid_at: 1_700_000_000, payment_intent_id: "pi_fixture", ...attributes,
  } };
}
function checkout(attributes: Record<string, unknown> = {}) {
  return { data: { id: "cs_fixture", type: "checkout_session", attributes: {
    livemode: false, status: "active", checkout_url: "https://checkout.paymongo.com/cs_fixture#public",
    line_items: [{ amount: input.amountCentavos, currency: "PHP", quantity: 1 }], payments: [],
    payment_intent: null,
    metadata: { appointment_id: input.appointmentId, billing_lineage_id: input.billingLineageId }, ...attributes,
  } } };
}
function refund(attributes: Record<string, unknown> = {}) {
  return { data: { id: "ref_fixture", type: "refund", attributes: {
    amount: input.amountCentavos, currency: "PHP", payment_id: "pay_fixture", livemode: false,
    status: "pending", ...attributes,
  } } };
}
function provider(value: unknown, status = 200) {
  return createPaymongoProvider({ secret, fetcher: async () => Response.json(value, { status }) });
}
function isError(code: string, definite: boolean) {
  return (error: unknown) => error instanceof ProviderError && error.code === code && error.definite === definite;
}

test("EDA PayMongo target requires sandbox secret and pins v1 origin", () => {
  createPaymongoProvider({ secret });
  for (const value of [undefined, "", "sk_test_", "sk_live_fixture", "pk_test_fixture", " sk_test_fixture", "sk_test_fixture\n"]) {
    assert.throws(() => createPaymongoProvider({ secret: value as string }), isError("PAYMONGO_SANDBOX_SECRET_REQUIRED", true));
  }
  for (const baseUrl of ["http://api.paymongo.com/v1", "https://api.paymongo.com/v2", "https://evil.example/v1",
    "https://api.paymongo.com@evil.example/v1", "https://api.paymongo.com/v1/"]) {
    assert.throws(() => createPaymongoProvider({ secret, baseUrl }), isError("PAYMONGO_BASE_URL_FORBIDDEN", true));
  }
});

test("EDA PayMongo checkout creation sends exact centavos and stable creation-only idempotency", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const p = createPaymongoProvider({ secret, fetcher: async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return Response.json(checkout());
  } });
  const first = await p.createCheckout(input);
  await p.createCheckout(input);
  await p.retrieveCheckout("cs_fixture");
  assert.equal(first.amountCentavos, 125050);
  assert.equal(first.status, "pending");
  assert.equal(calls[0]!.url, "https://api.paymongo.com/v1/checkout_sessions");
  assert.equal(calls[0]!.init.redirect, "error");
  assert.ok(calls[0]!.init.signal instanceof AbortSignal);
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get("authorization"), `Basic ${Buffer.from(`${secret}:`).toString("base64")}`);
  assert.equal(headers.get("idempotency-key"), input.operationId);
  assert.equal(new Headers(calls[1]!.init.headers).get("idempotency-key"), input.operationId);
  assert.equal(new Headers(calls[2]!.init.headers).get("idempotency-key"), null);
  assert.equal(calls[2]!.url, "https://api.paymongo.com/v1/checkout_sessions/cs_fixture");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { data: { attributes: {
    line_items: [{ name: "Consultation Fee", quantity: 1, amount: 125050, currency: "PHP" }],
    payment_method_types: ["gcash", "paymaya", "card", "qrph"], send_email_receipt: false,
    success_url: input.successUrl, cancel_url: input.cancelUrl,
    metadata: { appointment_id: input.appointmentId, billing_lineage_id: input.billingLineageId },
  } } });
});

test("EDA PayMongo rejects invalid inputs and unsafe IDs before transport", async () => {
  let calls = 0;
  const p = createPaymongoProvider({ secret, fetcher: async () => { calls++; return Response.json(checkout()); } });
  for (const changes of [
    { amountCentavos: 12.5 }, { amountCentavos: 0 }, { amountCentavos: -1 }, { amountCentavos: Number.NaN },
    { amountCentavos: 2_147_483_648 }, { currency: "USD" }, { operationId: "bad\r\nheader" },
    { appointmentId: "../users" }, { billingLineageId: "" }, { description: "clinical text" },
    { successUrl: "javascript:alert(1)" }, { cancelUrl: "https://user:password@vital.example/cancel" },
    { successUrl: "http://remote.example/success" }, { successUrl: "https://vital.example/\n" },
  ]) await assert.rejects(p.createCheckout({ ...input, ...changes } as typeof input), isError("PAYMONGO_INVALID_INPUT", true));
  for (const id of ["../secret", "cs_", "cs_fixture/expire", "cs_fixture?x=y", "pay_fixture", "cs_bad%2furl"]) {
    await assert.rejects(p.retrieveCheckout(id), isError("PAYMONGO_INVALID_INPUT", true));
    await assert.rejects(p.expireCheckout(id), isError("PAYMONGO_INVALID_INPUT", true));
  }
  await assert.rejects(p.retrieveRefund("ref_fixture/../secret"), isError("PAYMONGO_INVALID_INPUT", true));
  assert.equal(calls, 0);
});

test("EDA PayMongo failed attempt on active checkout stays pending and paid wins expiry", async () => {
  const failed = payment({ status: "failed", paid_at: null });
  const active = await provider(checkout({ payments: [failed] })).retrieveCheckout("cs_fixture");
  assert.equal(active.status, "pending");
  assert.equal(active.paymentId, null);
  assert.equal(active.paidAt, null);
  const expired = await provider(checkout({ payments: [failed], status: "expired", checkout_url: null })).retrieveCheckout("cs_fixture");
  assert.equal(expired.status, "failed");
  const paid = await provider(checkout({ payments: [payment()], status: "expired" })).retrieveCheckout("cs_fixture");
  assert.equal(paid.status, "paid");
  assert.equal(paid.checkoutState, "expired");
  assert.equal(paid.paymentId, "pay_fixture");
  assert.equal(paid.paidAt, "2023-11-14T22:13:20.000Z");
});

test("EDA PayMongo paid evidence requires provider timestamp and unambiguous payment", async () => {
  for (const paid_at of [undefined, null, 0, -1, "1700000000", 1.2, 1e15]) {
    await assert.rejects(provider(checkout({ payments: [payment({ paid_at })] })).retrieveCheckout("cs_fixture"),
      isError("PAYMONGO_INVALID_RESPONSE", false));
  }
  await assert.rejects(provider(checkout({ payments: [payment(), { ...payment(), id: "pay_second" }] }))
    .retrieveCheckout("cs_fixture"), isError("PAYMONGO_INVALID_RESPONSE", false));
  const pi = { id: "pi_fixture", type: "payment_intent", attributes: {
    amount: input.amountCentavos, currency: "PHP", livemode: false, status: "succeeded", payments: [],
  } } as { id: string; type: string; attributes: {
    amount: number; currency: string; livemode: boolean; status: string; payments: ReturnType<typeof payment>[];
  } };
  await assert.rejects(provider(checkout({ payment_intent: pi })).retrieveCheckout("cs_fixture"),
    isError("PAYMONGO_INVALID_RESPONSE", false));
  const p = payment();
  pi.attributes.payments = [p];
  assert.equal((await provider(checkout({ payments: [p], payment_intent: pi })).retrieveCheckout("cs_fixture")).status, "paid");
  await assert.rejects(provider(checkout({ payments: [payment({ paid_at: 1_700_000_001 })], payment_intent: pi }))
    .retrieveCheckout("cs_fixture"), isError("PAYMONGO_INVALID_RESPONSE", false));
});

test("EDA PayMongo fences every known payment intent association across both checkout arrays", async () => {
  const pi = (payments: ReturnType<typeof payment>[]) => ({
    id: "pi_fixture", type: "payment_intent", attributes: {
      amount: input.amountCentavos, currency: "PHP", livemode: false, status: "processing", payments,
    },
  });
  for (const status of ["paid", "pending", "failed"]) {
    const foreign = payment({ status, paid_at: status === "paid" ? 1_700_000_000 : null, payment_intent_id: "pi_other" });
    for (const attributes of [
      { payments: [foreign], payment_intent: pi([]) },
      { payment_intent: pi([foreign]) },
      { payments: [foreign], payment_intent_id: "pi_fixture" },
      { payments: [payment(), { ...foreign, id: "pay_other" }] },
      { payments: [payment()], payment_intent: pi([{ ...foreign, id: "pay_other" }]) },
    ]) await assert.rejects(provider(checkout(attributes)).retrieveCheckout("cs_fixture"),
      isError("PAYMONGO_INVALID_RESPONSE", false));
  }
  const matching = payment();
  const unpaid = { ...payment({ status: "failed", paid_at: null }), id: "pay_failed" };
  const verified = await provider(checkout({ payments: [matching, unpaid], payment_intent: pi([matching, unpaid]) }))
    .retrieveCheckout("cs_fixture");
  assert.equal(verified.status, "paid");
  assert.equal(verified.paymentIntentId, "pi_fixture");
  const inferred = await provider(checkout({ payments: [matching] })).retrieveCheckout("cs_fixture");
  assert.equal(inferred.paymentIntentId, "pi_fixture");
  const noIds = await provider(checkout({ payments: [payment({ status: "failed", paid_at: null, payment_intent_id: null })] }))
    .retrieveCheckout("cs_fixture");
  assert.equal(noIds.paymentIntentId, null);
});

test("EDA PayMongo validates checkout resource mode amount currency and identifiers", async () => {
  const invalidAttributes = [
    { livemode: true }, { livemode: undefined }, { status: "completed" }, { payments: undefined },
    { line_items: [] }, { line_items: [{ amount: "125050", currency: "PHP", quantity: 1 }] },
    { line_items: [{ amount: 1.5, currency: "PHP", quantity: 1 }] },
    { line_items: [{ amount: 125050, currency: "USD", quantity: 1 }] },
    { line_items: [{ amount: 2_147_483_647, currency: "PHP", quantity: 2 }] },
    { payments: [payment({ amount: 100 })] }, { payments: [payment({ currency: "USD" })] },
    { payments: [payment({ livemode: true })] }, { payments: [{ ...payment(), id: "pay_bad/path" }] },
    { payment_intent_id: "pi_bad/path" }, { metadata: { appointment_id: { secret: "x" } } },
    { payment_intent: { id: "pi_fixture", type: "payment_intent", attributes: {
      amount: input.amountCentavos, currency: "PHP", livemode: true, status: "processing",
    } } },
    { payment_intent: { id: "pi_fixture", type: "payment_intent", attributes: {
      amount: 100, currency: "PHP", livemode: false, status: "processing",
    } } },
    { payment_intent_id: "pi_other", payment_intent: { id: "pi_fixture", type: "payment_intent", attributes: {
      amount: input.amountCentavos, currency: "PHP", livemode: false, status: "processing",
    } } },
    { checkout_url: null },
  ];
  for (const attrs of invalidAttributes) await assert.rejects(provider(checkout(attrs)).retrieveCheckout("cs_fixture"),
    isError("PAYMONGO_INVALID_RESPONSE", false));
  for (const changes of [{ id: "cs_wrong" }, { id: "pay_fixture" }, { type: "payment" }]) {
    const value = checkout(); Object.assign(value.data, changes);
    await assert.rejects(provider(value).retrieveCheckout("cs_fixture"), isError("PAYMONGO_INVALID_RESPONSE", false));
  }
});

test("EDA PayMongo verifies creation quote and metadata against authorized input", async () => {
  for (const attrs of [
    { line_items: [{ amount: 100, currency: "PHP", quantity: 1 }] },
    { metadata: null }, { metadata: { appointment_id: "other", billing_lineage_id: input.billingLineageId } },
    { metadata: { appointment_id: input.appointmentId, billing_lineage_id: "other" } },
  ]) await assert.rejects(provider(checkout(attrs)).createCheckout(input), isError("PAYMONGO_INVALID_RESPONSE", false));
  const value = checkout();
  Object.assign(value.data.attributes, { line_items: [
    { amount: 62525, currency: "PHP", quantity: 1 }, { amount: 62525, currency: "PHP", quantity: 1 },
  ] });
  assert.equal((await provider(value).retrieveCheckout("cs_fixture")).amountCentavos, input.amountCentavos);
});

test("EDA PayMongo checkout URL rejects host protocol credentials and parser tampering", async () => {
  for (const checkout_url of [
    "http://checkout.paymongo.com/cs_fixture", "javascript:alert(1)", "https://evil.example/cs_fixture",
    "https://checkout.paymongo.com.evil.example/cs_fixture", "https://checkout.paymongo.com@evil.example/cs_fixture",
    "https://user:password@checkout.paymongo.com/cs_fixture", "https://checkout.paymongo.com:444/cs_fixture",
    "https://checkout.paymongo.com./cs_fixture", "https://checkout.paymongo.com\\@evil.example/cs_fixture",
    "https://checkout.paymongo.com/\ncs_fixture", "//checkout.paymongo.com/cs_fixture", "not-a-url",
  ]) await assert.rejects(provider(checkout({ checkout_url })).retrieveCheckout("cs_fixture"),
    isError("PAYMONGO_INVALID_RESPONSE", false));
  assert.equal((await provider(checkout()).retrieveCheckout("cs_fixture")).checkoutUrl,
    "https://checkout.paymongo.com/cs_fixture#public");
});

test("EDA PayMongo expiry propagates rejection instead of inventing successful expiry", async () => {
  const p = provider({ errors: [{ code: "parameter_invalid", detail: "already closed" }] }, 400);
  await assert.rejects(p.expireCheckout("cs_fixture"), isError("PAYMONGO_HTTP_400", true));
  await assert.rejects(provider(checkout()).expireCheckout("cs_fixture"), isError("PAYMONGO_INVALID_RESPONSE", false));
  let requestInit: RequestInit | undefined;
  const expired = createPaymongoProvider({ secret, fetcher: async (url, init) => {
    assert.equal(String(url), "https://api.paymongo.com/v1/checkout_sessions/cs_fixture/expire");
    requestInit = init;
    return Response.json(checkout({ status: "expired", checkout_url: null }));
  } });
  assert.equal((await expired.expireCheckout("cs_fixture")).checkoutState, "expired");
  assert.equal(new Headers(requestInit!.headers).get("idempotency-key"), null);
  assert.equal(requestInit!.method, "POST");
});

test("EDA PayMongo refund creation uses others and stable key without cancellation text", async () => {
  const calls: RequestInit[] = [];
  const p = createPaymongoProvider({ secret, fetcher: async (url, init) => {
    assert.equal(String(url), "https://api.paymongo.com/v1/refunds"); calls.push(init!);
    return Response.json(refund());
  } });
  await p.createRefund(refundInput); await p.createRefund(refundInput);
  assert.equal(new Headers(calls[0]!.headers).get("idempotency-key"), refundInput.operationId);
  assert.equal(new Headers(calls[1]!.headers).get("idempotency-key"), refundInput.operationId);
  assert.deepEqual(JSON.parse(String(calls[0]!.body)), { data: { attributes: {
    amount: input.amountCentavos, payment_id: "pay_fixture", reason: "others",
  } } });
  for (const changes of [{ reason: "doctor_cancelled" }, { amountCentavos: 99 }, { currency: "USD" },
    { paymentId: "cs_fixture" }, { notes: "clinical text" }]) {
    await assert.rejects(p.createRefund({ ...refundInput, ...changes } as typeof refundInput), isError("PAYMONGO_INVALID_INPUT", true));
  }
  assert.equal(calls.length, 2);
});

test("EDA PayMongo retrieves all refund statuses and verifies mode amount currency association", async () => {
  for (const status of ["pending", "processing", "succeeded", "failed"] as const) {
    const p = createPaymongoProvider({ secret, fetcher: async (url, init) => {
      assert.equal(String(url), "https://api.paymongo.com/v1/refunds/ref_fixture");
      assert.equal(init!.method, "GET");
      assert.equal(new Headers(init!.headers).get("idempotency-key"), null);
      return Response.json(refund({ status }));
    } });
    assert.equal((await p.retrieveRefund("ref_fixture")).status, status);
  }
  for (const attrs of [{ livemode: true }, { currency: "USD" }, { amount: 99 }, { amount: "125050" },
    { status: "unknown" }, { payment_id: "pay_bad/path" }, { payment_id: undefined }]) {
    await assert.rejects(provider(refund(attrs)).retrieveRefund("ref_fixture"), isError("PAYMONGO_INVALID_RESPONSE", false));
  }
  for (const attrs of [{ amount: 100 }, { payment_id: "pay_other" }]) {
    await assert.rejects(provider(refund(attrs)).createRefund(refundInput), isError("PAYMONGO_INVALID_RESPONSE", false));
  }
  const wrongId = refund(); wrongId.data.id = "ref_other";
  await assert.rejects(provider(wrongId).retrieveRefund("ref_fixture"), isError("PAYMONGO_INVALID_RESPONSE", false));
  const wrongType = refund(); wrongType.data.type = "payment";
  await assert.rejects(provider(wrongType).retrieveRefund("ref_fixture"), isError("PAYMONGO_INVALID_RESPONSE", false));
});

test("EDA PayMongo classifies only explicit supported rejection envelopes as definite", async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    await assert.rejects(provider({ errors: [{ code: "parameter_invalid", detail: secret }] }, status).createCheckout(input),
      isError(`PAYMONGO_HTTP_${status}`, true));
    for (const body of [{ errors: [] }, {}, { errors: [{ code: "unrecognized_provider_code" }] },
      { errors: [{ code: "parameter_invalid" }, { code: "resource_processing_error" }] }]) {
      await assert.rejects(provider(body, status).createCheckout(input), isError(`PAYMONGO_HTTP_${status}`, false));
    }
  }
  for (const status of [408, 409, 429, 500, 502, 503]) {
    await assert.rejects(provider({ errors: [{ code: "parameter_invalid" }] }, status).createCheckout(input),
      isError(`PAYMONGO_HTTP_${status}`, false));
  }
});

test("EDA PayMongo ambiguous transport errors are redacted and never retried", async () => {
  let calls = 0;
  const p = createPaymongoProvider({ secret, fetcher: async () => {
    calls++; throw new Error(`network failure containing ${secret} and clinical body`);
  } });
  await assert.rejects(p.createCheckout(input), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "PAYMONGO_TRANSPORT_ERROR"); assert.equal(error.definite, false);
    assert.ok(!String(error.stack).includes(secret)); assert.equal(error.cause, undefined); return true;
  });
  assert.equal(calls, 1);
});

test("EDA PayMongo malformed and oversized receipts are bounded ambiguous outcomes", async () => {
  for (const response of [new Response("not-json"), new Response(null), Response.json({})]) {
    const p = createPaymongoProvider({ secret, fetcher: async () => response });
    await assert.rejects(p.createCheckout(input), isError("PAYMONGO_INVALID_RESPONSE", false));
  }
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(65_537)); },
    cancel() { cancelled = true; } });
  const p = createPaymongoProvider({ secret, fetcher: async () => new Response(stream) });
  await assert.rejects(p.createRefund(refundInput), isError("PAYMONGO_INVALID_RESPONSE", false));
  assert.equal(cancelled, true);
  const errorHtml = createPaymongoProvider({ secret, fetcher: async () => new Response("gateway html", { status: 400 }) });
  await assert.rejects(errorHtml.createCheckout(input), isError("PAYMONGO_HTTP_400", false));
});

test("EDA PayMongo fifteen-second deadline covers fetching and receipt streaming without retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0; let signal: AbortSignal | undefined;
  const p = createPaymongoProvider({ secret, fetcher: async (_url, init) => {
    calls++; signal = init!.signal!;
    return new Promise<Response>(() => undefined);
  } });
  const pending = p.createCheckout(input);
  const rejected = assert.rejects(pending, isError("PAYMONGO_TIMEOUT", false));
  t.mock.timers.tick(15_000);
  await rejected;
  assert.equal(signal!.aborted, true); assert.equal(calls, 1);
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
  const streaming = createPaymongoProvider({ secret, fetcher: async (_url, init) => {
    init!.signal!.addEventListener("abort", () => streamController!.error(new Error("mock transport aborted")));
    return new Response(stream);
  } });
  const bodyPending = streaming.retrieveRefund("ref_fixture");
  const bodyRejected = assert.rejects(bodyPending, isError("PAYMONGO_TIMEOUT", false));
  await new Promise<void>(resolve => queueMicrotask(resolve));
  assert.equal(stream.locked, true);
  t.mock.timers.tick(15_000);
  await bodyRejected;
  await new Promise<void>(resolve => queueMicrotask(resolve));
  assert.equal(stream.locked, false);
});

test("EDA PayMongo propagates numeric and dated Retry-After without write retries", async () => {
  for (const value of ["120", new Date(Date.now() + 180_000).toUTCString(), "not-a-date", "-1"]) {
    let calls = 0;
    const p = createPaymongoProvider({ secret, fetcher: async () => {
      calls++; return Response.json({ errors: [{ code: "too_many_requests" }] }, { status: 429, headers: { "Retry-After": value } });
    } });
    await assert.rejects(p.createRefund(refundInput), error => {
      assert.ok(error instanceof ProviderError); assert.equal(error.definite, false);
      if (value === "120") assert.equal(error.retryAfterSeconds, 120);
      else if (value.includes("GMT")) assert.ok(error.retryAfterSeconds! >= 178);
      else assert.equal(error.retryAfterSeconds, undefined);
      return true;
    });
    assert.equal(calls, 1);
  }
});
