import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request as httpsRequest } from 'node:https';
import type { TestContext } from 'node:test';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '../../src/eda/generated/core/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { createEdaApp } from '../../src/eda/http/app.js';
import { createMessagingModule } from '../../src/eda/modules/messaging/messages.js';
import { createMessageHolds } from '../../src/eda/modules/messaging/holds.js';
import { requestHash } from '../../src/eda/infrastructure/security.js';
import { envelopeFromRow, type OutboxRow } from '../../src/eda/infrastructure/outbox.js';
import { publishConfirmed } from '../../src/eda/infrastructure/broker.js';
import { consumeMessagingEvent } from '../../src/eda/workers/messaging.js';
import { parseEvent } from '../../src/eda/contracts/events.js';
import { fixture, type Context } from './payment-live.js';

export function messagingLiveConfiguration(environment: NodeJS.ProcessEnv) {
  if (environment.EDA_TEST_MESSAGING_ENABLED === undefined || environment.EDA_TEST_MESSAGING_ENABLED === 'false') return false;
  if (environment.EDA_TEST_MESSAGING_ENABLED !== 'true' || environment.EDA_TEST_ENABLED !== 'true' || environment.EDA_TEST_ISOLATED !== 'yes') throw new Error('MESSAGING_TEST_ISOLATION_REQUIRED');
  for (const domain of ['core', 'integrations']) {
    const url = new URL(environment['EDA_TEST_' + domain.toUpperCase() + '_DATABASE_URL'] ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'postgres' || (url.port || '5432') !== '5432' ||
      url.pathname !== '/vital_' + domain + '_test' || decodeURIComponent(url.username) !== 'vital_' + domain + '_worker' || !url.password || url.search || url.hash) throw new Error('MESSAGING_TEST_SHARED_TARGET_DENIED');
  }
  return true;
}
const environment = { MESSAGE_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 42).toString('base64') }), MESSAGE_ACTIVE_KEY_VERSION: '1' };
async function messagingFixture<T>(context: Context, run: (f: Parameters<Parameters<typeof fixture>[1]>[0]) => Promise<T>) {
  return fixture(context, async f => {
    try { return await run(f); }
    finally {
      const conversations = (await context.core.query('SELECT id FROM message_conversations WHERE "appointmentId"=$1', [f.appointmentId])).rows.map(row => row.id);
      const facts = (await context.core.query('SELECT id FROM outbox_events WHERE "aggregateId"=ANY($1::text[])', [conversations])).rows.map(row => row.id);
      await context.core.query('DELETE FROM inbox_events WHERE "consumerId" IN (\'messaging-state\',\'messaging-appointment\') AND "eventId"=ANY($1::text[])', [facts]);
      await context.core.query('DELETE FROM outbox_events WHERE "aggregateId"=ANY($1::text[])', [conversations]);
      await context.core.query('DELETE FROM message_legal_holds WHERE "conversationId"=ANY($1::text[])', [conversations]);
      await context.core.query('DELETE FROM message_purges WHERE "conversationId"=ANY($1::text[])', [conversations]);
      await context.core.query('DELETE FROM message_conversations WHERE "appointmentId"=$1', [f.appointmentId]);
      await context.core.query('DELETE FROM messaging_eligibility_sources WHERE "appointmentId"=$1', [f.appointmentId]);
    }
  });
}
export async function messagingLiveScenarios(t: TestContext, context: Context) {
  await t.test('EDA Messaging real PostgreSQL duplicate sends and broker inbox commit once', () => messagingFixture(context, async f => {
    const messages = createMessagingModule(context.core, environment), actor = { ...f.actor, scopes: ['messaging.send'] }, id = randomUUID();
    const body = { content: 'isolated test message', clientMessageId: id }, meta = { operationId: id, requestHash: 'a'.repeat(64) };
    const results = await Promise.all([messages.send(actor, f.appointmentId, meta, body), messages.send(actor, f.appointmentId, meta, body)]);
    assert.equal(results.filter(result => result.created).length, 1);
    assert.equal((await context.core.query('SELECT 1 FROM appointment_messages WHERE "senderUserId"=$1', [f.patientId])).rowCount, 1);
    const row = (await context.core.query<OutboxRow>('SELECT * FROM outbox_events WHERE "eventType"=$1 AND "aggregateId"=(SELECT id FROM message_conversations WHERE "appointmentId"=$2)', ['vital.messaging.changed', f.appointmentId])).rows[0]!;
    const event = envelopeFromRow(row);
    assert.doesNotMatch(JSON.stringify(event), /isolated test message|ciphertext/);
    await publishConfirmed(context.publisher, context.exchange, 'routed', event);
    const delivery = await context.channel.get(context.queue, { noAck: false }); assert.ok(delivery);
    const received = parseEvent(JSON.parse(delivery.content.toString('utf8')));
    await Promise.all([consumeMessagingEvent(context.core, received, 'messaging-state'), consumeMessagingEvent(context.core, received, 'messaging-state')]);
    context.channel.ack(delivery);
    assert.equal((await context.core.query('SELECT 1 FROM inbox_events WHERE "consumerId"=$1 AND "eventId"=$2', ['messaging-state', event.eventId])).rowCount, 1);
  }));
  await t.test('EDA Messaging real process mTLS binds patient body resource scope and audience', () => messagingFixture(context, async f => {
    const prisma = new PrismaClient({ adapter: new PrismaPg(context.core, { disposeExternalPool: false }) }), keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const messages = createMessagingModule(context.core, environment);
    const app = createEdaApp(prisma, { issuer: 'vital-web', audience: 'vital-services', peerName: 'vital-web', keyId: 'test', publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString() },
      false, undefined, undefined, undefined, undefined, undefined, { messages, holds: createMessageHolds(context.core, environment), retentionTick: async () => undefined });
    const server = createServer({ key: readFileSync(context.certs.apiKey), cert: readFileSync(context.certs.apiCert), ca: readFileSync(context.certs.serviceCa), requestCert: true, rejectUnauthorized: true }, app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port, path = '/internal/v1/messaging/appointments/' + f.appointmentId + '/messages';
    function call(cert = true, audience = 'vital-services', scope = 'messaging.send', resource = f.appointmentId, substitute = false) {
      const id = randomUUID(), body = { content: 'isolated TLS body', clientMessageId: id };
      const token = jwt.sign({ actor: { ...f.actor, scopes: [scope], resource }, action: 'POST ' + path, requestHash: requestHash('POST', path, body) }, keys.privateKey,
        { algorithm: 'RS256', keyid: 'test', issuer: 'vital-web', audience, subject: f.actor.authId, jwtid: id, expiresIn: 30 });
      return new Promise<number>((resolve, reject) => {
        const request = httpsRequest({ host: '127.0.0.1', port, servername: 'vital-api.test', method: 'POST', path, ca: readFileSync(context.certs.serviceCa),
          ...(cert ? { key: readFileSync(context.certs.webKey), cert: readFileSync(context.certs.webCert) } : {}), headers: { 'Content-Type': 'application/json', 'X-Vital-Actor-Assertion': token } },
        response => { response.resume(); response.once('end', () => resolve(response.statusCode ?? 0)); });
        request.setTimeout(5000, () => request.destroy(new Error('MESSAGING_TEST_TLS_TIMEOUT'))); request.once('error', reject);
        request.end(JSON.stringify({ ...body, content: substitute ? 'substitution' : body.content }));
      });
    }
    try {
      await assert.rejects(call(false)); assert.equal(await call(true, 'wrong-audience'), 401);
      assert.equal(await call(true, 'vital-services', 'messaging.read'), 403);
      assert.equal(await call(true, 'vital-services', 'messaging.send', randomUUID()), 403);
      assert.equal(await call(true, 'vital-services', 'messaging.send', f.appointmentId, true), 401);
      assert.equal(await call(), 201);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await prisma.$disconnect(); }
  }));
}
