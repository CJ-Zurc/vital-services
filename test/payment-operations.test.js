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
