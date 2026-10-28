import { accessFixtureSql } from './fixtures/appointment-access.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import type { Actor } from '../src/eda/contracts/actor.js';
import { DomainError } from '../src/eda/contracts/actor.js';
import { calculateMessageAccess, linkedMessageAppointments, type MessagingAppointment } from '../src/eda/modules/appointment/appointment-messaging.js';
import { createMessageCrypto } from '../src/eda/modules/messaging/crypto.js';
import { createMessagingModule, messageCursor, messageInput } from '../src/eda/modules/messaging/messages.js';
import { makeEvent } from '../src/eda/infrastructure/outbox.js';
import { consumeMessagingEvent } from '../src/eda/workers/messaging.js';

const environment = { MESSAGE_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 7).toString('base64') }), MESSAGE_ACTIVE_KEY_VERSION: '1' };
const isStatus = (status: number) => (error: unknown) => error instanceof DomainError && error.status === status;
function fixture() {
  const id = randomUUID(), patientId = randomUUID(), doctorId = randomUUID(), authId = randomUUID(), doctorAuthId = randomUUID();
  let now = Date.parse('2026-10-17T00:00:00Z');
  type Appointment = MessagingAppointment & { patientAuthId: string; doctorAuthId: string; version: number; billingLineageId: string; scheduledAt: Date; specialty: string | null };
  const row: Appointment = { id, patientId, doctorId, patientAuthId: authId, doctorAuthId, status: 'approved', version: 1, completedAt: null,
    appointmentKind: 'standard', followUpOfAppointmentId: null, sourceAppointmentId: null, billingLineageId: randomUUID(), statusLogs: [], proposedEndAt: new Date(now + 3_600_000), slotEndsAt: null, scheduledAt: new Date(now), specialty: 'General' };
  type Stored = Record<string, unknown>;
  let state = { row, rows: [row], messages: [] as Stored[], conversation: null as Stored | null, conversations: new Map<string, Stored>(), commands: new Map<string, Stored>(), events: [] as Stored[], signals: [] as unknown[] };
  const members = new Map([[authId, { userId: patientId, role: 'patient' }], [doctorAuthId, { userId: doctorId, role: 'doctor' }]]);
  let previous = structuredClone(state), revoked = false, pending = false, rateCount: number | null = null, failOutbox = false, revokeOnCalendar = false;
  let calendarHook: (() => void) | undefined;
  const calls: string[] = [];
  const queries: { sql: string; args: unknown[] }[] = [];
  const tx = { async query(sql: string, args: unknown[] = []) {
    const privacy=accessFixtureSql(sql,args,state.row);if(privacy)return privacy;
    calls.push(sql); queries.push({ sql, args: structuredClone(args) });
    const result = (rows: Stored[] = [], rowCount = rows.length) => ({ rows: structuredClone(rows), rowCount });
    if (sql.startsWith('BEGIN')) { previous = structuredClone(state); return result(); }
    if (sql === 'ROLLBACK') { state = previous; return result(); }
    if (sql.includes('pg_advisory_xact_lock') && String(args[0]).startsWith('appointment-calendar:')) {
      if (revokeOnCalendar) revoked = true;
      const run = calendarHook; calendarHook = undefined; run?.();
    }
    if (sql === 'COMMIT' || sql.includes('pg_advisory_xact_lock')) return result();
    if (sql.includes('SELECT p.* FROM vital_')) {
      const member = members.get(String(args[0]));
      return result(!revoked && member?.role === args[1] ? [member] : []);
    }
    if (sql.includes('SELECT a.*')) return result(state.rows.filter(item => item.id === args[0]));
    if (sql.includes('ORDER BY a.id LIMIT 2001'))
      return result(state.rows.filter(item => item.patientId === args[0] && item.doctorId === args[1]).sort((a, b) => a.id.localeCompare(b.id)).slice(0, 2001));
    if (sql.includes('AS "counterpartAuthId"')) {
      const doctor = sql.includes('WHERE a."doctorId"=$1');
      let rows = state.rows.filter(item => (doctor ? item.doctorId : item.patientId) === args[0] && (args[1] as string[]).includes(item.status));
      if (sql.includes('AND a.id=$3')) rows = rows.filter(item => item.id === args[2]);
      else rows = rows.filter(item => !args[2] || +item.scheduledAt < +(args[2] as Date) || +item.scheduledAt === +(args[2] as Date) && item.id < String(args[3]));
      return result(rows.sort((a, b) => +b.scheduledAt - +a.scheduledAt || b.id.localeCompare(a.id)).slice(0, 51)
        .map(item => ({ ...item, counterpartAuthId: doctor ? item.patientAuthId : item.doctorAuthId })));
    }
    if (sql.includes('FROM appointment_logs')) return result(state.rows.filter(item => (args[0] as string[]).includes(item.id))
      .flatMap(item => item.statusLogs.filter(log => ['approved', 'confirmed', 'cancelled'].includes(log.toStatus)).map(log => ({ appointmentId: item.id, ...log }))));
    if (sql.includes('FROM saga_operations')) return result(pending ? [{ id: randomUUID() }] : []);
    if (sql.includes('FROM appointment_workflows')) return result();
    if (sql.includes('SELECT * FROM command_operations')) {
      const found = state.commands.get(`${args[0]}:${args[1]}`); return result(found ? [found] : []);
    }
    if (sql.includes('INSERT INTO command_operations')) { state.commands.set(`${args[1]}:${args[2]}`, { action: args[3], resourceId: args[4], requestHash: args[5], status: 'completed', result: JSON.parse(String(args[6])) }); return result([], 1); }
    if (sql.startsWith('SELECT * FROM message_conversations')) {
      const found = state.conversations.get(String(args[0])); return result(found ? [found] : []);
    }
    if (sql.startsWith('INSERT INTO message_conversations')) {
      const conversation = { id: args[0], appointmentId: args[1], version: 0, purgedAt: null, patientLastReadAt: null, doctorLastReadAt: null };
      state.conversations.set(String(args[1]), conversation); if (args[1] === id) state.conversation = conversation;
      return result([conversation]);
    }
    if (sql.startsWith('SELECT COUNT(*)')) return result([{ count: rateCount ?? state.messages.filter(message => message.senderUserId === args[0] && +(message.createdAt as Date) >= +(args[1] as Date)).length }]);
    if (sql.startsWith('SELECT MAX(')) {
      const messages = state.messages.filter(message => message.conversationId === args[0]);
      return result([{ lastMessageAt: messages.length ? new Date(Math.max(...messages.map(message => +(message.createdAt as Date)))) : null,
        unreadCount: messages.filter(message => message.senderRole === args[1] && (!args[2] || +(message.createdAt as Date) > +(args[2] as Date))).length }]);
    }
    if (sql.startsWith('SELECT * FROM appointment_messages')) {
      const messages = state.messages.filter(message => message.conversationId === args[0]);
      if (sql.includes('clientMessageId')) return result(messages.filter(message => message.clientMessageId === args[2] && message.senderUserId === args[1]));
      return result(messages.filter(message => !args[1] || +(message.createdAt as Date) < +(args[1] as Date) || +(message.createdAt as Date) === +(args[1] as Date) && String(message.id) < String(args[2]))
        .sort((a, b) => +(b.createdAt as Date) - +(a.createdAt as Date) || String(b.id).localeCompare(String(a.id))).slice(0, 31));
    }
    if (sql.startsWith('SELECT "createdAt" FROM appointment_messages')) return result(state.messages.filter(message => message.id === args[0] && message.conversationId === args[1]));
    if (sql.startsWith('INSERT INTO appointment_messages')) {
      const message = { id: args[0], conversationId: args[1], senderUserId: args[2], senderRole: args[3], clientMessageId: args[4], ciphertext: args[5], nonce: args[6], authTag: args[7], keyVersion: args[8], createdAt: args[9] };
      state.messages.push(message); return result([message]);
    }
    if (sql.startsWith('UPDATE message_conversations')) {
      const conversation = [...state.conversations.values()].find(item => item.id === args[0])!;
      const field = /SET "(patientLastReadAt|doctorLastReadAt)"/.exec(sql)?.[1];
      if (field) {
        if (conversation[field] && (conversation[field] as Date) >= (args[1] as Date)) return result();
        conversation[field] = args[1];
      }
      conversation.version = Number(conversation.version) + 1; return result([conversation]);
    }
    if (sql.includes('INSERT INTO outbox_events')) { if (failOutbox) throw new Error('TEST_OUTBOX_FAILED'); state.events.push({ eventType: args[1], payload: JSON.parse(String(args[8])) }); return result([], 1); }
    if (sql.includes('pg_notify')) { state.signals.push(args); return result(); }
    throw new Error('UNEXPECTED_MESSAGING_SQL:' + sql);
  }, release() {} };
  const pool = { connect: async () => tx } as unknown as Pool;
  const actor = (action: string, role: Actor['role'] = 'patient', who = role === 'doctor' ? doctorAuthId : authId, resource = action === 'conversations' ? who : id): Actor => {
    if (!members.has(who) && ['patient', 'doctor'].includes(role)) members.set(who, { userId: randomUUID(), role });
    return { authId: who, role, scopes: ['messaging.' + action], resource, serviceId: 'vital-web', correlationId: randomUUID(), isSuperAdmin: false };
  };
  const meta = () => ({ operationId: randomUUID(), requestHash: 'a'.repeat(64) });
  return { id, get now() { return now; }, pool, calls, queries, actor, meta, state: () => state, module: createMessagingModule(pool, environment, () => now),
    advance: (milliseconds: number) => { now += milliseconds; }, onCalendar: (run: () => void) => { calendarHook = run; },
    pending: () => { pending = true; }, revoke: () => { revoked = true; }, revokeAtCalendar: () => { revokeOnCalendar = true; },
    rate: () => { rateCount = 10; }, fail: () => { failOutbox = true; } };
}

