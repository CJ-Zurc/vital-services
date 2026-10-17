import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../../src/eda/contracts/actor.js';
import type { CorePrismaClient } from '../../src/eda/infrastructure/databases.js';
import { requestHash } from '../../src/eda/infrastructure/security.js';
import { createPortalDoctorProvision } from '../../src/eda/modules/portal-integrations/portal-integrations-provision.js';
import type { PortalSource } from '../../src/eda/modules/portal-integrations/portal-integrations-contracts.js';

type Row = Record<string, any>;
export function portalProvisionFixture() {
  const subject = randomUUID(), targetAuthId = randomUUID(), workflowId = randomUUID();
  const source: PortalSource = { subject, system: 'ehr', systems: ['ehr'], roles: ['admin'],
    isAdmin: true, isSuperAdmin: false, expiresAt: Math.floor(Date.now() / 1000) + 300 };
  const input = { specialty: 'Cardiology', prcLicense: 'FIXTURE-PRC', availabilityType: 'both' };
  let state: { users: Row[]; doctors: Row[]; workflows: Row[]; commands: Row[]; events: Row[]; intents: Row[] } = {
    users: [], doctors: [], workflows: [], commands: [], events: [], intents: [],
  };
  let failure: string | undefined, failureCode: string | undefined, tail = Promise.resolve();
  let identityActive = true, sync: 'pending' | 'failed' | 'synced' = 'pending';
  let verifications = 0, transactions = 0, inTransaction = false, beforeTransaction: (() => void) | undefined;
  const verifiedIds: string[] = [];
  const trip = (point: string) => {
    if (failure === point) {
      failure = undefined;
      const error = Object.assign(new Error('fixture-' + point), failureCode ? { code: failureCode } : {});
      failureCode = undefined;
      throw error;
    }
  };
  const tx = {
    vitalUser: {
      findUnique: async ({ where }: Row) => {
        const row = state.users.find(item => item.authId === where.authId);
        return row ? structuredClone({ ...row, doctor: state.doctors.find(item => item.userId === row.id) ?? null, admin: null }) : null;
      },
      create: async ({ data }: Row) => { const row = { id: randomUUID(), version: 0, ...data }; state.users.push(row); return structuredClone(row); },
      update: async ({ where, data }: Row) => {
        const row = state.users.find(item => item.id === where.id)!;
        if (data.version) row.version += data.version.increment;
        if (data.role) row.role = data.role;
        return structuredClone(row);
      },
    },
    vitalDoctor: {
      upsert: async ({ where, create, update }: Row) => {
        const row = state.doctors.find(item => item.authId === where.authId);
        if (row) Object.assign(row, update); else state.doctors.push(structuredClone(create));
      },
      findUnique: async ({ where }: Row) => structuredClone(state.doctors.find(item => item.authId === where.authId) ?? null),
    },
    profileWorkflow: {
      findUnique: async ({ where }: Row) => structuredClone(state.workflows.find(item => item.id === where.id) ?? null),
      create: async ({ data }: Row) => { state.workflows.push(structuredClone(data)); return structuredClone(data); },
      update: async ({ where, data }: Row) => { trip('workflow'); Object.assign(state.workflows.find(item => item.id === where.id)!, structuredClone(data)); },
    },
    commandOperation: {
      findUnique: async ({ where: { actorId_operationId: key } }: Row) => structuredClone(state.commands.find(item => item.actorId === key.actorId && item.operationId === key.operationId) ?? null),
      create: async ({ data }: Row) => { state.commands.push(structuredClone(data)); return structuredClone(data); },
      update: async ({ where, data }: Row) => { trip('journal'); Object.assign(state.commands.find(item => item.id === where.id)!, structuredClone(data)); },
    },
    outboxEvent: { create: async ({ data }: Row) => { trip('outbox'); state.events.push(structuredClone(data)); return data; } },
    profileSyncIntent: { create: async ({ data }: Row) => { trip('intent'); state.intents.push(structuredClone(data)); return data; } },
  };
  const db = { profileWorkflow: tx.profileWorkflow, $transaction: async (run: (client: typeof tx) => Promise<unknown>, options: Row) => {
    assert.equal(options.isolationLevel, 'Serializable');
    transactions++;
    const prior = tail;
    let unlock!: () => void;
    tail = new Promise<void>(resolve => { unlock = resolve; });
    await prior;
    beforeTransaction?.(); beforeTransaction = undefined;
    const previous = structuredClone(state);
    inTransaction = true;
    try { const result = await run(tx); trip('commit'); return result; }
    catch (error) { state = previous; throw error; }
    finally { inTransaction = false; unlock(); }
  } } as unknown as CorePrismaClient;
  const owner = createPortalDoctorProvision(db, { writes: true,
    verifyIdentity: async id => { assert.equal(inTransaction, false); verifiedIds.push(id); verifications++; if (!identityActive) throw new Error('fixture-identity-revoked'); },
    syncStatus: async id => { assert.equal(id, targetAuthId); return sync; },
  });
  const actor = (route: string): Actor => ({ authId: subject, role: 'service', serviceId: 'vital-web',
    scopes: ['portal.integration.' + route.replaceAll('/', '.')], resource: 'portal:' + route,
    correlationId: randomUUID(), isSuperAdmin: false });
  const prepareBody = { workflowId, targetAuthId, input };
  const receipt = { workflowId, actorAuthId: subject, targetAuthId,
    inputHash: requestHash('PROFILE', 'portal.doctor.provision', { targetAuthId, input }), expectedVersion: -1,
    department: { id: 'trace-cardiology', name: 'Cardiology' } };
  const commitBody = { targetAuthId, input, receipt };
  const prepareRoute = 'doctors/workflows', commitRoute = prepareRoute + '/' + workflowId + '/commit';
  const metadata = (route: string, body: unknown) => ({ operationId: randomUUID(),
    requestHash: requestHash('POST', '/internal/v1/portal-integrations/' + route, body) });
  const prepareMetadata = metadata(prepareRoute, prepareBody), commitMetadata = metadata(commitRoute, commitBody);
  const execute = (route: string, body: unknown, meta = metadata(route, body), who = actor(route), delegated = source) =>
    owner.execute(who, delegated, 'POST', '/internal/v1/portal-integrations/' + route, body, meta);
  return { owner, source, subject, targetAuthId, workflowId, input, receipt, prepareBody, commitBody,
    prepareRoute, commitRoute, prepareMetadata, commitMetadata, actor, execute,
    prepare: () => execute(prepareRoute, prepareBody, prepareMetadata),
    commit: () => execute(commitRoute, commitBody, commitMetadata),
    get state() { return state; }, get verifications() { return verifications; }, get transactions() { return transactions; }, verifiedIds,
    fail: (point: string, code?: string) => { failure = point; failureCode = code; },
    setSync: (value: typeof sync) => { sync = value; }, revokeIdentity: () => { identityActive = false; },
    beforeTransaction: (run: () => void) => { beforeTransaction = run; },
  };
}
