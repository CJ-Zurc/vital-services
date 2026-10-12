import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import amqp from 'amqplib';
import { appendSqlOutbox, claimOutbox, dispatchOutbox, makeEvent, markPublished, processWithInbox } from '../src/eda/infrastructure/outbox.js';
import { publishConfirmed } from '../src/eda/infrastructure/broker.js';

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

function event() {
  return makeEvent({ producer: 'profile', eventType: 'vital.profile.changed', aggregateId: randomUUID(),
    aggregateVersion: 1, correlationId: randomUUID(), data: { authId: randomUUID(), role: 'patient',
      operation: 'profile_updated', actorAuthId: randomUUID() } });
}

test('EDA isolated PostgreSQL and RabbitMQ integration', {
  skip: (process.env.EDA_TEST_ENABLED === undefined && !process.env.CI) || process.env.EDA_TEST_ENABLED === 'false'
    ? 'Opt-in integration is disabled; no database or broker connection was attempted.' : false,
  timeout: 60_000,
}, async t => {
  // Any other supplied enable value fails, as do all missing enabled-run settings.
  const config = configuration(process.env);
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
      const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000,
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