test('EDA Messaging encryption preserves legacy AAD rotation and rejects substitution', () => {
  const crypto = createMessageCrypto(environment), id = randomUUID(), appointmentId = randomUUID();
  const encrypted = { id, ...crypto.encrypt('private body', appointmentId, id) };
  assert.equal(crypto.decrypt(encrypted, appointmentId), 'private body');
  assert.throws(() => crypto.decrypt(encrypted, randomUUID()));
  assert.throws(() => crypto.decrypt({ ...encrypted, id: randomUUID() }, appointmentId));
  assert.throws(() => crypto.decrypt({ ...encrypted, authTag: Buffer.from(encrypted.authTag, 'base64').subarray(0, 4).toString('base64') }, appointmentId), /MESSAGE_CIPHER_INVALID/);
  assert.throws(() => crypto.decrypt({ ...encrypted, nonce: encrypted.nonce + ' ' }, appointmentId), /MESSAGE_CIPHER_INVALID/);
  const rotated = createMessageCrypto({ MESSAGE_ACTIVE_KEY_VERSION: '2', MESSAGE_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 7).toString('base64'), 2: Buffer.alloc(32, 8).toString('base64') }) });
  assert.equal(rotated.decrypt(encrypted, appointmentId), 'private body');
  assert.throws(() => createMessageCrypto({}).assertConfigured());
});
test('EDA Messaging preserves completed follow-up replacement and cancellation windows', () => {
  const first = completedVisit();
  const followup = { ...first, id: randomUUID(), status: 'approved', appointmentKind: 'follow_up', followUpOfAppointmentId: first.id,
    scheduledAt: new Date('2026-10-10T10:00Z'), proposedEndAt: new Date('2026-10-10T11:00Z') };
  const chain = [first, followup];
  assert.equal(calculateMessageAccess(first, chain, new Date('2026-10-09T09:59:59.999Z')).canSend, false);
  assert.equal(calculateMessageAccess(first, chain, new Date('2026-10-09T10:00Z')).canSend, true);
  assert.equal(calculateMessageAccess(first, chain, new Date('2026-10-11T11:00Z')).canSend, false);
  const cancelled = { ...followup, status: 'cancelled' };
  assert.equal(calculateMessageAccess(first, [first, cancelled], new Date('2026-10-10')).canSend, false);
  assert.equal(calculateMessageAccess(cancelled, [first, cancelled], new Date('2026-10-10')).availabilityReason, 'cancelled');
  for (const field of ['patientId', 'doctorId'] as const)
    assert.equal(calculateMessageAccess(first, [first, { ...followup, [field]: randomUUID() }], new Date('2026-10-10')).canSend, false);
});
test('EDA Messaging schemas reject authority fields invalid cursors and oversized bodies', () => {
  assert.throws(() => messageInput.parse({ content: 'hello', clientMessageId: randomUUID(), senderUserId: randomUUID() }));
  assert.throws(() => messageInput.parse({ content: 'a'.repeat(2001), clientMessageId: randomUUID() }));
  assert.throws(() => messageCursor('not-json'), isStatus(400));
});
test('EDA Messaging actual send deduplicates and journals references without plaintext', async () => {
  const f = fixture(), meta = f.meta(), input = { content: 'PRIVATE-BODY', clientMessageId: randomUUID() };
  assert.equal((await f.module.send(f.actor('send'), f.id, meta, input)).created, true);
  f.rate();
  assert.equal((await f.module.send(f.actor('send'), f.id, meta, input)).created, false);
  assert.equal((await f.module.send(f.actor('send'), f.id, f.meta(), input)).created, false);
  assert.equal(f.state().messages.length, 1);
  assert.equal(f.state().events.length, 2);
  assert.doesNotMatch(JSON.stringify([...f.state().commands.values(), ...f.state().events, ...f.state().messages]), /PRIVATE-BODY/);
  await assert.rejects(f.module.send(f.actor('send'), f.id, meta, { ...input, content: 'changed' }), isStatus(409));
  f.revoke(); await assert.rejects(f.module.send(f.actor('send'), f.id, meta, input), isStatus(403));
});
test('EDA Messaging isolation processing and throttles deny before message creation', async () => {
  const input = { content: 'hello', clientMessageId: randomUUID() };
  const f = fixture();
  await assert.rejects(f.module.send(f.actor('send', 'patient', randomUUID()), f.id, f.meta(), input), isStatus(404));
  await assert.rejects(f.module.send(f.actor('send', 'admin'), f.id, f.meta(), input), isStatus(403));
  f.pending(); await assert.rejects(f.module.send(f.actor('send'), f.id, f.meta(), input), isStatus(409));
  const throttled = fixture(); throttled.rate(); await assert.rejects(throttled.module.send(throttled.actor('send'), throttled.id, throttled.meta(), input), isStatus(429));
  assert.equal(f.state().messages.length, 0); assert.equal(throttled.state().messages.length, 0);
  assert.equal(f.calls.find(sql => sql.startsWith('BEGIN')), 'BEGIN ISOLATION LEVEL READ COMMITTED');
});
test('EDA Messaging outbox failure rolls back encrypted message journal and signals', async () => {
  const f = fixture(); f.fail();
  await assert.rejects(f.module.send(f.actor('send'), f.id, f.meta(), { content: 'hello', clientMessageId: randomUUID() }), /TEST_OUTBOX_FAILED/);
  assert.equal(f.state().messages.length, 0); assert.equal(f.state().commands.size, 0); assert.equal(f.state().conversation, null);
});

