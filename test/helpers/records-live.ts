import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request as httpsRequest } from 'node:https';
import type { TestContext } from 'node:test';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { PrismaPg } from '@prisma/adapter-pg';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { PrismaClient } from '../../src/eda/generated/core/client.js';
import type { Actor } from '../../src/eda/contracts/actor.js';
import { createEdaApp } from '../../src/eda/http/app.js';
import { requestHash } from '../../src/eda/infrastructure/security.js';
import { envelopeFromRow, type OutboxRow } from '../../src/eda/infrastructure/outbox.js';
import { publishConfirmed } from '../../src/eda/infrastructure/broker.js';
import { utcPgTypes } from '../../src/eda/infrastructure/utc-types.js';
import { createAppointmentModule, readAppointment } from '../../src/eda/modules/appointment/appointment.js';
import { consumeAppointmentPayment } from '../../src/eda/workers/appointment-payment.js';
import { consumePayment } from '../../src/eda/workers/handlers.js';
import { readPaymentProjectionAppointment } from '../../src/eda/modules/appointment/appointment-billing.js';
import { consumeRecordsEvent } from '../../src/eda/workers/records.js';
import { createRecordsModule } from '../../src/eda/modules/records/records.js';
import { createRecordsFiles } from '../../src/eda/modules/records/files.js';
import { createRecordsLifecycle } from '../../src/eda/modules/records/lifecycle.js';
import { clinicalHash, unprotectPayload, type RecordsKeyring } from '../../src/eda/modules/records/protection.js';
import { S3RecordsStorage, type RecordsStorage, type RecordsStorageConfig } from '../../src/eda/modules/records/storage.js';
import { ClamAvScanner } from '../../src/eda/modules/records/scanner.js';
import { RecordsArtifactWorker } from '../../src/eda/modules/records/artifacts.js';
import { canonicalArtifactData, createArtifactRepository } from '../../src/eda/modules/records/artifact-repository.js';
import { sha256 } from '../../src/eda/modules/records/upload-validation.js';
import { fixture, type Context } from './payment-live.js';

// Registration only. These are NOT EXECUTED evidence until explicit isolated Docker opt-in.
export const recordsLiveScenarioNames = [
  'EDA Records real Core concurrent commands snapshots documents permissions encryption and immutable SQL',
  'EDA Records real broker source fact inbox deduplication and durable wake before ACK',
  'EDA Records actual mTLS denies forged scope audience resource request and binary hash',
  'EDA Records real lifecycle freezes history closes paperwork and rolls back replacement provenance',
  'EDA Records optional real MinIO native ClamAV document publication and scoped link',
  'EDA Records optional real MinIO native ClamAV upload normalization and malware denial',
] as const;

function flag(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name];
  if (value !== undefined && value !== 'false' && value !== 'true') throw new Error(`Invalid isolated opt-in: ${name}`);
  return value === 'true';
}

