const test = require("node:test");
const assert = require("node:assert/strict");
const { runPaymentOperation, requestHash } = require("../src/payment-operations");

function createMemoryLedger() {
  const operations = new Map();
  return {
    async claim({ operationKey, operationType, payload }) {
      const existing = operations.get(operationKey);
      if (existing) return { owner: false, operation: existing };
      const operation = {
        operationKey,
        operationType,
        requestHash: requestHash(payload),
        status: "pending",
        result: null,
        error: null,
      };
      operations.set(operationKey, operation);
      return { owner: true, operation };
    },
    async finish(operationKey, status, result, error) {
      const operation = operations.get(operationKey);
      Object.assign(operation, { status, result, error });
      return operation;
    },
  };
}

test("concurrent duplicate checkout executes the provider once", async () => {
  const ledger = createMemoryLedger();
  let providerCalls = 0;
  let releaseProvider;
  const providerGate = new Promise((resolve) => {
    releaseProvider = resolve;
  });
  const execute = async () => {
    providerCalls += 1;
    await providerGate;
    return { checkoutSessionId: "cs_test" };
  };
  const input = {
    ledger,
    operationKey: "checkout:appointment-1",
    operationType: "checkout",
    payload: { appointmentId: "appointment-1", amount: 500 },
    execute,
  };

  const first = runPaymentOperation(input);
  const duplicate = await runPaymentOperation(input);
  assert.equal(duplicate.operationStatus, "pending");
  assert.equal(providerCalls, 1);

  releaseProvider();
  const completed = await first;
  assert.equal(completed.operationStatus, "completed");
  assert.equal(completed.data.checkoutSessionId, "cs_test");

  const replay = await runPaymentOperation(input);
  assert.equal(replay.operationStatus, "completed");
  assert.equal(providerCalls, 1);
});

test("ambiguous provider failures remain unknown", async () => {
  const ledger = createMemoryLedger();
  await assert.rejects(
    runPaymentOperation({
      ledger,
      operationKey: "refund:appointment-1:payment-1",
      operationType: "refund",
      payload: { paymentId: "payment-1", amount: 500 },
      execute: async () => {
        throw new Error("socket timeout");
      },
    }),
    (error) => error.operationStatus === "unknown",
  );
});

test("provider HTTP ambiguity is not permission to repeat checkout or refund", async () => {
  for (const status of [408, 409, 429, 500, 502, 503, 504]) {
    const ledger = createMemoryLedger();
    let calls = 0;
    const input = { ledger, operationKey: `refund:status-${status}`, operationType: "refund", payload: { amount: 500 },
      execute: async () => { calls += 1; const error = new Error("secret provider diagnostics"); error.response = { status }; throw error; } };
    await assert.rejects(runPaymentOperation(input), (error) => error.operationStatus === "unknown");
    const replay = await runPaymentOperation(input);
    assert.equal(replay.operationStatus, "unknown");
    assert.equal(replay.error, "PROVIDER_OUTCOME_UNKNOWN");
    assert.equal(calls, 1);
  }
});

test("definite provider validation rejection is recorded without provider diagnostics", async () => {
  const ledger = createMemoryLedger();
  const input = { ledger, operationKey: "checkout:rejected", operationType: "checkout", payload: { amount: 500 },
    execute: async () => { const error = new Error("secret diagnostics"); error.response = { status: 422 }; throw error; } };
  await assert.rejects(runPaymentOperation(input), (error) => error.operationStatus === "failed");
  assert.equal((await runPaymentOperation(input)).error, "PROVIDER_REQUEST_REJECTED");
});