test('EDA Messaging rechecks membership after waiting for the lifecycle lock', async () => {
  const f = fixture(); f.revokeAtCalendar();
  await assert.rejects(f.module.send(f.actor('send'), f.id, f.meta(), { content: 'hello', clientMessageId: randomUUID() }), isStatus(403));
  assert.equal(f.state().messages.length, 0); assert.equal(f.state().commands.size, 0);
});
test('EDA Messaging history stays read-only after cancellation and read retries do not duplicate audit', async () => {
  const f = fixture();
  const sent = await f.module.send(f.actor('send'), f.id, f.meta(), { content: 'hello', clientMessageId: randomUUID() });
  f.state().row.status = 'cancelled';
  const history = await f.module.history(f.actor('history'), f.id);
  assert.equal(history.canSend, false); assert.equal(history.messages[0]?.content, 'hello');
  const meta = f.meta();
  await f.module.read(f.actor('read'), f.id, meta, { messageId: sent.message.id });
  await f.module.read(f.actor('read'), f.id, meta, { messageId: sent.message.id });
  assert.equal(f.state().events.filter(event => event.eventType === 'vital.audit.requested').length, 2);
});
test('EDA Messaging consumer rejects substituted committed event payloads before invalidation', async () => {
  const conversationId = randomUUID();
  const event = makeEvent({ producer: 'messaging', eventType: 'vital.messaging.changed', aggregateId: conversationId, aggregateVersion: 1, correlationId: randomUUID(),
    data: { appointmentId: randomUUID(), conversationId, actorAuthId: randomUUID(), kind: 'message' } });
  let committed = false;
  const tx = { async query(sql: string) {
    if (sql.includes('INSERT INTO inbox_events')) return { rowCount: 1, rows: [] };
    if (sql.includes('FROM outbox_events')) return { rows: [{ eventType: event.eventType, aggregateId: event.aggregateId, aggregateVersion: event.aggregateVersion, payload: { ...event.data, kind: 'read' } }] };
    if (sql === 'COMMIT') committed = true;
    return { rows: [] };
  }, release() {} };
  await assert.rejects(consumeMessagingEvent({ connect: async () => tx } as unknown as Pool, event, 'messaging-state'), /MESSAGING_SOURCE_EVIDENCE_MISSING/);
  assert.equal(committed, false);
});

