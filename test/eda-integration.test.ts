import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import amqp from 'amqplib';
import { appendSqlOutbox, claimOutbox, dispatchOutbox, makeEvent, markPublished, processWithInbox } from '../src/eda/infrastructure/outbox.js';
import { parseEvent } from '../src/eda/contracts/events.js';
import { publishConfirmed } from '../src/eda/infrastructure/broker.js';
import { consumeProfileSync, getProfileSyncStatuses } from '../src/eda/modules/profile/profile-delivery.js';
import { requestHash } from '../src/eda/infrastructure/security.js';
import { createServer, request as httpsRequest } from 'node:https';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '../src/eda/generated/core/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { createEdaApp } from '../src/eda/http/app.js';
import { paymentLiveScenarios } from './helpers/payment-live.js';
import { appointmentLiveScenarios } from './helpers/appointment-live.js';
import { recordsLiveScenarios,recordsLiveConfiguration } from './helpers/records-live.js';
import { videoLiveScenarios,videoLiveConfiguration } from './helpers/video-live.js';
import { messagingLiveScenarios, messagingLiveConfiguration } from './helpers/messaging-live.js';
import { remainingOwnersLiveScenarios } from './helpers/remaining-owners-live.js';
import { utcPgTypes,configureUtcDateParameters } from '../src/eda/infrastructure/utc-types.js';

// Never import dotenv or createDatabases: the runtime DB names are deliberately forbidden here.
function configuration(environment: NodeJS.ProcessEnv) {
  if (environment.EDA_TEST_ENABLED !== 'true' || environment.EDA_TEST_ISOLATED !== 'yes') {
    throw new Error('Integration tests require EDA_TEST_ENABLED=true and EDA_TEST_ISOLATED=yes.');
  }
  function required(name: string) {
    const value = environment[name];
    if (!value) throw new Error(`Missing isolated integration configuration: ${name}`);
    return value;
  }
  function database(domain: 'core' | 'integrations') {
    const value = required(`EDA_TEST_${domain.toUpperCase()}_DATABASE_URL`);
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'postgres' ||
        (url.port || '5432') !== '5432' || url.pathname !== `/vital_${domain}_test` ||
        decodeURIComponent(url.username) !== `vital_${domain}_worker` || !url.password || url.search || url.hash) {
      throw new Error('Refusing non-isolated database target or runtime identity.');
    }
    return value;
  }
  function broker(provision: boolean) {
    const value = required(provision ? 'EDA_TEST_RABBITMQ_PROVISION_URL' : 'EDA_TEST_RABBITMQ_URL');
    const url = new URL(value);
    if (url.protocol !== 'amqps:' || url.hostname !== 'rabbitmq' || (url.port || '5671') !== '5671' ||
        decodeURIComponent(url.pathname) !== '/vital_test' || !url.password || url.search || url.hash ||
        decodeURIComponent(url.username) !== (provision ? 'vital_provision' : 'vital_runtime')) {
      throw new Error('Refusing non-isolated AMQPS vhost or identity.');
    }
    return value;
  }
  return {
    core: database('core'), integrations: database('integrations'),
    runtime: broker(false), provision: broker(true),
    databaseCa: required('EDA_TEST_DATABASE_CA_FILE'), brokerCa: required('EDA_TEST_RABBITMQ_CA_FILE'),
    serviceCa: required('EDA_TEST_SERVICE_CA_FILE'), apiCert: required('EDA_TEST_API_CERT_FILE'),
    apiKey: required('EDA_TEST_API_KEY_FILE'), webCert: required('EDA_TEST_WEB_CERT_FILE'), webKey: required('EDA_TEST_WEB_KEY_FILE'),
  };
}

