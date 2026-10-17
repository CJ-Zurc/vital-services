import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request as httpsRequest } from "node:https";
import type { TestContext } from "node:test";
import type { Pool } from "pg";
import type { Channel, ConfirmChannel } from "amqplib";
import jwt from "jsonwebtoken";
import { PrismaClient } from "../../src/eda/generated/core/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { createBillingAuthority, readPaymentProjectionAppointment } from "../../src/eda/modules/appointment/appointment-billing.js";
import { createPaymentModule } from "../../src/eda/modules/payment/payment.js";
import { createPaymentStore } from "../../src/eda/modules/payment/payment-store.js";
import { createPaymongoProvider } from "../../src/eda/modules/payment/payment-provider.js";
import { envelopeFromRow, type OutboxRow } from "../../src/eda/infrastructure/outbox.js";
import { requestHash } from "../../src/eda/infrastructure/security.js";
import { publishConfirmed } from "../../src/eda/infrastructure/broker.js";
import { consumePayment } from "../../src/eda/workers/handlers.js";
import { parseEvent } from "../../src/eda/contracts/events.js";
import { createEdaApp } from "../../src/eda/http/app.js";

export interface Context { core: Pool; integrations: Pool; exchange: string; queue: string; channel: Channel; publisher: ConfirmChannel;
  certs: { serviceCa: string; apiCert: string; apiKey: string; webCert: string; webKey: string } }