test('EDA Messaging owner enforces the complete lifecycle status matrix for history and sends', async () => {
  const cases = [
    { status: 'pending', history: false, send: false },
    { status: 'approved', history: true, send: true },
    { status: 'confirmed', history: true, send: true },
    { status: 'pending_patient_confirmation', history: false, send: false },
    { status: 'pending_payment_verification', history: false, send: false },
    { status: 'rejected', history: false, send: false },
    { status: 'rescheduled', history: true, send: false },
    { status: 'cancelled', history: true, send: false },
    { status: 'completed', history: true, send: true },
  ];
  for (const item of cases) {
    const f = fixture(); f.state().row.status = item.status;
    if (item.status === 'completed') f.state().row.completedAt = new Date(f.now - 86_400_000);
    if (item.history) assert.equal((await f.module.history(f.actor('history'), f.id)).canSend, item.send, item.status);
    else await assert.rejects(f.module.history(f.actor('history'), f.id), { status: 404, code: 'CONVERSATION_NOT_FOUND' });
    assert.equal(f.state().conversations.size, 0, item.status + ' history must not insert');
    const sending = f.module.send(f.actor('send'), f.id, f.meta(), { content: item.status, clientMessageId: randomUUID() });
    if (item.send) {
      assert.equal((await sending).created, true); assert.equal(f.state().messages.length, 1);
    } else {
      await assert.rejects(sending, { status: item.history ? 409 : 404, code: item.history ? 'MESSAGE_READ_ONLY' : 'CONVERSATION_NOT_FOUND' });
      assert.equal(f.state().messages.length, 0); assert.equal(f.state().commands.size, 0); assert.equal(f.state().conversations.size, 0);
      assert.equal(f.state().events.length, 0); assert.equal(f.state().signals.length, 0);
    }
  }
});