test('EDA integration configuration rejects missing opt-in, shared databases and broker targets', () => {
  const valid = {
    EDA_TEST_ENABLED: 'true', EDA_TEST_ISOLATED: 'yes',
    EDA_TEST_CORE_DATABASE_URL: 'postgresql://vital_core_worker:test@postgres:5432/vital_core_test',
    EDA_TEST_INTEGRATIONS_DATABASE_URL: 'postgresql://vital_integrations_worker:test@postgres:5432/vital_integrations_test',
    EDA_TEST_RABBITMQ_URL: 'amqps://vital_runtime:test@rabbitmq:5671/vital_test',
    EDA_TEST_RABBITMQ_PROVISION_URL: 'amqps://vital_provision:test@rabbitmq:5671/vital_test',
    EDA_TEST_DATABASE_CA_FILE: 'placeholder-ca', EDA_TEST_RABBITMQ_CA_FILE: 'placeholder-ca',
    EDA_TEST_SERVICE_CA_FILE: 'placeholder-ca', EDA_TEST_API_CERT_FILE: 'placeholder-cert', EDA_TEST_API_KEY_FILE: 'placeholder-key',
    EDA_TEST_WEB_CERT_FILE: 'placeholder-cert', EDA_TEST_WEB_KEY_FILE: 'placeholder-key',
  };
  assert.doesNotThrow(() => configuration(valid));
  for (const key of Object.keys(valid)) {
    assert.throws(() => configuration({ ...valid, [key]: undefined }));
  }
  for (const target of [
    'postgresql://vital_core_worker:test@postgres:5432/vital_core',
    'postgresql://postgres:test@postgres:5432/vital_core_test',
    'postgresql://vital_core_worker:test@shared-db:5432/vital_core_test',
    'postgresql://vital_core_worker:test@postgres:5432/vital_core_test?sslmode=disable',
  ]) assert.throws(() => configuration({ ...valid, EDA_TEST_CORE_DATABASE_URL: target }));
  for (const target of [
    'amqps://vital_runtime:test@rabbitmq:5671/vital',
    'amqp://vital_runtime:test@rabbitmq:5672/vital_test',
    'amqps://guest:test@rabbitmq:5671/vital_test',
    'amqps://vital_runtime:test@shared-broker:5671/vital_test',
  ]) assert.throws(() => configuration({ ...valid, EDA_TEST_RABBITMQ_URL: target }));
});

test('EDA Video isolated scenarios require explicit opt-in and reject shared runtime databases',()=>{
  assert.equal(videoLiveConfiguration({}),false);assert.equal(videoLiveConfiguration({EDA_TEST_VIDEO_ENABLED:'false'}),false);
  assert.throws(()=>videoLiveConfiguration({EDA_TEST_VIDEO_ENABLED:'true'}));
  const valid={EDA_TEST_VIDEO_ENABLED:'true',EDA_TEST_ENABLED:'true',EDA_TEST_ISOLATED:'yes',EDA_TEST_CORE_DATABASE_URL:'postgresql://vital_core_worker:test@postgres:5432/vital_core_test',EDA_TEST_INTEGRATIONS_DATABASE_URL:'postgresql://vital_integrations_worker:test@postgres:5432/vital_integrations_test'};
  assert.equal(videoLiveConfiguration(valid),true);assert.throws(()=>videoLiveConfiguration({...valid,EDA_TEST_CORE_DATABASE_URL:'postgresql://vital_core_worker:test@postgres:5432/vital_core'}));
  assert.throws(()=>videoLiveConfiguration({...valid,EDA_TEST_INTEGRATIONS_DATABASE_URL:'postgresql://postgres:test@postgres:5432/vital_integrations_test'}));
});

test('EDA Messaging isolated scenarios deny implicit activation and shared database targets', () => {
  assert.equal(messagingLiveConfiguration({}), false);
  assert.throws(() => messagingLiveConfiguration({ EDA_TEST_MESSAGING_ENABLED: 'true' }));
  const valid = { EDA_TEST_MESSAGING_ENABLED: 'true', EDA_TEST_ENABLED: 'true', EDA_TEST_ISOLATED: 'yes',
    EDA_TEST_CORE_DATABASE_URL: 'postgresql://vital_core_worker:test@postgres:5432/vital_core_test', EDA_TEST_INTEGRATIONS_DATABASE_URL: 'postgresql://vital_integrations_worker:test@postgres:5432/vital_integrations_test' };
  assert.equal(messagingLiveConfiguration(valid), true);
  assert.throws(() => messagingLiveConfiguration({ ...valid, EDA_TEST_CORE_DATABASE_URL: 'postgresql://vital_core_worker:test@shared:5432/vital_core' }));
});

