import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { portalProvisionFixture } from './helpers/portal-provision.js';

test('portal foreign doctor workflow commits once and replays current projection without duplicate effects', async () => {
  const f = portalProvisionFixture();
  const prepared = await Promise.all([f.prepare(), f.prepare()]);
  assert.deepEqual(prepared[0], prepared[1]);
  assert.equal(f.state.workflows.length, 1); assert.equal(f.state.commands.length, 1);
  const committed = await Promise.all([f.commit(), f.commit()]);
  assert.deepEqual(committed[0], committed[1]);
  assert.equal(f.state.users.length, 1); assert.equal(f.state.doctors.length, 1);
  assert.equal(f.state.users[0]!.authId, f.targetAuthId); assert.equal(f.state.users[0]!.version, 1);
  assert.equal(f.state.doctors[0]!.isDoctorOnboardingComplete, false);
  assert.equal(f.state.doctors[0]!.departmentExternalId, f.receipt.department.id);
  assert.equal(f.state.commands.length, 2); assert.ok(f.state.commands.every(row => row.status === 'completed'));
  assert.equal(f.state.events.length, 4);
  assert.deepEqual(f.state.intents.map(row => row.destination).sort(), ['auth-stale', 'ehr-mirror']);
  assert.equal(f.state.events.filter(row => row.eventType === 'vital.audit.requested').length, 1);
  const snapshot = structuredClone(f.state);
  f.state.doctors[0]!.prcLicense = 'CURRENT-PRC'; f.setSync('failed');
  const replay = await f.commit();
  assert.ok('doctor' in replay && replay.doctor);
  assert.equal(replay.doctor.prcLicense, 'CURRENT-PRC'); assert.equal(replay.doctor.syncStatus, 'failed');
  assert.equal(f.state.events.length, snapshot.events.length); assert.equal(f.state.intents.length, 2);
  assert.equal(f.verifications, 5);
  assert.deepEqual(f.verifiedIds, Array(5).fill(f.targetAuthId));
  assert.equal('doctor' in f.state.commands[1]!.result, false);
  const completed = structuredClone(f.state);
  await assert.rejects(f.execute(f.commitRoute, f.commitBody), { code: 'PORTAL_DOCTOR_WORKFLOW_CONFLICT' });
  assert.deepEqual(f.state, completed);
});

test('portal foreign doctor workflow rejects hash receipt actor and target substitutions', async () => {
  const f = portalProvisionFixture(); await f.prepare();
  const before = structuredClone(f.state);
  await assert.rejects(f.execute(f.prepareRoute, f.prepareBody, { ...f.prepareMetadata, requestHash: 'b'.repeat(64) }), { code: 'COMMAND_REPLAY_CONFLICT' });
  await assert.rejects(f.execute(f.prepareRoute, { ...f.prepareBody, input: { ...f.input, prcLicense: 'DIFFERENT' } }), { code: 'PORTAL_DOCTOR_WORKFLOW_CONFLICT' });
  await assert.rejects(f.execute(f.prepareRoute, { ...f.prepareBody, targetAuthId: randomUUID() }), { code: 'PORTAL_DOCTOR_WORKFLOW_CONFLICT' });
  await assert.rejects(f.execute(f.commitRoute, { ...f.commitBody, targetAuthId: randomUUID() }), { code: 'PORTAL_DOCTOR_WORKFLOW_CONFLICT' });
  for (const patch of [{ workflowId: randomUUID() }, { actorAuthId: randomUUID() }, { targetAuthId: randomUUID() },
    { inputHash: 'c'.repeat(64) }, { expectedVersion: 0 }, { department: { id: 'other', name: 'Neurology' } }]) {
    await assert.rejects(f.execute(f.commitRoute, { ...f.commitBody, receipt: { ...f.receipt, ...patch } }), { code: 'PORTAL_DOCTOR_WORKFLOW_CONFLICT' });
    assert.deepEqual(f.state, before);
  }
  const stranger = randomUUID();
  await assert.rejects(f.execute(f.commitRoute, f.commitBody, f.commitMetadata,
    { ...f.actor(f.commitRoute), authId: stranger }, { ...f.source, subject: stranger }), { code: 'PORTAL_DOCTOR_WORKFLOW_CONFLICT' });
  await assert.rejects(f.execute(f.commitRoute, f.commitBody, { ...f.commitMetadata, operationId: f.prepareMetadata.operationId }), { code: 'PORTAL_DOCTOR_WORKFLOW_CONFLICT' });
  await assert.rejects(f.execute(f.commitRoute, f.commitBody, { ...f.commitMetadata, operationId: f.workflowId }), { code: 'PORTAL_DOCTOR_WORKFLOW_CONFLICT' });
  assert.deepEqual(f.state, before);
  await f.commit();
  const complete = structuredClone(f.state);
  await assert.rejects(f.execute(f.commitRoute, f.commitBody, { ...f.commitMetadata, requestHash: 'd'.repeat(64) }), { code: 'COMMAND_REPLAY_CONFLICT' });
  assert.deepEqual(f.state, complete);
});