function completedVisit(): MessagingAppointment {
  return { id: randomUUID(), patientId: randomUUID(), doctorId: randomUUID(), status: 'completed', completedAt: new Date('2026-10-01T11:00Z'),
    scheduledAt: new Date('2026-10-01T10:00Z'), proposedEndAt: new Date('2026-10-01T11:00Z'), slotEndsAt: null,
    appointmentKind: 'standard', followUpOfAppointmentId: null, sourceAppointmentId: null, statusLogs: [] };
}

test('EDA Messaging policy merges overlapping windows without bridging future gaps', () => {
  const first = completedVisit();
  const follow = { ...first, id: randomUUID(), appointmentKind: 'follow_up', followUpOfAppointmentId: first.id,
    scheduledAt: new Date('2026-10-10T10:00Z'), proposedEndAt: new Date('2026-10-10T11:00Z') };
  const overlap = { ...follow, id: randomUUID(), followUpOfAppointmentId: follow.id,
    scheduledAt: new Date('2026-10-12T10:00Z'), proposedEndAt: new Date('2026-10-12T11:00Z') };
  const distant = { ...overlap, id: randomUUID(), followUpOfAppointmentId: overlap.id,
    scheduledAt: new Date('2026-11-01T10:00Z'), proposedEndAt: new Date('2026-11-01T11:00Z') };
  const rows = [first, follow, overlap, distant];
  assert.equal(linkedMessageAppointments(first, rows).length, 4);
  const before = calculateMessageAccess(first, rows, new Date('2026-10-09T09:59:59.999Z'));
  assert.equal(before.canSend, false); assert.equal(before.nextOpenAt, '2026-10-09T10:00:00.000Z');
  for (const time of ['2026-10-09T10:00Z', '2026-10-11T10:30Z', '2026-10-13T10:59:59.999Z']) {
    const access = calculateMessageAccess(first, rows, new Date(time));
    assert.equal(access.canSend, true); assert.equal(access.sendUntil, '2026-10-13T11:00:00.000Z');
    assert.equal(access.hasActiveFollowUp, true);
  }
  const gap = calculateMessageAccess(first, rows, new Date('2026-10-13T11:00Z'));
  assert.equal(gap.canSend, false); assert.equal(gap.nextOpenAt, '2026-10-31T10:00:00.000Z');
});

test('EDA Messaging policy follows accepted replacements but ignores pending rejected and declined proposals', () => {
  const first = completedVisit();
  const old = { ...first, id: randomUUID(), status: 'rescheduled', appointmentKind: 'follow_up', followUpOfAppointmentId: first.id };
  const replacement = { ...first, id: randomUUID(), status: 'confirmed', sourceAppointmentId: old.id,
    scheduledAt: new Date('2026-12-01T10:00Z'), proposedEndAt: new Date('2026-12-01T11:00Z') };
  const rows = [first, old, replacement];
  assert.equal(calculateMessageAccess(first, rows, new Date('2026-11-30T09:59:59.999Z')).canSend, false);
  assert.equal(calculateMessageAccess(first, rows, new Date('2026-11-30T10:00Z')).canSend, true);
  assert.equal(calculateMessageAccess(old, rows, new Date('2026-12-01')).availabilityReason, 'rescheduled');
  for (const status of ['pending', 'pending_patient_confirmation', 'pending_payment_verification', 'rejected', 'cancelled']) {
    assert.equal(calculateMessageAccess(first, [first, old, { ...replacement, status }], new Date('2026-12-01')).canSend, false, status);
  }
});

