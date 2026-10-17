const assert = require("node:assert/strict");
const test = require("node:test");
const { requireSandboxSecret } = require("../src/payment-sandbox");

test("PayMongo runtime rejects live, public, missing and malformed payment credentials", () => {
  requireSandboxSecret("sk_test_example123");
  for (const key of [undefined, "", "sk_live_example", "pk_test_example", "sk_test_", "sk_test_example\n"]) {
    assert.throws(() => requireSandboxSecret(key), (error) => error.status === 503);
  }
});