test('EDA Records isolated configuration refuses shared databases storage roots and implicit scanner activation',()=>{
  assert.equal(recordsLiveConfiguration({}),undefined);
  assert.throws(()=>recordsLiveConfiguration({EDA_TEST_RECORDS_ARTIFACTS_ENABLED:'true'}));
  assert.throws(()=>recordsLiveConfiguration({EDA_TEST_RECORDS_ENABLED:'yes'}));
  const valid={EDA_TEST_RECORDS_ENABLED:'true',EDA_TEST_ENABLED:'true',EDA_TEST_ISOLATED:'yes',EDA_TEST_CORE_MIGRATOR_URL:'postgresql://vital_core_migrator:test@postgres:5432/vital_core_test',EDA_TEST_DATABASE_CA_FILE:'fixture-only'};
  assert.doesNotThrow(()=>recordsLiveConfiguration(valid));
  for(const target of ['postgresql://vital_core_migrator:test@postgres:5432/vital_core','postgresql://postgres:test@postgres:5432/vital_core_test','postgresql://vital_core_migrator:test@shared:5432/vital_core_test'])assert.throws(()=>recordsLiveConfiguration({...valid,EDA_TEST_CORE_MIGRATOR_URL:target}));
  const artifact={...valid,EDA_TEST_RECORDS_ARTIFACTS_ENABLED:'true',EDA_TEST_RECORDS_STORAGE_ENDPOINT:'http://minio:9000',EDA_TEST_RECORDS_STORAGE_BUCKET:'vital-records-test',EDA_TEST_RECORDS_STORAGE_ACCESS_KEY:'vital_records_test',EDA_TEST_RECORDS_STORAGE_SECRET_KEY:'isolated-runtime',EDA_TEST_RECORDS_STORAGE_CLEANUP_ACCESS_KEY:'vital_records_test_cleanup',EDA_TEST_RECORDS_STORAGE_CLEANUP_SECRET_KEY:'isolated-cleanup',EDA_TEST_RECORDS_CLAMAV_SOCKET:'/run/records-test/clamd.sock',EDA_TEST_RECORDS_CLAMAV_CONFIG:'/run/records-test/clamd.conf'};
  assert.doesNotThrow(()=>recordsLiveConfiguration(artifact));
  for(const change of [{EDA_TEST_RECORDS_STORAGE_ENDPOINT:'http://shared:9000'},{EDA_TEST_RECORDS_STORAGE_BUCKET:'vital-records'},{EDA_TEST_RECORDS_STORAGE_ACCESS_KEY:'minioadmin'},{EDA_TEST_RECORDS_STORAGE_CLEANUP_SECRET_KEY:'isolated-runtime'},{EDA_TEST_RECORDS_CLAMAV_SOCKET:'tcp://clamav:3310'}])assert.throws(()=>recordsLiveConfiguration({...artifact,...change}));
});

function event() {
  return makeEvent({ producer: 'profile', eventType: 'vital.profile.changed', aggregateId: randomUUID(),
    aggregateVersion: 1, correlationId: randomUUID(), data: { authId: randomUUID(), role: 'patient',
      operation: 'profile_updated', actorAuthId: randomUUID() } });
}