export function recordsLiveConfiguration(environment: NodeJS.ProcessEnv) {
  const enabled = flag(environment, 'EDA_TEST_RECORDS_ENABLED');
  const artifacts = flag(environment, 'EDA_TEST_RECORDS_ARTIFACTS_ENABLED');
  if (artifacts && !enabled) throw new Error('RECORDS_ARTIFACTS_REQUIRE_RECORDS_OPT_IN');
  if (!enabled) return undefined;
  if (environment.EDA_TEST_ENABLED !== 'true' || environment.EDA_TEST_ISOLATED !== 'yes') throw new Error('RECORDS_REQUIRE_ISOLATED_OPT_IN');
  const required = (name: string) => {
    const value = environment[name];
    if (!value) throw new Error(`Missing isolated Records setting: ${name}`);
    return value;
  };
  const migrator = required('EDA_TEST_CORE_MIGRATOR_URL');
  const url = new URL(migrator);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'postgres' || url.port !== '5432' ||
      url.pathname !== '/vital_core_test' || decodeURIComponent(url.username) !== 'vital_core_migrator' || !url.password || /[?#]/.test(migrator)) {
    throw new Error('RECORDS_REFUSE_NON_ISOLATED_MIGRATOR');
  }
  let storage: RecordsStorageConfig | undefined;
  let cleanupStorage: {accessKeyId:string;secretAccessKey:string}|undefined;
  if (artifacts) {
    const endpoint = required('EDA_TEST_RECORDS_STORAGE_ENDPOINT');
    const target = new URL(endpoint);
    if (!['http:', 'https:'].includes(target.protocol) || target.hostname !== 'minio' || target.port !== '9000' ||
        target.pathname !== '/' || target.username || target.password || /[?#]/.test(endpoint) ||
        required('EDA_TEST_RECORDS_STORAGE_BUCKET') !== 'vital-records-test') throw new Error('RECORDS_REFUSE_SHARED_STORAGE');
    const accessKeyId = required('EDA_TEST_RECORDS_STORAGE_ACCESS_KEY');
    const secretAccessKey = required('EDA_TEST_RECORDS_STORAGE_SECRET_KEY');
    if (accessKeyId !== 'vital_records_test' || /^(?:minioadmin|root)$/i.test(secretAccessKey) ||
        accessKeyId === environment.MINIO_ROOT_USER || secretAccessKey === environment.MINIO_ROOT_PASSWORD) throw new Error('RECORDS_REFUSE_ROOT_STORAGE_IDENTITY');
    cleanupStorage={accessKeyId:required('EDA_TEST_RECORDS_STORAGE_CLEANUP_ACCESS_KEY'),secretAccessKey:required('EDA_TEST_RECORDS_STORAGE_CLEANUP_SECRET_KEY')};
    if(cleanupStorage.accessKeyId!=='vital_records_test_cleanup'||cleanupStorage.secretAccessKey===secretAccessKey||/^(?:minioadmin|root)$/i.test(cleanupStorage.secretAccessKey)
      ||cleanupStorage.accessKeyId===environment.MINIO_ROOT_USER||cleanupStorage.secretAccessKey===environment.MINIO_ROOT_PASSWORD)throw new Error('RECORDS_REQUIRE_SCOPED_STORAGE_CLEANUP_IDENTITY');
    if (required('EDA_TEST_RECORDS_CLAMAV_SOCKET') !== '/run/records-test/clamd.sock' ||
        required('EDA_TEST_RECORDS_CLAMAV_CONFIG') !== '/run/records-test/clamd.conf') throw new Error('RECORDS_REQUIRE_RESTRICTED_MOUNTED_SOCKET');
    storage = { endpoint, publicEndpoint: endpoint, bucket: 'vital-records-test', region: 'us-east-1', accessKeyId, secretAccessKey,
      quarantinePrefix: 'quarantine/records-test/', finalPrefix: 'records-test/final/', deadlineMs: 5000 };
  }
  return { migrator, databaseCa: required('EDA_TEST_DATABASE_CA_FILE'), storage,cleanupStorage };
}

const command = () => ({ operationId: randomUUID(), requestHash: 'a'.repeat(64) });
const delegate = (actor: Actor, scope: string, resource: string): Actor => ({ ...actor, scopes: [scope], resource });
const immutable = [
  ['records_snapshots', 'immutable_record_snapshots'], ['records_documents', 'immutable_record_documents'],
  ['records_episode_freezes', 'immutable_episode_freezes'], ['records_snapshot_assets', 'immutable_snapshot_assets'],
] as const;
type PaymentFixture = Parameters<Parameters<typeof fixture>[1]>[0];

async function teardown(context: Context, migrator: pg.Pool, f: PaymentFixture) {
  // Only the dedicated test migrator can remove committed immutable fixture evidence.
  const tx = await migrator.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SET LOCAL lock_timeout='5s'");
    const identity = (await tx.query('SELECT current_database() AS db,current_user AS identity')).rows[0];
    assert.deepEqual(identity, { db: 'vital_core_test', identity: 'vital_core_migrator' });
    assert.match(f.patientId, /^[a-f0-9-]{36}$/);
    assert.equal((await tx.query('SELECT 1 FROM vital_patients WHERE "userId"=$1 AND "authId"=$2', [f.patientId, f.actor.authId])).rowCount, 1);
    const resources = (await tx.query(`SELECT id::text FROM records_file_assets WHERE "patientId"=$1
      UNION SELECT id::text FROM records_documents WHERE "patientId"=$1
      UNION SELECT id::text FROM records_snapshots WHERE "patientId"=$1`, [f.patientId])).rows.map(row => row.id as string);
    const facts = (await tx.query('SELECT id FROM outbox_events WHERE "aggregateId"=ANY($1::text[])', [[...resources, f.appointmentId]])).rows.map(row => row.id);
    await tx.query('DELETE FROM inbox_events WHERE "consumerId"=ANY($1::text[]) AND "eventId"=ANY($2::text[])',
      [['records-artifact', 'records-appointment'], facts]);
    await tx.query('DELETE FROM outbox_events WHERE id=ANY($1::text[])', [facts]);
    for (const [table, trigger] of immutable) {
      await tx.query(`LOCK TABLE public.${table} IN ACCESS EXCLUSIVE MODE`);
      const state = (await tx.query(`SELECT t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=$1 AND t.tgname=$2 AND NOT t.tgisinternal`, [table, trigger])).rows;
      assert.deepEqual(state, [{ tgenabled: 'O' }]);
      await tx.query(`ALTER TABLE public.${table} DISABLE TRIGGER ${trigger}`);
    }
    await tx.query('DELETE FROM records_snapshot_assets WHERE "snapshotId" IN (SELECT id FROM records_snapshots WHERE "patientId"=$1)', [f.patientId]);
    await tx.query('DELETE FROM records_episode_freezes WHERE "patientId"=$1 AND "appointmentId"=$2', [f.patientId, f.appointmentId]);
    await tx.query('DELETE FROM records_episode_grants WHERE "patientId"=$1 AND "appointmentId"=$2', [f.patientId, f.appointmentId]);
    await tx.query('DELETE FROM records_snapshots WHERE "patientId"=$1 AND "doctorId"=$2', [f.patientId, f.doctorId]);
    await tx.query('DELETE FROM records_workflows WHERE "patientId"=$1 AND "actorAuthId"=$2', [f.patientId, f.doctorAuthId]);
    await tx.query('DELETE FROM records_documents WHERE "patientId"=$1 AND "doctorId"=$2', [f.patientId, f.doctorId]);
    await tx.query(`UPDATE records_artifact_capacity SET "operationId"=NULL,"operationFence"=NULL,"leaseOwner"=NULL,"leaseUntil"=NULL
      WHERE "operationId" IN (SELECT id FROM record_operations WHERE "patientId"=$1)`, [f.patientId]);
    await tx.query('DELETE FROM record_operations WHERE "patientId"=$1', [f.patientId]);
    await tx.query('DELETE FROM records_file_assets WHERE "patientId"=$1', [f.patientId]);
    await tx.query('DELETE FROM consent_records WHERE "patientId"=$1 AND "appointmentId"=$2', [f.patientId, f.appointmentId]);
    for (const [table, trigger] of immutable) await tx.query(`ALTER TABLE public.${table} ENABLE TRIGGER ${trigger}`);
    await tx.query('COMMIT');
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
  assert.equal((await context.core.query('SELECT 1 FROM records_file_assets WHERE "patientId"=$1', [f.patientId])).rowCount, 0);
}

async function recordsFixture<T>(context: Context, migrator: pg.Pool, storage: RecordsStorage, run: (f: Awaited<ReturnType<typeof setup>>) => Promise<T>) {
  return fixture(context, async payment => {
    try { return await run(await setup(context, payment, storage)); }
    finally { await teardown(context, migrator, payment); }
  });
}

async function setup(context: Context, f: PaymentFixture, storage: RecordsStorage) {
  const keyring: RecordsKeyring = { activeKeyId: 'fixture', keys: { fixture: randomBytes(32) } };
  // An explicit fixture-only EHR authority, never a runtime signing key or native EHR request.
  const ehrKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ehrPatientId = randomUUID(), ehrCaseId = randomUUID();
  const config = { keyring, evidence: { keys: { fixture: ehrKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString() } },
    financial: { verifyPaid: f.module.verifyAppointmentPaid },
    parties: async () => ({ patientName: 'Isolated patient', doctorName: 'Isolated doctor', doctorLicense: 'FIXTURE-PRC' }) };
  const lifecycle = createRecordsLifecycle(keyring);
  const appointment = createAppointmentModule(context.core, { records: lifecycle, financial: config.financial });
  const module = createRecordsModule(context.core, config), files = createRecordsFiles(context.core, config, storage);
  await context.core.query('UPDATE vital_patients SET "ehrPatientId"=$2 WHERE "userId"=$1', [f.patientId, ehrPatientId]);
  await context.core.query('UPDATE vital_doctors SET prc_license=$2 WHERE "userId"=$1', [f.doctorId, 'FIXTURE-PRC']);
  await context.core.query('UPDATE appointments SET "ehrCaseId"=$2 WHERE id=$1', [f.appointmentId, ehrCaseId]);
  await context.core.query(`INSERT INTO consent_records (id,"patientId","appointmentId","consentType",accepted,"consentedAt")
    VALUES ($1,$2,$3,'medical_record',true,NOW())`, [randomUUID(), f.patientId, f.appointmentId]);
  await f.module.checkout(f.actor, f.appointmentId, command()); f.pay();
  await f.module.reconcile(delegate(f.actor, 'payments.reconcile', f.appointmentId), f.appointmentId, command());
  const paid = await f.store.byAppointment(f.appointmentId); assert.ok(paid);
  const fact = (await context.integrations.query<OutboxRow>('SELECT * FROM outbox_events WHERE "aggregateId"=$1 AND "eventType"=$2', [paid.id, 'vital.payment.completed'])).rows[0]; assert.ok(fact);
  await consumePayment(context.core, context.integrations, envelopeFromRow(fact), readPaymentProjectionAppointment);
  await consumeAppointmentPayment(context.core, context.integrations, envelopeFromRow(fact), appointment.confirmPayment);
  const row = await readAppointment(context.core, f.appointmentId); assert.equal(row.status, 'confirmed');
  const doctor: Actor = { ...f.actor, authId: f.doctorAuthId, role: 'doctor' };
  function receipt(kind: 'snapshot' | 'treatment', workflowId: string, payloadHash: string, overrides: Record<string, unknown> = {}) {
    return jwt.sign({ kind, workflowId, actorAuthId: f.doctorAuthId, patientId: ehrPatientId, caseId: ehrCaseId,
      payloadHash, externalSystemRef: `vital:appointment:${f.appointmentId}`, ...overrides }, ehrKeys.privateKey,
    { algorithm: 'RS256', keyid: 'fixture', issuer: 'uhse-ehr', audience: 'vital-services.records', jwtid: randomUUID(), expiresIn: 30 });
  }
  return { ...f, context, config, keyring, lifecycle, appointment, module, files, row, doctor, receipt };
}
type RecordsFixture = Awaited<ReturnType<typeof setup>>;

async function issue(f: RecordsFixture) {
  const workflowId = randomUUID(), meta = command();
  const data = { lines: [{ medicineName: 'Isolated medicine', dosageAmount: '1', dosageUnit: 'tablet', frequency: 'daily' }] };
  const prepare = { workflowId, kind: 'prescription', patientId: f.patientId, appointmentId: f.appointmentId, expectedVersion: f.row.version, data };
  await f.module.prepareDocument(delegate(f.doctor, 'records.document.prepare', f.appointmentId), command(), prepare);
  const body = { workflowId, inputHash: clinicalHash(data), data, receipt: f.receipt('treatment', workflowId, clinicalHash(data)) };
  const actor = delegate(f.doctor, 'records.document.issue', workflowId);
  const results = await Promise.all([f.module.issueDocument(actor, meta, body), f.module.issueDocument(actor, meta, body)]);
  assert.deepEqual(results[0], results[1]);
  const result = results[0]!;
  await assert.rejects(f.module.issueDocument(actor, meta, { ...body, data: { lines: [{ ...data.lines[0], frequency: 'twice daily' }] } }), { code: 'COMMAND_REPLAY_CONFLICT' });
  assert.equal((await f.context.core.query('SELECT 1 FROM records_documents WHERE "patientId"=$1', [f.patientId])).rowCount, 1);
  assert.equal((await f.context.core.query('SELECT 1 FROM record_operations WHERE "patientId"=$1', [f.patientId])).rowCount, 1);
  return result as { id: string; assetId: string; operationId: string; operationStatus: string };
}

async function capture(f: RecordsFixture) {
  const workflowId = randomUUID(), meta = command();
  const actor = delegate(f.doctor, 'records.snapshot.prepare', f.appointmentId);
  const body = { workflowId, appointmentId: f.appointmentId, expectedVersion: f.row.version };
  const prepared = await Promise.all([f.module.prepareSnapshot(actor, meta, body), f.module.prepareSnapshot(actor, meta, body)]);
  assert.deepEqual(prepared[0], prepared[1]);
  const payload = { clinical: 'Isolated clinical marker', attachment_id: randomUUID(), file_url: 'https://fixture.invalid/file?token=transient' };
  const input = { inputHash: prepared[0]!.inputHash, payload, receipt: f.receipt('snapshot', workflowId, clinicalHash(payload)) };
  const writer = delegate(f.doctor, 'records.snapshot.capture', workflowId);
  await assert.rejects(f.module.captureSnapshot(writer, workflowId, command(), { ...input, receipt: f.receipt('snapshot', workflowId, clinicalHash(payload), { actorAuthId: randomUUID() }) }), { code: 'EHR_RECORDS_EVIDENCE_INVALID' });
  assert.equal((await f.context.core.query('SELECT 1 FROM records_snapshots WHERE "patientId"=$1', [f.patientId])).rowCount, 0);
  const commit = command();
  const results = await Promise.all([f.module.captureSnapshot(writer, workflowId, commit, input), f.module.captureSnapshot(writer, workflowId, commit, input)]);
  assert.deepEqual(results[0], results[1]);
  return { snapshotId: results[0]!.snapshotId as string, receipt: input.receipt };
}

async function brokerWake(f: RecordsFixture, aggregateId: string, eventType: 'vital.records.artifact.requested' | 'vital.records.snapshot.captured', consumer: 'records-artifact') {
  const { core, publisher, exchange, channel, queue } = f.context;
  const fact = (await core.query<OutboxRow>('SELECT * FROM outbox_events WHERE "aggregateId"=$1 AND "eventType"=$2', [aggregateId, eventType])).rows[0]; assert.ok(fact);
  const source = envelopeFromRow(fact);
  const forged = { ...source, eventId: randomUUID() };
  await assert.rejects(consumeRecordsEvent(core, forged, consumer), /RECORDS_SOURCE_EVIDENCE_MISSING/);
  assert.equal((await core.query('SELECT 1 FROM inbox_events WHERE "eventId"=$1', [forged.eventId])).rowCount, 0);
  if (eventType === 'vital.records.artifact.requested') {
    await core.query('UPDATE record_operations SET "nextAttemptAt"=NOW()+INTERVAL \'1 hour\' WHERE id=$1::uuid', [source.data.operationId]);
  } else {
    await core.query('UPDATE appointments SET "maintenanceDueAt"=NOW()+INTERVAL \'1 hour\' WHERE id=$1', [f.appointmentId]);
  }
  await publishConfirmed(publisher, exchange, 'routed', source);
  const delivery = await channel.get(queue, { noAck: false }); assert.ok(delivery);
  try {
    const received = JSON.parse(delivery.content.toString()); assert.deepEqual(received, source);
    await Promise.all([consumeRecordsEvent(core, received, consumer), consumeRecordsEvent(core, received, consumer)]);
    // Check committed durable work through another pooled session before acknowledging the broker.
    assert.equal((await core.query('SELECT 1 FROM inbox_events WHERE "consumerId"=$1 AND "eventId"=$2', [consumer, source.eventId])).rowCount, 1);
    const wake = eventType === 'vital.records.artifact.requested'
      ? await core.query('SELECT "nextAttemptAt"<=NOW() AS due FROM record_operations WHERE id=$1::uuid', [source.data.operationId])
      : await core.query('SELECT "maintenanceDueAt"<=NOW() AS due FROM appointments WHERE id=$1', [f.appointmentId]);
    assert.equal(wake.rows[0].due, true);
    assert.ok(!JSON.stringify(source).includes('Isolated medicine'));
    channel.ack(delivery);
  } catch (error) { channel.nack(delivery, false, false); throw error; }
}

// Explicit unavailable storage fixture. It never contacts a provider or approves an artifact.
function unavailableStorage(): RecordsStorage {
  const unavailable = async (): Promise<never> => { throw new Error('ISOLATED_STORAGE_NOT_ENABLED'); };
  return { key: (_area, id, hash) => `quarantine/records-test/${id}/${hash}.pdf`, putQuarantine: unavailable,
    readQuarantine: unavailable, ensureFinal: unavailable, inspectFinal: unavailable, signedLink: unavailable };
}

async function tlsScenario(f: RecordsFixture) {
  const prisma = new PrismaClient({ adapter: new PrismaPg(f.context.core, { disposeExternalPool: false }) });
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const worker = new RecordsArtifactWorker({ repository: createArtifactRepository(f.context.core), storage: unavailableStorage(),
    scanner: new ClamAvScanner({ socketPath: '/run/records-test/clamd.sock', daemonConfigPath: '/run/records-test/clamd.conf', deadlineMs: 5000, maxDatabaseAgeMs: 86400000 }),
    decryptCanonicalData: canonicalArtifactData(f.context.core, f.config) }, { enabled: false });
  const app = createEdaApp(prisma, { issuer: 'vital-web', audience: 'vital-services', peerName: 'vital-web', keyId: 'fixture',
    publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString() }, false, undefined, undefined, undefined,
  { module: f.module, files: f.files, lifecycle: f.lifecycle, artifactTick: signal => worker.runOnce(signal) });
  const server = createServer({ key: readFileSync(f.context.certs.apiKey), cert: readFileSync(f.context.certs.apiCert),
    ca: readFileSync(f.context.certs.serviceCa), requestCert: true, rejectUnauthorized: true }, app);
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as { port: number }).port;
    const path = '/internal/v1/records/uploads', operationId = randomUUID();
    const pdf = await PDFDocument.create(); pdf.addPage(); const bytes = Buffer.from(await pdf.save());
    const descriptor = { operationId, byteLength: bytes.length, sha256: sha256(bytes), mimeType: 'application/pdf', title: 'Fixture', description: null };
    async function call(options: { cert?: boolean; audience?: string; scope?: string; resource?: string; badHash?: boolean; bytes?: Buffer; signedBody?: unknown; signature?: boolean } = {}) {
      const body = options.bytes ?? bytes;
      const actor = delegate(f.actor, options.scope ?? 'records.upload', options.resource ?? operationId);
      const token = jwt.sign({ actor, action: `POST ${path}`, requestHash: options.badHash ? '0'.repeat(64) : requestHash('POST', path, options.signedBody ?? descriptor) },
        options.signature === false ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey : keys.privateKey,
        { algorithm: 'RS256', keyid: 'fixture', issuer: 'vital-web', audience: options.audience ?? 'vital-services', subject: actor.authId, jwtid: operationId, expiresIn: 30 });
      return new Promise<number>((resolve, reject) => {
        const req = httpsRequest({ host: '127.0.0.1', port, servername: 'vital-api.test', method: 'POST', path,
          ca: readFileSync(f.context.certs.serviceCa), ...(options.cert === false ? {} : { cert: readFileSync(f.context.certs.webCert), key: readFileSync(f.context.certs.webKey) }),
          rejectUnauthorized: true, headers: { 'X-Vital-Actor-Assertion': token, 'X-Vital-Upload-Descriptor': Buffer.from(JSON.stringify(descriptor)).toString('base64url'),
            'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode ?? 0)); });
        req.setTimeout(5000, () => req.destroy(new Error('ISOLATED_TLS_TIMEOUT'))); req.once('error', reject); req.end(body);
      });
    }
    await assert.rejects(call({ cert: false }));
    assert.equal(await call({ audience: 'forged-audience' }), 401);
    assert.equal(await call({ signature: false }), 401);
    assert.equal(await call({ scope: 'records.files.read' }), 403);
    assert.equal(await call({ resource: randomUUID() }), 403);
    assert.equal(await call({ badHash: true }), 401);
    assert.equal(await call({ signedBody: { ...descriptor, title: 'Substituted' } }), 401);
    const altered = Buffer.from(bytes); altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
    assert.equal(await call({ bytes: altered }), 400);
    assert.equal((await f.context.core.query('SELECT 1 FROM record_operations WHERE id=$1::uuid', [operationId])).rowCount, 0);
    assert.equal(await call(), 202);
    assert.equal(await call(), 202);
    assert.equal((await f.context.core.query('SELECT 1 FROM records_file_assets WHERE id=$1::uuid', [operationId])).rowCount, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await prisma.$disconnect(); }
}

async function rollbackReplacement(f: RecordsFixture, documentId: string, snapshotId: string) {
  const tx = await f.context.core.connect(), replacementId = randomUUID();
  try {
    await tx.query('BEGIN');
    const source = await readAppointment(tx, f.appointmentId, true);
    await tx.query(`INSERT INTO appointments (id,"patientId","doctorId",status,"scheduledAt","updatedAt","billingLineageId","associationVersion","ehrCaseId")
      VALUES($1,$2,$3,'confirmed',NOW()+INTERVAL '2 days',NOW(),$4,$5,$6)`,
    [replacementId, f.patientId, f.doctorId, f.lineage, source.associationVersion + 1, randomUUID()]);
    const replacement = await readAppointment(tx, replacementId);
    const transition = { operationId: randomUUID(), beforeState: source.status, afterState: 'rescheduled', effectiveAt: new Date(), replacement };
    await f.lifecycle.apply(tx, source, 'reschedule', transition);
    assert.equal((await tx.query('SELECT status FROM records_episode_grants WHERE "appointmentId"=$1', [replacementId])).rows[0].status, 'transferring');
    await f.lifecycle.finalizeReschedule!(tx, source, replacement, { ...transition, afterState: replacement.status });
    const grant = (await tx.query('SELECT status,"snapshotId" FROM records_episode_grants WHERE "appointmentId"=$1', [replacementId])).rows[0];
    assert.deepEqual(grant, { status: 'live', snapshotId: null });
    for (const [table, id] of [['records_documents', documentId], ['records_snapshots', snapshotId]]) {
      assert.equal((await tx.query(`SELECT "appointmentId" FROM ${table} WHERE id=$1::uuid`, [id])).rows[0].appointmentId, source.id);
    }
    // This checks real owner SQL with rollback, not a committed reschedule saga or broker proof.
  } finally { await tx.query('ROLLBACK'); tx.release(); }
  assert.equal((await f.context.core.query('SELECT 1 FROM appointments WHERE id=$1', [replacementId])).rowCount, 0);
  assert.equal((await f.context.core.query('SELECT status FROM records_episode_grants WHERE "appointmentId"=$1', [f.appointmentId])).rows[0].status, 'live');
}

export async function recordsLiveScenarios(t: TestContext, context: Context, environment: NodeJS.ProcessEnv = process.env) {
  const config = recordsLiveConfiguration(environment);
  if (!config) {
    for (const name of recordsLiveScenarioNames) await t.test(name, { skip: 'NOT EXECUTED: Records live opt-in is default off.' }, () => {});
    return;
  }
  const migrator = new pg.Pool({ connectionString: config.migrator, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000,
    query_timeout: 11000, types: utcPgTypes, options: '-c timezone=UTC', ssl: { ca: readFileSync(config.databaseCa, 'utf8'), rejectUnauthorized: true } });
  const s3 = config.storage ? new S3Client({ endpoint: config.storage.endpoint, region: config.storage.region, forcePathStyle: true,
    credentials: { accessKeyId: config.cleanupStorage!.accessKeyId, secretAccessKey: config.cleanupStorage!.secretAccessKey }, maxAttempts: 1 }) : undefined;
  const runtimeS3 = config.storage ? new S3Client({ endpoint: config.storage.endpoint, region: config.storage.region, forcePathStyle: true,
    credentials: { accessKeyId: config.storage.accessKeyId, secretAccessKey: config.storage.secretAccessKey }, maxAttempts: 1 }) : undefined;
  const storedKeys = new Set<string>();
  const realStorage = config.storage ? new S3RecordsStorage(config.storage, runtimeS3) : undefined;
  const storage: RecordsStorage = realStorage ? {
    key: (...args) => realStorage.key(...args), readQuarantine: (...args) => realStorage.readQuarantine(...args),
    inspectFinal: (...args) => realStorage.inspectFinal(...args), signedLink: key => realStorage.signedLink(key),
    putQuarantine: async (key, ...args) => { storedKeys.add(key); await realStorage.putQuarantine(key, ...args); },
    ensureFinal: async (key, ...args) => { storedKeys.add(key); await realStorage.ensureFinal(key, ...args); },
  } : unavailableStorage();
  const run = (body: (f: RecordsFixture) => Promise<void>) => recordsFixture(context, migrator, storage, body);
  try {
    for (const [pool, domain] of [[context.core, 'core'], [context.integrations, 'integrations']] as const) {
      assert.deepEqual((await pool.query('SELECT current_database() AS db,current_user AS identity')).rows[0],
        { db: `vital_${domain}_test`, identity: `vital_${domain}_worker` });
    }
    assert.deepEqual((await migrator.query('SELECT current_database() AS db,current_user AS identity')).rows[0], { db: 'vital_core_test', identity: 'vital_core_migrator' });
    assert.equal((await context.core.query('SELECT 1 FROM record_operations LIMIT 1')).rowCount, 0, 'Use a fresh isolated project; never process existing artifact work.');
    await t.test(recordsLiveScenarioNames[0], { timeout: 30000 }, () => run(async f => {
      const doc = await issue(f), snapshot = await capture(f);
      const patientDoc = await f.module.document(delegate(f.actor, 'records.document.read', doc.id), doc.id);
      assert.equal(patientDoc.patientId, f.patientId);
      await fixture(context, async stranger => {
        await assert.rejects(f.module.document(delegate(stranger.actor, 'records.document.read', doc.id), doc.id), { code: 'RECORDS_DOCUMENT_DENIED' });
        await assert.rejects(f.module.snapshot(delegate(stranger.actor, 'records.snapshot.read', snapshot.snapshotId), snapshot.snapshotId), { code: 'RECORDS_SNAPSHOT_ACCESS_DENIED' });
        const unrelatedDoctor: Actor = { ...stranger.actor, authId: stranger.doctorAuthId, role: 'doctor' };
        await assert.rejects(f.module.document(delegate(unrelatedDoctor, 'records.document.read', doc.id), doc.id), { code: 'RECORDS_DOCUMENT_DENIED' });
        await assert.rejects(f.module.snapshot(delegate(unrelatedDoctor, 'records.snapshot.read', snapshot.snapshotId), snapshot.snapshotId), { code: 'RECORDS_SNAPSHOT_ACCESS_DENIED' });
      });
      await assert.rejects(f.module.document(delegate({ ...f.actor, authId: randomUUID() }, 'records.document.read', doc.id), doc.id));
      await assert.rejects(f.module.document(delegate(f.actor, 'records.document.read', randomUUID()), doc.id), { code: 'ACTOR_SCOPE_DENIED' });
      await assert.rejects(f.module.listDocuments(delegate(f.actor, 'records.documents.read', f.actor.authId), { patientId: randomUUID() }), { code: 'RECORDS_PATIENT_DENIED' });
      const read = await f.module.snapshot(delegate(f.doctor, 'records.snapshot.read', snapshot.snapshotId), snapshot.snapshotId);
      assert.equal((read.payload.ehr as { clinical: string }).clinical, 'Isolated clinical marker');
      assert.equal((read.payload.documents as Array<{ id: string }>)[0]!.id, doc.id);
      assert.ok(!JSON.stringify(read).includes('token=transient'));
      const saved = (await context.core.query('SELECT * FROM records_snapshots WHERE id=$1::uuid', [snapshot.snapshotId])).rows[0];
      assert.ok(!JSON.stringify(saved).includes('Isolated clinical marker')); assert.ok(!JSON.stringify(saved).includes(snapshot.receipt));
      const encryptedDoc = (await context.core.query('SELECT "protectedPayload" FROM records_documents WHERE id=$1::uuid', [doc.id])).rows[0];
      assert.ok(!JSON.stringify(encryptedDoc).includes('Isolated medicine'));
      assert.throws(() => unprotectPayload(f.keyring, { patientId: randomUUID(), resourceId: snapshot.snapshotId, schema: 'snapshot.v1' }, saved.protectedPayload), { code: 'RECORDS_PAYLOAD_UNAVAILABLE' });
      const revokedConsent = randomUUID();
      try {
        await context.core.query(`INSERT INTO consent_records (id,"patientId","appointmentId","consentType",accepted,"consentedAt")
          VALUES($1,$2,$3,'medical_record',false,NOW())`, [revokedConsent, f.patientId, f.appointmentId]);
        await assert.rejects(f.module.snapshot(delegate(f.doctor, 'records.snapshot.read', snapshot.snapshotId), snapshot.snapshotId), { code: 'RECORDS_MEDICAL_CONSENT_REQUIRED' });
        await assert.rejects(f.module.document(delegate(f.doctor, 'records.document.read', doc.id), doc.id), { code: 'RECORDS_MEDICAL_CONSENT_REQUIRED' });
      } finally { await context.core.query('DELETE FROM consent_records WHERE id=$1 AND "patientId"=$2', [revokedConsent, f.patientId]); }
      for (const [table, id] of [['records_snapshots', snapshot.snapshotId], ['records_documents', doc.id]]) {
        await assert.rejects(context.core.query(`UPDATE ${table} SET "protectedPayload"='{}' WHERE id=$1::uuid`, [id]), /immutable_records_evidence/);
        await assert.rejects(context.core.query(`DELETE FROM ${table} WHERE id=$1::uuid`, [id]), /immutable_records_evidence/);
      }
    }));
    await t.test(recordsLiveScenarioNames[1], { timeout: 30000 }, () => run(async f => {
      const doc = await issue(f); await brokerWake(f, doc.assetId, 'vital.records.artifact.requested', 'records-artifact');
      const snapshot = await capture(f); await brokerWake(f, snapshot.snapshotId, 'vital.records.snapshot.captured', 'records-artifact');
    }));
    await t.test(recordsLiveScenarioNames[2], { timeout: 30000 }, () => run(tlsScenario));
    await t.test(recordsLiveScenarioNames[3], { timeout: 30000 }, () => run(async f => {
      await context.core.query('UPDATE appointments SET "scheduledAt"=NOW()-INTERVAL \'1 minute\',"completionDeadlineAt"=NOW()+INTERVAL \'1 day\' WHERE id=$1', [f.appointmentId]);
      const doctor = delegate(f.doctor, 'appointments.complete', f.appointmentId);
      await assert.rejects(f.appointment.complete(doctor, f.appointmentId, command(), { expectedVersion: f.row.version }), { code: 'RECORD_SNAPSHOT_REQUIRED' });
      const doc = await issue(f), snapshot = await capture(f);
      await rollbackReplacement(f, doc.id, snapshot.snapshotId);
      const ack = await f.appointment.complete(doctor, f.appointmentId, command(), { expectedVersion: f.row.version });
      const completed = await f.appointment.complete(delegate(f.actor, 'appointments.complete', f.appointmentId), f.appointmentId, command(), { expectedVersion: ack.version });
      assert.equal(completed.status, 'completed');
      const grant = (await context.core.query('SELECT * FROM records_episode_grants WHERE "appointmentId"=$1', [f.appointmentId])).rows[0];
      assert.equal(grant.status, 'historical'); assert.equal(grant.frozenSnapshotId, snapshot.snapshotId);
      assert.equal((await context.core.query('SELECT 1 FROM records_episode_freezes WHERE "appointmentId"=$1', [f.appointmentId])).rowCount, 1);
      await assert.rejects(context.core.query('DELETE FROM records_episode_freezes WHERE "appointmentId"=$1', [f.appointmentId]), /immutable_records_evidence/);
      await assert.rejects(context.core.query('DELETE FROM records_snapshot_assets WHERE "snapshotId"=$1::uuid', [snapshot.snapshotId]), /immutable_records_evidence/);
      assert.equal((await f.module.snapshot(delegate(f.doctor, 'records.snapshot.read', snapshot.snapshotId), snapshot.snapshotId)).snapshotId, snapshot.snapshotId);
      assert.equal((await f.module.document(delegate(f.actor, 'records.document.read', doc.id), doc.id)).appointmentId, f.appointmentId);
      await assert.rejects(f.module.prepareSnapshot(delegate(f.doctor, 'records.snapshot.prepare', f.appointmentId), command(), { workflowId: randomUUID(), appointmentId: f.appointmentId, expectedVersion: completed.version }));
      await assert.rejects(f.module.prepareDocument(delegate(f.doctor, 'records.document.prepare', f.appointmentId), command(), { workflowId: randomUUID(), kind: 'medical-certificate', patientId: f.patientId, appointmentId: f.appointmentId, expectedVersion: completed.version, data: { purpose: 'Fixture', diagnosis: 'Fixture' } }), { code: 'RECORDS_LIVE_ACCESS_DENIED' });
    }));
    const artifactOptions = { timeout: 45000, skip: !config.storage ? 'NOT EXECUTED: Additional real MinIO/native ClamAV opt-in is default off.' : false };
    const scanner = () => new ClamAvScanner({ socketPath: '/run/records-test/clamd.sock', daemonConfigPath: '/run/records-test/clamd.conf', deadlineMs: 5000, maxDatabaseAgeMs: 86400000 });
    const worker = (f: RecordsFixture) => new RecordsArtifactWorker({ repository: createArtifactRepository(context.core), storage, scanner: scanner(), decryptCanonicalData: canonicalArtifactData(context.core, f.config) }, { enabled: true });
    await t.test(recordsLiveScenarioNames[4], artifactOptions, () => run(async f => {
      const doc = await issue(f); await brokerWake(f, doc.assetId, 'vital.records.artifact.requested', 'records-artifact');
      assert.equal(await worker(f).runOnce(AbortSignal.timeout(30000)), 1);
      const asset = (await context.core.query('SELECT * FROM records_file_assets WHERE id=$1::uuid', [doc.assetId])).rows[0];
      assert.equal(asset.state, 'ready'); assert.equal(asset.scanEvidence.final.contentHash, asset.publishedHash);
      assert.equal((await f.module.operations(delegate(f.doctor, 'records.operation.read', doc.operationId), doc.operationId)).operationStatus, 'completed');
      const link = await f.files.link(delegate(f.actor, 'records.file.link', doc.assetId), doc.assetId, command(), { expectedVersion: asset.version });
      const url = new URL(link.url); assert.equal(url.hostname, 'minio'); assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
      const response = await fetch(link.url, { signal: AbortSignal.timeout(5000) }); assert.equal(response.status, 200);
      assert.equal(sha256(Buffer.from(await response.arrayBuffer())), asset.publishedHash);
      assert.equal(await worker(f).runOnce(), 0);
      assert.equal((await context.core.query('SELECT 1 FROM outbox_events WHERE "aggregateId"=$1 AND "eventType"=$2', [doc.assetId, 'vital.records.artifact.ready'])).rowCount, 1);
    }));
    await t.test(recordsLiveScenarioNames[5], artifactOptions, () => run(async f => {
      const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#336699' } }).withMetadata().png().toBuffer();
      const meta = command(), input = { operationId: meta.operationId, byteLength: bytes.length, sha256: sha256(bytes), mimeType: 'image/png', title: 'Isolated upload' };
      const actor = delegate(f.actor, 'records.upload', meta.operationId);
      await f.files.upload(actor, meta, input, bytes);
      assert.equal((await f.files.read(delegate(f.actor, 'records.file.read', meta.operationId), meta.operationId)).processingState, 'quarantine');
      await assert.rejects(f.files.link(delegate(f.actor, 'records.file.link', meta.operationId), meta.operationId, command(), { expectedVersion: 0 }), { code: 'RECORDS_FILE_NOT_READY' });
      assert.equal(await worker(f).runOnce(AbortSignal.timeout(30000)), 1);
      const asset = (await context.core.query('SELECT * FROM records_file_assets WHERE id=$1::uuid', [meta.operationId])).rows[0];
      assert.equal(asset.state, 'ready'); assert.equal(asset.scanEvidence.input.contentHash, input.sha256); assert.equal(asset.scanEvidence.final.contentHash, asset.publishedHash);
      assert.notEqual(asset.publishedHash, input.sha256, 'Normalized bytes require their own exact-byte native scan evidence.');
      const engine = scanner();
      // Standard inert test signature, sent only to the explicitly mounted native test daemon.
      const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
      await assert.rejects(engine.scan(eicar), error => error instanceof Error && 'code' in error && error.code === 'UPLOAD_MALWARE_OR_SCAN_LIMIT');
    }));
  } finally {
    try {
      if (s3 && config.storage) for (const key of storedKeys) {
        assert.ok(key.startsWith(config.storage.quarantinePrefix) || key.startsWith(config.storage.finalPrefix));
        await s3.send(new DeleteObjectCommand({ Bucket: 'vital-records-test', Key: key }), { abortSignal: AbortSignal.timeout(5000) });
      }
    } finally { s3?.destroy(); runtimeS3?.destroy(); await migrator.end(); }
  }
}
