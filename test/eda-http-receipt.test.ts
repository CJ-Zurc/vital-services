import assert from "node:assert/strict";
import test from "node:test";
import { boundedJsonReceipt } from "../src/eda/infrastructure/http-receipt.js";

test("EDA shared delivery receipt reader bounds and cancels oversized streaming responses", async () => {
  assert.deepEqual(await boundedJsonReceipt(Response.json({ status: "accepted" })), { status: "accepted" });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(65_537)); },
    cancel() { cancelled = true; } });
  await assert.rejects(boundedJsonReceipt(new Response(body)), /DELIVERY_RECEIPT_TOO_LARGE/);
  assert.equal(cancelled, true);
  await assert.rejects(boundedJsonReceipt(new Response("not-json")));
  await assert.rejects(boundedJsonReceipt(new Response(null)), /DELIVERY_RECEIPT_MISSING/);
});
