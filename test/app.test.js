const assert = require("node:assert/strict");
const test = require("node:test");
const { createApp } = require("../src/app");
const { internalServiceKey } = require("../src/config");

async function withServer(run) {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("health endpoint identifies the PayMongo service", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.data.service, "vital-services-paymongo");
  });
});

test("PayMongo endpoints reject missing internal service credentials", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/payments/paymongo/checkouts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, internalServiceKey ? 401 : 500);
  });
});