export async function fixture<T>(context: Context, run: (value: ReturnType<typeof setup>) => Promise<T>) {
  const value = setup(context);
  const { core, integrations } = context;
  try {
    await core.query(`INSERT INTO vital_users (id,"authId",role) VALUES ($1,$2,'patient'),($3,$4,'doctor')`,
      [value.patientId, value.actor.authId, value.doctorId, value.doctorAuthId]);
    await core.query(`INSERT INTO vital_patients ("userId","authId") VALUES ($1,$2)`, [value.patientId, value.actor.authId]);
    await core.query(`INSERT INTO vital_doctors ("userId","authId",role,"virtualFee") VALUES ($1,$2,'doctor',500.00)`, [value.doctorId, value.doctorAuthId]);
    await core.query(`INSERT INTO appointments (id,"patientId","doctorId",status,"scheduledAt","updatedAt","billingLineageId")
      VALUES ($1,$2,$3,'approved',NOW()+INTERVAL '2 days',NOW(),$4)`, [value.appointmentId, value.patientId, value.doctorId, value.lineage]);
    return await run(value);
  } finally {
    const appointments=(await core.query('SELECT id FROM appointments WHERE "billingLineageId"=$1',[value.lineage])).rows.map(row=>row.id);
    const calendar=(await core.query('SELECT id FROM schedules WHERE "doctorId"=$1 UNION ALL SELECT id FROM doctor_date_blocks WHERE doctor_id=$1',[value.doctorId])).rows.map(row=>row.id);
    const payments = (await integrations.query('SELECT id FROM payments WHERE "billingLineageId"=$1', [value.lineage])).rows.map(row => row.id);
    await integrations.query('DELETE FROM payment_association_holds WHERE "billingLineageId"=$1',[value.lineage]);
    await integrations.query('DELETE FROM invoices WHERE "paymentId"=ANY($1::text[])', [payments]);
    await integrations.query('DELETE FROM payment_operations WHERE "paymentId"=ANY($1::text[])', [payments]);
    await integrations.query('DELETE FROM command_operations WHERE "actorId"=$1', [value.actor.authId]);
    const facts = (await integrations.query('SELECT id FROM outbox_events WHERE "aggregateId"=ANY($1::text[])', [payments])).rows.map(row => row.id);
    await core.query('DELETE FROM inbox_events WHERE "consumerId"=$1 AND "eventId"=ANY($2::text[])', ['appointment-payment', facts]);
    await core.query('DELETE FROM inbox_events WHERE "consumerId"=$1 AND "eventId"=ANY($2::text[])', ['appointment-confirmation', facts]);
    await integrations.query('DELETE FROM outbox_events WHERE "aggregateId"=ANY($1::text[])', [payments]);
    await integrations.query('DELETE FROM payments WHERE "billingLineageId"=$1', [value.lineage]);
    await core.query('DELETE FROM outbox_events WHERE "aggregateId"=ANY($1::text[]) OR "aggregateId"=$2', [[...appointments,...calendar],value.lineage]);
    await core.query('DELETE FROM command_operations WHERE "actorId"=ANY($1::text[])', [[value.actor.authId,value.doctorAuthId]]);
    await core.query('DELETE FROM appointment_payment_projections WHERE "appointmentId"=ANY($1::text[])', [appointments]);
    await core.query('DELETE FROM appointment_billing_intents WHERE "appointmentId"=ANY($1::text[])', [appointments]);
    await core.query('DELETE FROM appointment_billing_quotes WHERE "billingLineageId"=$1', [value.lineage]);
    await core.query('DELETE FROM appointment_workflows WHERE "appointmentId"=ANY($1::text[])', [appointments]);
    await core.query('DELETE FROM slot_reservations WHERE "doctorId"=$1',[value.doctorId]);
    await core.query('DELETE FROM saga_operations WHERE "billingLineageId"=$1',[value.lineage]);
    await core.query('DELETE FROM appointment_logs WHERE "appointmentId"=ANY($1::text[])',[appointments]);
    await core.query('DELETE FROM appointments WHERE id=ANY($1::text[])', [appointments]);
    await core.query('DELETE FROM schedules WHERE "doctorId"=$1',[value.doctorId]);
    await core.query('DELETE FROM vital_patients WHERE "userId"=$1', [value.patientId]);
    await core.query('DELETE FROM vital_doctors WHERE "userId"=$1', [value.doctorId]);
    await core.query('DELETE FROM vital_users WHERE id=ANY($1::text[])', [[value.patientId, value.doctorId]]);
  }
}
function setup(context: Context) {
  const patientId = randomUUID(), doctorId = randomUUID(), doctorAuthId = randomUUID(), appointmentId = randomUUID(), lineage = randomUUID();
  const actor = { authId: randomUUID(), role: "patient" as const, serviceId: "vital-web" as const, scopes: ["payments.checkout"],
    resource: appointmentId, correlationId: randomUUID(), isSuperAdmin: false };
  const store = createPaymentStore(context.integrations);
  let paid = false, writes = 0, afterProvider: (() => void) | undefined;
  const providerId = `cs_${randomUUID().replaceAll("-", "")}`;
  const provider = createPaymongoProvider({ secret: "sk_test_fixture", fetcher: async (_url, request) => {
    if (request?.method === "POST") { writes++; afterProvider?.(); }
    return Response.json({ data: { id: providerId, type: "checkout_session", attributes: { livemode: false, status: "active",
      checkout_url: `https://checkout.paymongo.com/${providerId}`, line_items: [{ amount: 50000, quantity: 1, currency: "PHP" }],
      metadata: { appointment_id: appointmentId, billing_lineage_id: lineage },
      payments: paid ? [{ id: "pay_fixture", type: "payment", attributes: { amount: 50000, currency: "PHP", livemode: false,
        status: "paid", paid_at: Math.floor(Date.now() / 1000) } }] : [] } } });
  } });
  const billing = createBillingAuthority(context.core);
  const module = createPaymentModule({ store, billing, provider, enabled: true, appOrigin: "https://vital.test" });
  return { patientId, doctorId, doctorAuthId, appointmentId, lineage, actor, store, provider, billing, module,
    pay: () => { paid = true; }, writes: () => writes, setAfterProvider: (callback: () => void) => { afterProvider = callback; } };
}
export async function paymentLiveScenarios(t: TestContext, context: Context) {
  await t.test("EDA Payment real PostgreSQL claims quote and provider once and RabbitMQ projects without confirmation", () => fixture(context, async f => {
    const metadata = { operationId: randomUUID(), requestHash: "a".repeat(64) };
    await Promise.all([f.module.checkout(f.actor, f.appointmentId, metadata), f.module.checkout(f.actor, f.appointmentId, metadata)]);
    assert.equal(f.writes(), 1);
    await context.core.query('UPDATE vital_doctors SET "virtualFee"=900 WHERE "userId"=$1', [f.doctorId]);
    const retry = await f.module.checkout(f.actor, f.appointmentId, { ...metadata, operationId: randomUUID() });
    assert.equal(retry.payment?.amount, "500.00"); assert.equal(f.writes(), 1);
    f.pay(); await f.module.reconcile({ ...f.actor, scopes: ["payments.reconcile"] }, f.appointmentId, { ...metadata, operationId: randomUUID() });
    const row = await f.store.byAppointment(f.appointmentId); assert.ok(row);
    const fact = (await context.integrations.query<OutboxRow>('SELECT * FROM outbox_events WHERE "aggregateId"=$1 AND "eventType"=$2',
      [row.id, "vital.payment.completed"])).rows[0]; assert.ok(fact);
    const event = envelopeFromRow(fact);
    await publishConfirmed(context.publisher, context.exchange, "routed", event);
    const delivered = await context.channel.get(context.queue, { noAck: false }); assert.ok(delivered);
    const received = parseEvent(JSON.parse(delivered.content.toString())); assert.equal(received.eventId, event.eventId);
    await Promise.all([consumePayment(context.core, context.integrations, received, readPaymentProjectionAppointment),
      consumePayment(context.core, context.integrations, received, readPaymentProjectionAppointment)]);
    context.channel.ack(delivered);
    assert.equal((await context.core.query('SELECT status FROM appointments WHERE id=$1', [f.appointmentId])).rows[0].status, "approved");
    assert.equal((await context.core.query('SELECT 1 FROM appointment_logs WHERE "appointmentId"=$1', [f.appointmentId])).rowCount, 0);
    assert.equal((await context.core.query('SELECT status,"reviewRequired" FROM appointment_payment_projections WHERE "appointmentId"=$1', [f.appointmentId])).rows[0].status, "paid");
  }));
  await t.test("EDA Payment real PostgreSQL provider success rollback leaves unknown execution and no repeat", () => fixture(context, async f => {
    let fail = false;
    const store = { ...f.store, transaction: <T>(lineage: string, run: Parameters<typeof f.store.transaction<T>>[1]) => f.store.transaction(lineage, async tx => {
      const result = await run(tx); if (fail) { fail = false; throw new Error("ISOLATED_COMMIT_ABORT"); } return result;
    }) };
    f.setAfterProvider(() => { fail = true; });
    const module = createPaymentModule({ store, billing: f.billing, provider: f.provider, enabled: true, appOrigin: "https://vital.test" });
    const command = () => ({ operationId: randomUUID(), requestHash: "a".repeat(64) });
    assert.equal((await module.checkout(f.actor, f.appointmentId, command())).operationStatus, "unknown");
    assert.equal((await module.checkout(f.actor, f.appointmentId, command())).operationStatus, "unknown"); assert.equal(f.writes(), 1);
    const op = (await context.integrations.query('SELECT status,"executionStartedAt" FROM payment_operations WHERE "paymentId"=$1',
      [(await f.store.byAppointment(f.appointmentId))!.id])).rows[0]; assert.equal(op.status, "unknown"); assert.ok(op.executionStartedAt);
  }));
  await t.test("EDA Payment actual mTLS hop binds patient command body audience and appointment resource", () => fixture(context, async f => {
    const prisma = new PrismaClient({ adapter: new PrismaPg(context.core, { disposeExternalPool: false }) });
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const app = createEdaApp(prisma, { issuer: "vital-web", audience: "vital-services", peerName: "vital-web", keyId: "test",
      publicKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString() }, false, undefined, f.module);
    const server = createServer({ key: readFileSync(context.certs.apiKey), cert: readFileSync(context.certs.apiCert),
      ca: readFileSync(context.certs.serviceCa), requestCert: true, rejectUnauthorized: true }, app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as { port: number }).port;
    const path = `/internal/v1/payments/appointments/${f.appointmentId}/checkout`;
    const call = (cert: boolean, audience = "vital-services", resource = f.appointmentId, body = "{}") => {
      const token = jwt.sign({ actor: { ...f.actor, resource }, action: `POST ${path}`, requestHash: requestHash("POST", path, JSON.parse(body)) },
        keys.privateKey, { algorithm: "RS256", keyid: "test", issuer: "vital-web", audience, subject: f.actor.authId, jwtid: randomUUID(), expiresIn: 30 });
      return new Promise<number>((resolve, reject) => {
        const request = httpsRequest({ host: "127.0.0.1", port, servername: "vital-api.test", method: "POST", path,
          ca: readFileSync(context.certs.serviceCa), ...(cert ? { key: readFileSync(context.certs.webKey), cert: readFileSync(context.certs.webCert) } : {}),
          headers: { "X-Vital-Actor-Assertion": token, "Content-Type": "application/json" }, rejectUnauthorized: true }, response => {
          response.resume(); response.once("end", () => resolve(response.statusCode ?? 0));
        }); request.setTimeout(5000, () => request.destroy(new Error("TEST_TLS_TIMEOUT"))); request.once("error", reject); request.end(body);
      });
    };
    try {
      await assert.rejects(call(false)); assert.equal(await call(true, "wrong-audience"), 401);
      assert.equal(await call(true, "vital-services", randomUUID()), 403);
      assert.equal(await call(true, "vital-services", f.appointmentId, '{"amount":1}'), 400);
      assert.equal(await call(true), 200); assert.equal(f.writes(), 1);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await prisma.$disconnect(); }
  }));
}