test('EDA Messaging policy uses scheduled ends rather than completion and fails closed for missing schedules', () => {
  const first = completedVisit();
  for (const completedAt of [null, new Date('2026-09-01'), new Date('2026-12-01')]) {
    assert.equal(calculateMessageAccess({ ...first, completedAt }, [], new Date('2026-10-02T10:59:59.999Z')).canSend, true);
    assert.equal(calculateMessageAccess({ ...first, completedAt }, [], new Date('2026-10-02T11:00Z')).canSend, false);
  }
  for (const proposedEndAt of [null, first.scheduledAt, new Date('invalid')]) {
    assert.equal(calculateMessageAccess({ ...first, proposedEndAt }, [], new Date('2026-10-01')).availabilityReason, 'schedule_unavailable');
  }
  const slotted = { ...first, slotEndsAt: new Date('2026-10-01T12:00Z') };
  assert.equal(calculateMessageAccess(slotted, [], new Date('2026-10-02T11:30Z')).sendUntil, '2026-10-02T12:00:00.000Z');
  const approved = { ...first, status: 'approved', scheduledAt: new Date('2026-12-01T10:00Z'), proposedEndAt: new Date('2026-12-01T11:00Z') };
  assert.equal(calculateMessageAccess(approved, [], new Date('2026-10-01')).canSend, true);
  assert.equal(calculateMessageAccess(approved, [], new Date('2026-12-02T11:00Z')).canSend, false);
});