test('EDA isolated PostgreSQL and RabbitMQ integration', {
  skip: (process.env.EDA_TEST_ENABLED === undefined && !process.env.CI) || process.env.EDA_TEST_ENABLED === 'false'
    ? 'Opt-in integration is disabled; no database or broker connection was attempted.' : false,
  timeout: 120_000,
}, async t => {
  // Any other supplied enable value fails, as do all missing enabled-run settings.
  const config = configuration(process.env);
  configureUtcDateParameters();
  const pools: pg.Pool[] = [];
  const connections: Awaited<ReturnType<typeof amqp.connect>>[] = [];
  const ids: string[] = [];
  const consumers: string[] = [];
  const prefix = `vital.test.${randomUUID()}`;
  let exchangeCreated = false;
  let queueCreated = false;
  let forbiddenCreated = false;
  let provisionChannel: Awaited<ReturnType<Awaited<ReturnType<typeof amqp.connect>>['createChannel']>> | undefined;
  try {
    for (const connectionString of [config.core, config.integrations]) {
      const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000,types:utcPgTypes,options:'-c timezone=UTC',
        statement_timeout: 5000, query_timeout: 6000, ssl: { ca: readFileSync(config.databaseCa, 'utf8'), rejectUnauthorized: true } });
      pools.push(pool);
      await pool.query('SELECT 1');
      const baseline = await pool.query('SELECT (SELECT count(*) FROM inbox_events) AS inbox, (SELECT count(*) FROM outbox_events) AS outbox');
      assert.deepEqual(baseline.rows[0], { inbox: '0', outbox: '0' }, 'Use a clean dedicated test project, never existing work queues.');
    }
    const tls = { ca: [readFileSync(config.brokerCa)], rejectUnauthorized: true, timeout: 5000 };
    const provision = await amqp.connect(config.provision, tls);
    connections.push(provision);
    const runtime = await amqp.connect(config.runtime, tls);
    connections.push(runtime);
    provisionChannel = await provision.createChannel();
    const exchange = `${prefix}.events`;
    const queue = `${prefix}.queue`;
    await provisionChannel.assertExchange(exchange, 'direct', { durable: false });
    exchangeCreated = true;
    await provisionChannel.assertQueue(queue, { durable: true, arguments: { 'x-queue-type': 'quorum',
      'x-quorum-initial-group-size': 1, 'x-max-length': 100, 'x-max-length-bytes': 1_048_576, 'x-overflow': 'reject-publish' } });
    queueCreated = true;
    await provisionChannel.bindQueue(queue, exchange, 'routed');
    const publisher = await runtime.createConfirmChannel();
    publisher.on('error', () => undefined);

    await t.test('EDA PostgreSQL runtime roles cannot DDL or connect across databases', async () => {
      for (const [index, pool] of pools.entries()) {
        const other = index === 0 ? 'vital_integrations_test' : 'vital_core_test';
        const result = await pool.query(`SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls,
          has_database_privilege(current_user, current_database(), 'CREATE') AS db_create,
          has_database_privilege(current_user, $1, 'CONNECT') AS cross_connect,
          has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create
          FROM pg_roles WHERE rolname = current_user`, [other]);
        assert.equal(result.rowCount, 1);
        assert.ok(Object.values(result.rows[0]).every(value => value === false));
        await assert.rejects(pool.query(`CREATE TABLE public.eda_forbidden_${index} (id int)`), { code: '42501' });
      }
    });

    await t.test('EDA PostgreSQL inbox rolls back atomically and deduplicates committed effects', async () => {
      for (const pool of pools) {
        const source = event();
        const effect = event();
        const consumer = `test-${randomUUID()}`;
        ids.push(effect.eventId);
        consumers.push(consumer);
        await assert.rejects(processWithInbox(pool, consumer, source, async tx => {
          await appendSqlOutbox(tx, effect);
          throw new Error('INJECTED_FAILURE');
        }), /INJECTED_FAILURE/);
        assert.equal((await pool.query('SELECT 1 FROM inbox_events WHERE "consumerId"=$1', [consumer])).rowCount, 0);
        assert.equal((await pool.query('SELECT 1 FROM outbox_events WHERE id=$1', [effect.eventId])).rowCount, 0);
        let applications = 0;
        const apply = async (tx: pg.PoolClient) => { applications++; await appendSqlOutbox(tx, effect); };
        const results = await Promise.all([
          processWithInbox(pool, consumer, source, apply), processWithInbox(pool, consumer, source, apply),
        ]);
        assert.deepEqual(results.sort(), [false, true]);
        assert.equal(applications, 1);
        assert.equal((await pool.query('SELECT 1 FROM outbox_events WHERE id=$1', [effect.eventId])).rowCount, 1);
        // Prevent unrelated pending fixture work from entering subsequent lease tests.
        await pool.query('UPDATE outbox_events SET status=$2 WHERE id=$1', [effect.eventId, 'published']);
      }
    });

    await t.test('EDA PostgreSQL outbox recovers expired leases and fences stale owners', async () => {
      for (const pool of pools) {
        const pending = event();
        ids.push(pending.eventId);
        const tx = await pool.connect();
        try { await appendSqlOutbox(tx, pending); } finally { tx.release(); }
        const abandoned = `abandoned-${randomUUID()}`;
        const recovered = `recovered-${randomUUID()}`;
        assert.deepEqual((await claimOutbox(pool, abandoned, 1)).map(row => row.id), [pending.eventId]);
        assert.deepEqual(await claimOutbox(pool, recovered, 1), []);
        await pool.query('UPDATE outbox_events SET "leaseUntil"=NOW()-INTERVAL \'1 second\' WHERE id=$1', [pending.eventId]);
        assert.deepEqual((await claimOutbox(pool, recovered, 1)).map(row => row.id), [pending.eventId]);
        await assert.rejects(markPublished(pool, pending.eventId, abandoned), /OUTBOX_LEASE_LOST/);
        await markPublished(pool, pending.eventId, recovered);
        assert.equal((await pool.query('SELECT status FROM outbox_events WHERE id=$1', [pending.eventId])).rows[0].status, 'published');
      }
    });

    await t.test('EDA RabbitMQ confirmed mandatory publish rejects unroutable messages', async () => {
      const source = event();
      await publishConfirmed(publisher, exchange, 'routed', source);
      const message = await provisionChannel!.get(queue, { noAck: false });
      assert.ok(message);
      assert.equal(JSON.parse(message.content.toString()).eventId, source.eventId);
      provisionChannel!.ack(message);
      await assert.rejects(publishConfirmed(publisher, exchange, 'unrouted', event()), /UNROUTABLE_EVENT/);
      await publisher.waitForConfirms();
    });

    await t.test('EDA unroutable outbox publication remains retryable instead of published', async () => {
      const pool = pools[0]!;
      const source = event();
      ids.push(source.eventId);
      const tx = await pool.connect();
      try { await appendSqlOutbox(tx, source); } finally { tx.release(); }
      const result = await dispatchOutbox(pool, sourceEvent => publishConfirmed(publisher, exchange, 'unrouted', sourceEvent));
      assert.deepEqual(result, { claimed: 1, published: 0 });
      const row = (await pool.query('SELECT status, attempts, "lastErrorCode", "leaseOwner" FROM outbox_events WHERE id=$1', [source.eventId])).rows[0];
      assert.deepEqual(row, { status: 'pending', attempts: 1, lastErrorCode: 'PUBLISH_FAILED', leaseOwner: null });
    });

    await t.test('EDA Profile real inbox transfers committed sync intents once and tracks latest required revision', async () => {
      const core = pools[0]!; const integrations = pools[1]!;
      const profileId = randomUUID(); const authId = randomUUID(); const intentId = randomUUID(); const requestId = randomUUID();
      const hash = requestHash('POST', `/internal/users/${authId}/stale`, {});
      const source = makeEvent({ eventType: 'vital.profile.sync.requested', producer: 'profile', aggregateId: profileId,
        aggregateVersion: 1, correlationId: randomUUID(), data: { intentId, authId, destination: 'auth-stale' } });
      const eventIds = [source.eventId];
      ids.push(source.eventId);
      try {
        const tx = await core.connect();
        try {
          await tx.query('BEGIN');
          await tx.query('INSERT INTO vital_users (id,"authId",role,version) VALUES ($1,$2,$3,1)', [profileId, authId, 'patient']);
          await tx.query(`INSERT INTO profile_sync_intents (id,"profileId","authId","sourceVersion",destination,"requestId","requestHash",payload)
            VALUES ($1,$2,$3,1,'auth-stale',$4,$5,'{}')`, [intentId, profileId, authId, requestId, hash]);
          await appendSqlOutbox(tx, source);
          await tx.query('COMMIT');
        } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
        await dispatchOutbox(core, fact => fact.eventId === source.eventId ? publishConfirmed(publisher, exchange, 'routed', fact)
          : Promise.reject(new Error('UNRELATED_TEST_FIXTURE')));
        const delivery = await provisionChannel!.get(queue, { noAck: false });
        assert.ok(delivery);
        const received = parseEvent(JSON.parse(delivery.content.toString()));
        assert.equal(received.eventId, source.eventId);
        await Promise.all([consumeProfileSync(core, integrations, received), consumeProfileSync(core, integrations, received)]);
        provisionChannel!.ack(delivery);
        assert.equal((await integrations.query('SELECT 1 FROM integration_deliveries WHERE "requestId"=$1', [requestId])).rowCount, 1);
        assert.equal((await getProfileSyncStatuses(core, integrations, [authId])).get(authId), 'pending');
        await integrations.query("UPDATE integration_deliveries SET status='accepted' WHERE \"requestId\"=$1", [requestId]);
        assert.equal((await getProfileSyncStatuses(core, integrations, [authId])).get(authId), 'synced');
        const duplicate = { ...source, eventId: randomUUID() }; eventIds.push(duplicate.eventId);
        await consumeProfileSync(core, integrations, duplicate);
        assert.equal((await integrations.query('SELECT 1 FROM integration_deliveries WHERE "requestId"=$1', [requestId])).rowCount, 1);
        const newer = randomUUID();
        await core.query('UPDATE vital_users SET version=2 WHERE id=$1', [profileId]);
        await core.query(`INSERT INTO profile_sync_intents (id,"profileId","authId","sourceVersion",destination,"requestId","requestHash",payload)
          VALUES ($1,$2,$3,2,'auth-stale',$4,$5,'{}')`, [randomUUID(), profileId, authId, newer, hash]);
        assert.equal((await getProfileSyncStatuses(core, integrations, [authId])).get(authId), 'pending');
        await assert.rejects(consumeProfileSync(core, integrations, { ...source, aggregateVersion: 3 }), /SOURCE_UNVERIFIED/);
      } finally {
        await integrations.query('DELETE FROM inbox_events WHERE "consumerId"=$1 AND "eventId"=ANY($2::text[])', ['profile-sync', eventIds]);
        await integrations.query('DELETE FROM integration_deliveries WHERE "aggregateId"=$1', [profileId]);
        await core.query('DELETE FROM profile_sync_intents WHERE "profileId"=$1', [profileId]);
        await core.query('DELETE FROM vital_users WHERE id=$1', [profileId]);
      }
    });

    await paymentLiveScenarios(t, { core: pools[0]!, integrations: pools[1]!, exchange, queue,
      channel: provisionChannel!, publisher, certs: config });
    await appointmentLiveScenarios(t,{core:pools[0]!,integrations:pools[1]!,exchange,queue,channel:provisionChannel!,publisher,certs:config});
    await remainingOwnersLiveScenarios(t,{core:pools[0]!,integrations:pools[1]!,exchange,queue,channel:provisionChannel!,publisher,certs:config});
    await recordsLiveScenarios(t, {core:pools[0]!,integrations:pools[1]!,exchange,queue,channel:provisionChannel!,publisher,certs:config});
    if(videoLiveConfiguration(process.env))await videoLiveScenarios(t,{core:pools[0]!,integrations:pools[1]!,exchange,queue,channel:provisionChannel!,publisher,certs:config});
    if(messagingLiveConfiguration(process.env))await messagingLiveScenarios(t,{core:pools[0]!,integrations:pools[1]!,exchange,queue,channel:provisionChannel!,publisher,certs:config});

    await t.test('EDA Profile actual mTLS process hop enforces certificate signature and own resource', async () => {
      const core = pools[0]!;
      const prisma = new PrismaClient({ adapter: new PrismaPg(core, { disposeExternalPool: false }) });
      const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
      const app = createEdaApp(prisma, { issuer: 'vital-web', audience: 'vital-services', peerName: 'vital-web', keyId: 'test', publicKey });
      const server = createServer({ key: readFileSync(config.apiKey), cert: readFileSync(config.apiCert),
        ca: readFileSync(config.serviceCa), requestCert: true, rejectUnauthorized: true }, app);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const authId = randomUUID(); const path = '/internal/v1/profile/me';
      const actor = { authId, role: 'patient', serviceId: 'vital-web', scopes: ['profile.read'], resource: authId,
        correlationId: randomUUID(), isSuperAdmin: false };
      function call(withCertificate: boolean, audience = 'vital-services', resource = authId) {
        const token = jwt.sign({ actor: { ...actor, resource }, action: `GET ${path}`, requestHash: requestHash('GET', path, null) },
          keys.privateKey, { algorithm: 'RS256', keyid: 'test', issuer: 'vital-web', audience, subject: authId, jwtid: randomUUID(), expiresIn: 30 });
        return new Promise<number>((resolve, reject) => {
          const request = httpsRequest({ host: '127.0.0.1', port, servername: 'vital-api.test', path, method: 'GET',
            ca: readFileSync(config.serviceCa), ...(withCertificate ? { cert: readFileSync(config.webCert), key: readFileSync(config.webKey) } : {}),
            rejectUnauthorized: true, headers: { 'X-Vital-Actor-Assertion': token } }, response => {
            response.resume(); response.once('end', () => resolve(response.statusCode ?? 0));
          });
          request.setTimeout(5000, () => request.destroy(new Error('TEST_TLS_TIMEOUT')));
          request.once('error', reject); request.end();
        });
      }
      try {
        await assert.rejects(call(false));
        assert.equal(await call(true, 'wrong-audience'), 401);
        assert.equal(await call(true, 'vital-services', randomUUID()), 403);
        assert.equal(await call(true), 200);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await prisma.$disconnect();
      }
    });

    await t.test('EDA RabbitMQ runtime identity cannot provision topology', async () => {
      const restricted = await runtime.createChannel();
      restricted.on('error', () => undefined);
      await assert.rejects(restricted.assertExchange(`${prefix}.forbidden`, 'direct', { durable: false })
        .then(() => { forbiddenCreated = true; }), /ACCESS_REFUSED/);
      await restricted.close().catch(() => undefined);
    });
    await publisher.close();
  } finally {
    // Remove only this run's UUID rows/resources; never reset databases, queues or volumes.
    try {
      for (const pool of pools) {
        if (consumers.length) await pool.query('DELETE FROM inbox_events WHERE "consumerId"=ANY($1::text[])', [consumers]);
        if (ids.length) await pool.query('DELETE FROM outbox_events WHERE id=ANY($1::text[])', [ids]);
      }
      if (provisionChannel) {
        if (queueCreated) await provisionChannel.deleteQueue(`${prefix}.queue`);
        if (exchangeCreated) await provisionChannel.deleteExchange(`${prefix}.events`);
        if (forbiddenCreated) await provisionChannel.deleteExchange(`${prefix}.forbidden`);
        await provisionChannel.close();
      }
    } finally {
      await Promise.allSettled(connections.map(connection => connection.close()));
      await Promise.all(pools.map(pool => pool.end()));
    }
  }
});
