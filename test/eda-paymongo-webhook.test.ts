import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { verifyPaymongoWebhook } from "../src/eda/modules/payment/paymongo-webhook.js";
import { schedulePaymongoWebhook } from "../src/eda/modules/payment/payment-store.js";

const now = 1_790_000_000_000;
const secret = "isolated-paymongo-webhook-secret";
const body = (livemode = false, type = "checkout_session.payment.paid") => JSON.stringify({
  data: { id: "evt_test", type: "event", attributes: {
    livemode, type, data: { id: "cs_test", type: "checkout_session" },
  } },
}, null, 2);
function envelope(raw: string, timestamp = now / 1000) {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  return { rawBodyBase64: Buffer.from(raw).toString("base64"), signature: `t=${timestamp},te=${digest},li=` };
}

test("PayMongo verifies original sandbox bytes before reading checkout identity", () => {
  const signed = envelope(body());
  assert.deepEqual(verifyPaymongoWebhook(signed, secret, now), { eventId: "evt_test", checkoutId: "cs_test" });
  assert.equal(verifyPaymongoWebhook(envelope(body(false, "payment.failed")), secret, now), null);
  assert.throws(() => verifyPaymongoWebhook({ ...signed, rawBodyBase64: Buffer.from(body().trim() + "\n").toString("base64") }, secret, now));
  assert.throws(() => verifyPaymongoWebhook(envelope(body(), now / 1000 - 301), secret, now));
  assert.throws(() => verifyPaymongoWebhook(envelope(body(true)), secret, now));
  assert.throws(() => verifyPaymongoWebhook({ ...signed, signature: `${signed.signature},te=duplicate` }, secret, now));
});

test("PayMongo schedules once under concurrent delivery and preserves reconciliation leases", async t => {
  const connectionString = process.env.VITAL_TEST_PAYMONGO_DB_URL;
  if (!connectionString) return t.skip("Requires dedicated loopback PostgreSQL");
  const url = new URL(connectionString);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  assert.equal(url.pathname, "/notification_test");
  const schema = `paymongo_test_${process.pid}`;
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  t.after(async () => {
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await pool.end(); }
  });
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE TABLE payments (
    "checkoutSessionId" text PRIMARY KEY, "billingLineageId" text, "providerMode" text DEFAULT 'sandbox',
    "latestWebhookEventId" text UNIQUE, "paidAt" timestamp, "refundId" text,
    "reconcileFailures" integer DEFAULT 0, status text DEFAULT 'pending', "reviewCode" text,
    "reconcileLeaseUntil" timestamp, "nextReconcileAt" timestamp, "lastReconciledAt" timestamp);
    CREATE TABLE payment_association_holds ("operationId" text, "billingLineageId" text, state text);
    INSERT INTO payments ("checkoutSessionId","billingLineageId","reconcileLeaseUntil")
    VALUES ('cs_1','lineage_1',NULL),('cs_2','lineage_2',timezone('UTC',NOW()) + INTERVAL '1 day')`);
  await Promise.all([
    schedulePaymongoWebhook(pool, "cs_1", "evt_1"),
    schedulePaymongoWebhook(pool, "cs_1", "evt_1"),
  ]);
  await schedulePaymongoWebhook(pool, "cs_1", "evt_duplicate");
  await schedulePaymongoWebhook(pool, "cs_2", "evt_2");
  const { rows } = await pool.query(`SELECT "latestWebhookEventId" AS event,
    "nextReconcileAt" IS NOT NULL AS scheduled, "paidAt" IS NOT NULL AS paid
    FROM payments ORDER BY "checkoutSessionId"`);
  assert.deepEqual(rows, [{ event: "evt_1", scheduled: true, paid: false }, { event: "evt_2", scheduled: false, paid: false }]);
});