test('EDA Messaging owner hides unknown and foreign history identically without writes', async () => {
  const f = fixture();
  const denial = async (actor: Actor, id: string) => {
    try { await f.module.history(actor, id); assert.fail('Expected hidden history'); }
    catch (error) { assert.ok(error instanceof DomainError); return { status: error.status, code: error.code, message: error.message }; }
  };
  const missingId = randomUUID();
  const unknown = await denial({ ...f.actor('history'), resource: missingId }, missingId);
  const foreign = await denial(f.actor('history', 'patient', randomUUID()), f.id);
  assert.deepEqual(unknown, { status: 404, code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found.' });
  assert.deepEqual(foreign, unknown);
  const before = f.calls.filter(sql => sql.includes('SELECT a.*')).length;
  await assert.rejects(f.module.history(f.actor('history', 'admin'), f.id), { status: 403, code: 'APPOINTMENT_ROLE_DENIED' });
  assert.equal(f.calls.filter(sql => sql.includes('SELECT a.*')).length, before);
  assert.equal(f.calls.some(sql => /^(INSERT|UPDATE|DELETE)/.test(sql)), false);
  assert.equal(f.state().conversations.size, 0); assert.equal(f.state().messages.length, 0); assert.equal(f.state().commands.size, 0);
});

test('EDA Messaging owner returns empty eligible history without creating conversations', async () => {
  const f = fixture();
  for (const role of ['patient', 'doctor'] as const) assert.deepEqual(await f.module.history(f.actor('history', role), f.id),
    { messages: [], nextCursor: null, canSend: true, sendUntil: new Date(f.now + 90_000_000).toISOString(), hasActiveFollowUp: false, nextOpenAt: null, availabilityReason: 'open' });
  assert.equal(f.state().conversation, null); assert.equal(f.state().conversations.size, 0);
  assert.equal(f.state().messages.length, 0); assert.equal(f.state().commands.size, 0); assert.equal(f.state().events.length, 0); assert.equal(f.state().signals.length, 0);
  assert.equal(f.calls.some(sql => /^(INSERT|UPDATE|DELETE)/.test(sql)), false);
});

test('EDA Messaging owner gives assigned doctors history and monotonic read receipts', async () => {
  const f = fixture();
  const first = await f.module.send(f.actor('send'), f.id, f.meta(), { content: 'patient first', clientMessageId: randomUUID() });
  f.advance(1000);
  const second = await f.module.send(f.actor('send'), f.id, f.meta(), { content: 'patient second', clientMessageId: randomUUID() });
  f.advance(1000);
  const reply = await f.module.send(f.actor('send', 'doctor'), f.id, f.meta(), { content: 'doctor reply', clientMessageId: randomUUID() });
  const doctor = await f.module.history(f.actor('history', 'doctor'), f.id), patient = await f.module.history(f.actor('history'), f.id);
  assert.deepEqual(doctor.messages.map(m=>m.content),patient.messages.map(()=> 'Message withheld for privacy'));assert.ok(doctor.messages.filter(m=>m.senderRole==='patient').every(m=>m.senderUserId===null)); assert.deepEqual(doctor.messages.map(message => message.id), [first.message.id, second.message.id, reply.message.id]);
  assert.equal(reply.message.senderRole, 'doctor'); assert.equal(reply.message.senderUserId, f.state().row.doctorId);
  assert.equal((await f.module.conversations(f.actor('conversations', 'doctor'))).conversations[0]!.unreadCount, 2);
  assert.equal((await f.module.conversations(f.actor('conversations'))).conversations[0]!.unreadCount, 1);
  const meta = f.meta();
  await f.module.read(f.actor('read', 'doctor'), f.id, meta, { messageId: second.message.id });
  const afterRead = structuredClone(f.state());
  await f.module.read(f.actor('read', 'doctor'), f.id, meta, { messageId: second.message.id });
  assert.deepEqual(f.state(), afterRead);
  await f.module.read(f.actor('read', 'doctor'), f.id, f.meta(), { messageId: first.message.id });
  assert.equal((f.state().conversation!.doctorLastReadAt as Date).toISOString(), second.message.createdAt);
  assert.equal(f.state().conversation!.patientLastReadAt, null);
  assert.equal((await f.module.conversations(f.actor('conversations', 'doctor'))).conversations[0]!.unreadCount, 0);
  assert.equal(f.state().events.length, afterRead.events.length); assert.equal(f.state().signals.length, afterRead.signals.length);
  await assert.rejects(f.module.history(f.actor('history', 'doctor', randomUUID()), f.id), { status: 404, code: 'CONVERSATION_NOT_FOUND' });
});

test('EDA Messaging owner aligns reopened inbox history and encrypted send within participant-scoped chains', async () => {
  for (const status of ['approved', 'confirmed']) {
    const f = fixture(); f.state().row.status = 'completed'; f.state().row.completedAt = new Date(f.now - 30 * 86_400_000);
    const followup = { ...f.state().row, id: randomUUID(), status, completedAt: null, appointmentKind: 'follow_up', followUpOfAppointmentId: f.id };
    f.state().row.scheduledAt = new Date(f.now - 30 * 86_400_000); f.state().row.proposedEndAt = new Date(f.now - 30 * 86_400_000 + 3_600_000);
    const unrelated = { ...followup, id: randomUUID(), followUpOfAppointmentId: null };
    const foreignPatient = { ...followup, id: randomUUID(), patientId: randomUUID(), patientAuthId: randomUUID() };
    const foreignDoctor = { ...followup, id: randomUUID(), doctorId: randomUUID(), doctorAuthId: randomUUID() };
    f.state().rows.push(followup, unrelated, foreignPatient, foreignDoctor);
    const sent = await f.module.send(f.actor('send'), f.id, f.meta(), { content: 'REOPENED-PRIVATE', clientMessageId: randomUUID() });
    assert.equal(sent.created, true); assert.ok(f.state().messages[0]!.ciphertext);
    assert.doesNotMatch(JSON.stringify([f.state().messages, f.state().events, [...f.state().commands.values()]]), /REOPENED-PRIVATE/);
    const history = await f.module.history(f.actor('history'), f.id);
    assert.equal(history.canSend, true); assert.equal(history.hasActiveFollowUp, true); assert.equal(history.messages[0]!.content, 'REOPENED-PRIVATE');
    const followActor = { ...f.actor('history'), resource: followup.id };
    assert.deepEqual((await f.module.history(followActor, followup.id)).messages, []);
    assert.equal(f.state().conversations.size, 1, 'reopening must not merge or create a follow-up thread');
    f.advance(1000);
    const followMessage = await f.module.send({ ...f.actor('send'), resource: followup.id }, followup.id, f.meta(), { content: 'follow-up only', clientMessageId: randomUUID() });
    assert.equal(f.state().conversations.size, 2);
    assert.deepEqual((await f.module.history(f.actor('history'), f.id)).messages.map(message => message.id), [sent.message.id]);
    assert.deepEqual((await f.module.history(followActor, followup.id)).messages.map(message => message.id), [followMessage.message.id]);
    for (const role of ['patient', 'doctor'] as const) {
      const inbox = await f.module.conversations(f.actor('conversations', role));
      const item = inbox.conversations.find(row => row.appointmentId === f.id)!;
      assert.deepEqual({ canSend: item.canSend, sendUntil: item.sendUntil, hasActiveFollowUp: item.hasActiveFollowUp },
        { canSend: history.canSend, sendUntil: history.sendUntil, hasActiveFollowUp: history.hasActiveFollowUp });
      for (const query of f.queries.filter(query => query.sql.includes('ORDER BY a.id LIMIT 2001'))) {
        assert.ok(query.sql.includes('AND a."doctorId"=$2'));
        // The inbox may inspect other pairs, but every chain query binds both dimensions.
        assert.equal(query.args.length, 2); assert.ok(query.args.every(value => typeof value === 'string'));
      }
    }
    const ownQueries = f.queries.filter(query => query.sql.includes('ORDER BY a.id LIMIT 2001'));
    assert.ok(ownQueries.some(query => query.args[0] === f.state().row.patientId && query.args[1] === f.state().row.doctorId));
    f.state().rows.find(row => row.id === followup.id)!.status = 'rejected';
    const closed = await f.module.history(f.actor('history'), f.id);
    assert.equal(closed.canSend, false, 'foreign participants and unlinked active visits must not reopen the root');
    assert.equal((await f.module.conversations(f.actor('conversations'))).conversations.find(row => row.appointmentId === f.id)!.canSend, false);
  }
});

test('EDA Messaging owner rejects the eleventh same-sender message without writes', async () => {
  const f = fixture();
  const second = { ...f.state().row, id: randomUUID(), status: 'confirmed' }; f.state().rows.push(second);
  for (let index = 0; index < 10; index++) {
    const id = index < 5 ? f.id : second.id;
    assert.equal((await f.module.send({ ...f.actor('send'), resource: id }, id, f.meta(), { content: 'number-' + index, clientMessageId: randomUUID() })).created, true);
  }
  const before = structuredClone(f.state());
  await assert.rejects(f.module.send(f.actor('send'), f.id, f.meta(), { content: 'eleventh', clientMessageId: randomUUID() }), { status: 429, code: 'MESSAGE_RATE_LIMIT' });
  assert.deepEqual(f.state(), before); assert.equal(f.state().messages.length, 10);
  assert.equal(f.state().commands.size, 10); assert.equal(f.state().events.length, 20); assert.equal(f.state().signals.length, 10);
  const count = f.queries.filter(query => query.sql.startsWith('SELECT COUNT(*)')).at(-1)!;
  assert.ok(count.sql.includes('COUNT(*)::integer')); assert.equal(count.args[0], f.state().row.patientId);
  assert.equal((count.args[1] as Date).getTime(), f.now - 60_000);
  assert.equal((await f.module.send(f.actor('send', 'doctor'), f.id, f.meta(), { content: 'independent doctor budget', clientMessageId: randomUUID() })).created, true);
  f.advance(60_001);
  assert.equal((await f.module.send(f.actor('send'), f.id, f.meta(), { content: 'next window', clientMessageId: randomUUID() })).created, true);
  assert.equal(f.state().messages.length, 12);
});

test('EDA Messaging owner preserves committed same-ID retries after the send window closes', async () => {
  const f = fixture(); f.state().row.status = 'completed'; f.state().row.completedAt = new Date(f.now - 6 * 86_400_000);
  const meta = f.meta(), input = { content: 'committed before deadline', clientMessageId: randomUUID() };
  const sent = await f.module.send(f.actor('send'), f.id, meta, input);
  f.advance(2 * 86_400_000);
  assert.equal((await f.module.history(f.actor('history'), f.id)).canSend, false);
  const closed = structuredClone(f.state());
  assert.deepEqual(await f.module.send(f.actor('send'), f.id, meta, input), { message: sent.message, created: false });
  assert.deepEqual(f.state(), closed);
  assert.deepEqual(await f.module.send(f.actor('send'), f.id, f.meta(), input), { message: sent.message, created: false });
  assert.equal(f.state().commands.size, 2); assert.equal(f.state().messages.length, 1); assert.equal(f.state().events.length, 2); assert.equal(f.state().signals.length, 1);
  const retried = structuredClone(f.state());
  await assert.rejects(f.module.send(f.actor('send'), f.id, meta, { ...input, content: 'substitution' }), { status: 409, code: 'COMMAND_REPLAY_CONFLICT' });
  await assert.rejects(f.module.send(f.actor('send'), f.id, f.meta(), { ...input, content: 'substitution' }), { status: 409, code: 'MESSAGE_REPLAY_CONFLICT' });
  await assert.rejects(f.module.send(f.actor('send'), f.id, f.meta(), { ...input, clientMessageId: randomUUID() }), { status: 409, code: 'MESSAGE_READ_ONLY' });
  assert.deepEqual(f.state(), retried);
});

test('EDA Messaging owner rechecks the scheduled deadline after waiting for lifecycle locks', async () => {
  const f = fixture(); f.state().row.status = 'completed'; f.state().row.completedAt = new Date(f.now); f.state().row.scheduledAt = new Date(f.now - 2 * 86_400_000); f.state().row.proposedEndAt = new Date(f.now - 86_400_000 + 1);
  assert.equal((await f.module.history(f.actor('history'), f.id)).canSend, true);
  f.onCalendar(() => { f.advance(1); });
  await assert.rejects(f.module.send(f.actor('send'), f.id, f.meta(), { content: 'stale page', clientMessageId: randomUUID() }), { status: 409, code: 'MESSAGE_READ_ONLY' });
  assert.equal((await f.module.history(f.actor('history'), f.id)).canSend, false);
  assert.ok(f.calls.some(sql => sql.includes('FOR UPDATE OF a')));
  assert.equal(f.calls.find(sql => sql.startsWith('BEGIN')), 'BEGIN ISOLATION LEVEL READ COMMITTED');
  assert.equal(f.state().conversation, null); assert.equal(f.state().messages.length, 0); assert.equal(f.state().commands.size, 0);
  assert.equal(f.state().events.length, 0); assert.equal(f.state().signals.length, 0);
});