test('portal foreign doctor workflow fences stale revisions and revoked foreign roles before replay', async () => {
  const stale = portalProvisionFixture(); await stale.prepare();
  stale.state.users.push({ id: randomUUID(), authId: stale.targetAuthId, role: 'patient', version: 0 });
  const before = structuredClone(stale.state);
  await assert.rejects(stale.commit(), { code: 'PORTAL_DOCTOR_WORKFLOW_CONFLICT' });
  assert.deepEqual(stale.state, before);
  const revised = portalProvisionFixture();
  revised.state.users.push({ id: randomUUID(), authId: revised.targetAuthId, role: 'patient', version: 7 });
  revised.receipt.expectedVersion = 7;
  await revised.prepare();
  revised.state.users[0]!.version++;
  const concurrentEdit = structuredClone(revised.state);
  await assert.rejects(revised.commit(), { code: 'PORTAL_DOCTOR_WORKFLOW_CONFLICT' });
  assert.deepEqual(revised.state, concurrentEdit);
  const f = portalProvisionFixture(); await f.prepare(); await f.commit();
  const complete = structuredClone(f.state);
  for (const source of [{ ...f.source, isAdmin: false, roles: ['nurse'] }, { ...f.source, systems: [] },
    { ...f.source, expiresAt: 1 }, { ...f.source, system: 'vital' }]) {
    await assert.rejects(f.execute(f.commitRoute, f.commitBody, f.commitMetadata, f.actor(f.commitRoute), source), { code: 'PORTAL_INTEGRATION_DELEGATION_DENIED' });
  }
  f.beforeTransaction(() => { f.source.isAdmin = false; });
  await assert.rejects(f.commit(), { code: 'PORTAL_INTEGRATION_DELEGATION_DENIED' });
  f.source.isAdmin = true; f.revokeIdentity();
  await assert.rejects(f.commit(), /fixture-identity-revoked/);
  assert.deepEqual(f.state, complete);
  const changedRole = portalProvisionFixture(); await changedRole.prepare(); await changedRole.commit();
  changedRole.state.users[0]!.role = 'admin';
  const protectedProfile = structuredClone(changedRole.state);
  await assert.rejects(changedRole.commit(), { code: 'PORTAL_DOCTOR_WORKFLOW_CONFLICT' });
  assert.deepEqual(changedRole.state, protectedProfile);
});

test('portal foreign doctor external receipt survives Core rollback and retries the same commit', async () => {
  for (const point of ['outbox', 'intent', 'workflow', 'journal', 'commit']) {
    const f = portalProvisionFixture(); await f.prepare();
    // A previously verified external receipt is caller-owned, not part of Core rollback.
    const receipt = structuredClone(f.receipt), prepared = structuredClone(f.state);
    f.fail(point);
    await assert.rejects(f.commit(), new RegExp('fixture-' + point));
    assert.deepEqual(f.state, prepared); assert.deepEqual(f.receipt, receipt);
    await f.commit(); await f.commit();
    assert.equal(f.state.users.length, 1); assert.equal(f.state.users[0]!.version, 1);
    assert.equal(f.state.workflows[0]!.state, 'committed'); assert.deepEqual(f.state.workflows[0]!.receipt, receipt);
    assert.equal(f.state.workflows[0]!.commitOperationId, f.commitMetadata.operationId);
    assert.equal(f.state.events.length, 4); assert.equal(f.state.intents.length, 2); assert.equal(f.state.commands.length, 2);
  }
  for (const code of ['P2034', 'P2002']) {
    const f = portalProvisionFixture(); await f.prepare();
    f.fail('commit', code);
    await f.commit();
    assert.equal(f.transactions, 3); assert.equal(f.verifications, 2);
    assert.equal(f.state.commands.length, 2); assert.equal(f.state.events.length, 4);
    assert.equal(f.state.users[0]!.version, 1); assert.equal(f.state.intents.length, 2);
  }
});
