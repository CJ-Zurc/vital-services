import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg, { type Pool } from "pg";
import type { Actor } from "../src/eda/contracts/actor.js";
import { createMessageHolds, messageHoldListQuery, messageHoldPlaceInput } from "../src/eda/modules/messaging/holds.js";
import { createMessagingRetention, messageExpiryDate } from "../src/eda/modules/messaging/retention.js";
import { messagingTransaction } from "../src/eda/modules/messaging/transactions.js";

const now = new Date("2026-10-15T00:00:00.000Z");
const old = new Date("2010-01-01T00:00:00.000Z");
function environment() {
  return { MESSAGE_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 7).toString("base64") }), MESSAGE_ACTIVE_KEY_VERSION: "1",
    VITAL_EDA_MESSAGING_ENABLED: "true", VITAL_EDA_MESSAGING_RETENTION_SCAN_ENABLED: "true" } as NodeJS.ProcessEnv;
}
function fixture(count = 1) {
  const authId = randomUUID(), patientId = randomUUID(), doctorId = randomUUID();
  type Conversation = { id: string; appointmentId: string; createdAt: Date; legalHoldAt: Date | null; purgedAt: Date | null;
    patientLastReadAt: Date | null; doctorLastReadAt: Date | null; version: number };
  type Hold = { id: string; conversationId: string; placedAt: Date; releasedAt: Date | null; reasonCode: string; protectedReference: object };
  type Command = { action: string; resourceId: string; requestHash: string; status: string; result: object };
  type Appointment = { id: string; doctorId: string; patientId: string; status: string; completedAt: Date | null;
    updatedAt: Date; scheduledAt: Date };
  const conversations: Conversation[] = Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, appointmentId: randomUUID(),
    createdAt: old, legalHoldAt: null, purgedAt: null, patientLastReadAt: old, doctorLastReadAt: old, version: 0,
  }));
  const appointments: Appointment[] = conversations.map(c => ({ id: c.appointmentId, doctorId, patientId,
    status: "completed", completedAt: old, updatedAt: old, scheduledAt: old }));
  const messages = conversations.map(c => ({ conversationId: c.id, createdAt: old }));
  const initial = { conversations, appointments, messages, holds: [] as Hold[], commands: {} as Record<string, Command>,
    outbox: [] as object[], purges: [] as object[],
    scan: { id: "messaging-retention", afterId: null as string | null, upperId: null as string | null,
      scanStartedAt: null as Date | null, leaseOwner: null as string | null, leaseUntil: null as Date | null,
      nextRunAt: new Date(0), scanned: 0, eligible: 0, purged: 0 } };
  let state = structuredClone(initial), snapshot = structuredClone(initial), admin = true, failOutbox = false;
  let failureCode: string | null = null, failures = 0;
  let patientFence: (() => void) | undefined;
  const calls: { sql: string; args: unknown[] }[] = [];
  const reply = (rows: unknown[] = [], rowCount = rows.length) => ({ rows, rowCount });
  async function query(sql: string, args: unknown[] = []) {
    calls.push({ sql, args });
    if (sql.startsWith("BEGIN")) { snapshot = structuredClone(state); return reply(); }
    if (sql === "COMMIT") {
      if (failureCode && failures++ === 0) throw Object.assign(new Error("retry"), { code: failureCode });
      return reply();
    }
    if (sql === "ROLLBACK") { state = snapshot; return reply(); }
    if (sql.includes('pg_advisory_xact_lock') && String(args[0]).startsWith('messaging-patient-retention:')) patientFence?.();
    if (sql.startsWith("SET LOCAL") || sql.includes("pg_advisory_xact_lock")) return reply();
    if (sql.includes("FROM vital_admins")) return reply(admin ? [{ id: randomUUID() }] : []);
    if (sql.startsWith('SELECT "appointmentId" FROM message_conversations')) {
      const row = state.conversations.find(c => c.id === args[0]); return reply(row ? [row] : []);
    }
    if (sql.startsWith("SELECT a.*, p.")) return reply(state.appointments.filter(a => a.id === args[0]));
    if (sql.startsWith("SELECT * FROM message_conversations")) return reply(state.conversations.filter(c => c.id === args[0]));
    if (sql.includes("FROM command_operations")) return reply(state.commands[String(args[0]) + ":" + args[1]] ? [state.commands[String(args[0]) + ":" + args[1]]] : []);
    if (sql.startsWith("INSERT INTO command_operations")) {
      state.commands[String(args[1]) + ":" + args[4]] = { action: String(args[2]), resourceId: String(args[3]),
        requestHash: String(args[5]), status: "completed", result: JSON.parse(String(args[6])) }; return reply([], 1);
    }
    if (sql.startsWith("INSERT INTO message_legal_holds")) {
      const hold = { id: String(args[0]), conversationId: String(args[1]), reasonCode: String(args[2]),
        protectedReference: JSON.parse(String(args[3])), placedAt: now, releasedAt: null };
      assert.equal(state.holds.some(h => h.conversationId === hold.conversationId && !h.releasedAt), false);
      state.holds.push(hold); return reply([{ placedAt: now }]);
    }
    if (sql.startsWith("UPDATE message_legal_holds")) {
      const rows = state.holds.filter(h => h.conversationId === args[0] && !h.releasedAt);
      for (const h of rows) h.releasedAt = now;
      return reply(rows);
    }
    if (sql.startsWith('UPDATE message_conversations SET "legalHoldAt"')) {
      const row = state.conversations.find(c => c.id === args[0])!; row.legalHoldAt = args[1] as Date | null; row.version = Number(args[2]); return reply([], 1);
    }
    if (sql.startsWith("INSERT INTO outbox_events")) {
      if (failOutbox) throw new Error("OUTBOX_TEST_FAILURE");
      state.outbox.push(JSON.parse(String(args[8]))); return reply([], 1);
    }
    if (sql.startsWith("SELECT c.id,c.")) {
      const filtered = state.conversations.filter(c => (!args[0] || c.appointmentId === args[0]) && (!args[1] || c.id === args[1]) &&
        (args[2] === "all" || (args[2] === "held" ? !!c.legalHoldAt : !c.legalHoldAt)) &&
        (!args[3] || c.createdAt < new Date(String(args[3])) || c.createdAt.getTime() === new Date(String(args[3])).getTime() && c.id < String(args[4])))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)).slice(0, Number(args[5]));
      return reply(filtered.map(c => {
        const a = state.appointments.find(a => a.id === c.appointmentId)!, h = state.holds.find(h => h.conversationId === c.id && !h.releasedAt);
        return { ...a, ...c, lastMessageAt: old, holdId: h?.id ?? null, reasonCode: h?.reasonCode ?? null, protectedReference: h?.protectedReference ?? null };
      }));
    }
    if (sql.startsWith('UPDATE message_retention_scans SET "leaseOwner"=$1')) {
      const scan = state.scan, instant = args[1] as Date;
      if (scan.nextRunAt > instant || scan.leaseUntil && scan.leaseUntil > instant) return reply();
      scan.leaseOwner = String(args[0]); scan.leaseUntil = args[2] as Date;
      if (!scan.scanStartedAt) { scan.scanStartedAt = instant; scan.upperId = state.conversations.at(-1)?.id ?? null; }
      return reply([structuredClone(scan)]);
    }
    if (sql.startsWith("SELECT id FROM message_conversations")) return reply(state.conversations.filter(c => !c.purgedAt && (!args[0] || c.id > String(args[0])) && args[1] && c.id <= String(args[1])).slice(0, 100));
    if (sql.startsWith("SELECT id FROM message_retention_scans")) return reply(state.scan.leaseOwner === args[1] && state.scan.leaseUntil! > (args[2] as Date) ? [{ id: state.scan.id }] : []);
    if (sql.startsWith('SELECT a."updatedAt"')) {
      const a = state.appointments.find(a => a.id === args[0])!;
      const visits = state.appointments.filter(v => v.patientId === a.patientId && v.status === "completed" && v.completedAt).map(v => v.completedAt!);
      const latest = visits.sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      const messages = state.messages.filter(m => m.conversationId === args[1]).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return reply([{ updatedAt: a.updatedAt, lastCompletedVisitAt: latest, lastMessageAt: messages[0]?.createdAt ?? null }]);
    }
    if (sql.startsWith("DELETE FROM appointment_messages")) {
      const oldLength = state.messages.length; state.messages = state.messages.filter(m => m.conversationId !== args[0]); return reply([], oldLength - state.messages.length);
    }
    if (sql.startsWith('UPDATE message_conversations SET "purgedAt"')) {
      const c = state.conversations.find(c => c.id === args[0])!;
      assert.equal(c.legalHoldAt, null); c.purgedAt = args[1] as Date; c.version = Number(args[2]); c.patientLastReadAt = null; c.doctorLastReadAt = null; return reply([], 1);
    }
    if (sql.startsWith("INSERT INTO message_purges")) { state.purges.push({ conversationId: args[0], removedMessages: args[3] }); return reply([], 1); }
    if (sql.startsWith('UPDATE message_retention_scans SET "afterId"=$3')) {
      if (state.scan.leaseOwner !== args[1] || state.scan.leaseUntil! <= (args[6] as Date)) return reply();
      state.scan.afterId = String(args[2]); state.scan.leaseUntil = args[3] as Date;
      state.scan.scanned++; state.scan.eligible += Number(args[4]); state.scan.purged += Number(args[5]); return reply([], 1);
    }
    if (sql.startsWith('UPDATE message_retention_scans SET "afterId"=NULL')) {
      if (state.scan.leaseOwner !== args[1] || state.scan.leaseUntil! <= (args[2] as Date)) return reply();
      state.scan.afterId = null; state.scan.upperId = null; state.scan.scanStartedAt = null;
      state.scan.nextRunAt = args[3] as Date; state.scan.leaseOwner = null; state.scan.leaseUntil = null; return reply([], 1);
    }
    if (sql.startsWith('UPDATE message_retention_scans SET "leaseOwner"=NULL')) {
      if (state.scan.leaseOwner === args[1]) { state.scan.leaseOwner = null; state.scan.leaseUntil = null; }
      return reply([], 1);
    }
    throw new Error("Unexpected fixture query: " + sql);
  }
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  const actor: Actor = { authId, role: "admin", serviceId: "vital-web", scopes: [], resource: "", correlationId: randomUUID(), isSuperAdmin: false };
  const env = environment(), holds = createMessageHolds(pool, env), clock = () => now.getTime();
  const delegation = (action: string, id = state.conversations[0]!.id): Actor => ({ ...actor,
    scopes: ["messaging." + action], resource: action === "admin.list" ? authId : id });
  const meta = () => ({ operationId: randomUUID(), requestHash: "a".repeat(64) });
  return { pool, holds, env, clock, delegation, meta, state: () => state, calls,
    revoke: () => { admin = false; }, failOutbox: () => { failOutbox = true; }, conflict: (code: string) => { failureCode = code; },
    onPatientFence: (run: () => void) => { patientFence = run; },
    retention: () => createMessagingRetention(pool, env, clock) };
}

test("Messaging retention preserves ten-year UTC closure/latest-visit/message calculation", () => {
  const input = { status: "completed", completedAt: old, updatedAt: now, lastCompletedVisitAt: null, lastMessageAt: null, legalHoldAt: null };
  assert.equal(messageExpiryDate(input)?.toISOString(), "2020-01-01T00:00:00.000Z");
  assert.equal(messageExpiryDate({ ...input, status: "cancelled" })?.toISOString(), "2036-10-15T00:00:00.000Z");
  assert.equal(messageExpiryDate({ ...input, status: "rescheduled", lastCompletedVisitAt: new Date("2028-01-01Z") })?.getUTCFullYear(), 2038);
  assert.equal(messageExpiryDate({ ...input, lastMessageAt: now })?.getUTCFullYear(), 2036);
  assert.equal(messageExpiryDate({ ...input, completedAt: null }), null);
  assert.equal(messageExpiryDate({ ...input, status: "approved" }), null);
  assert.equal(messageExpiryDate({ ...input, legalHoldAt: old }), null);
  assert.equal(messageExpiryDate({ ...input, completedAt: new Date("2012-02-29T00:00:00Z") })?.toISOString(), "2022-03-01T00:00:00.000Z");
});

test("Messaging holds encrypt references, journal only IDs, and reauthorize identical retries", async () => {
  const f = fixture(), id = f.state().conversations[0]!.id, meta = f.meta();
  const input = { expectedVersion: 0, reasonCode: "legal_request" as const, reference: "CASE-123" };
  const result = await f.holds.place(f.delegation("hold.place"), id, meta, input);
  assert.deepEqual(await f.holds.place(f.delegation("hold.place"), id, meta, input), result);
  assert.equal(f.state().holds.length, 1); assert.equal(f.state().outbox.length, 1);
  assert.equal(JSON.stringify(f.state().holds).includes("CASE-123"), false);
  assert.equal(JSON.stringify(f.state().commands).includes("CASE-123"), false);
  assert.equal(JSON.stringify(f.state().outbox).includes("CASE-123"), false);
  const list = await f.holds.list(f.delegation("admin.list"), { holdState: "held" });
  assert.equal(list.conversations[0]!.reference, "CASE-123");
  assert.equal("content" in list.conversations[0]!, false);
  f.revoke();
  await assert.rejects(f.holds.place(f.delegation("hold.place"), id, meta, input), { code: "MESSAGING_ADMIN_REVOKED" });
});

test("Messaging holds reject changed command hash, stale versions, and competing active holds", async () => {
  const f = fixture(), id = f.state().conversations[0]!.id, meta = f.meta();
  const input = { expectedVersion: 0, reasonCode: "investigation" as const, reference: "REF-1" };
  await f.holds.place(f.delegation("hold.place"), id, meta, input);
  await assert.rejects(f.holds.place(f.delegation("hold.place"), id, meta, { ...input, reference: "REF-2" }), { code: "COMMAND_REPLAY_CONFLICT" });
  await assert.rejects(f.holds.release(f.delegation("hold.release"), id, f.meta(), { expectedVersion: 0 }), { code: "MESSAGE_CONVERSATION_VERSION_CHANGED" });
  await assert.rejects(f.holds.place(f.delegation("hold.place"), id, f.meta(), { ...input, expectedVersion: 1 }), { code: "MESSAGE_HOLD_ALREADY_ACTIVE" });
  assert.equal(f.state().conversations[0]!.version, 1);
});

test("Messaging holds require exact scopes/current Core admin and deny SuperAdmin bypass", async () => {
  const f = fixture(), id = f.state().conversations[0]!.id;
  await assert.rejects(f.holds.list({ ...f.delegation("admin.list"), role: "patient", isSuperAdmin: true }), { code: "MESSAGING_ADMIN_REQUIRED" });
  await assert.rejects(f.holds.place({ ...f.delegation("hold.place"), resource: randomUUID() }, id, f.meta(),
    { expectedVersion: 0, reasonCode: "records_review", reference: "R-1" }), { code: "ACTOR_SCOPE_DENIED" });
  f.revoke(); await assert.rejects(f.holds.list({ ...f.delegation("admin.list"), isSuperAdmin: true }), { code: "MESSAGING_ADMIN_REVOKED" });
});

test("Messaging hold release is versioned/idempotent and preserves minimal encrypted history", async () => {
  const f = fixture(), id = f.state().conversations[0]!.id;
  await f.holds.place(f.delegation("hold.place"), id, f.meta(), { expectedVersion: 0, reasonCode: "records_review", reference: "R-1" });
  const meta = f.meta(), actor = f.delegation("hold.release");
  const result = await f.holds.release(actor, id, meta, { expectedVersion: 1 });
  assert.deepEqual(await f.holds.release(actor, id, meta, { expectedVersion: 1 }), result);
  assert.equal(f.state().holds[0]!.releasedAt?.getTime(), now.getTime());
  assert.equal(f.state().conversations[0]!.legalHoldAt, null); assert.equal(f.state().outbox.length, 2);
  await assert.rejects(f.holds.release(actor, id, f.meta(), { expectedVersion: 2 }), { code: "MESSAGE_HOLD_NOT_ACTIVE" });
});

test("Messaging hold list has bounded stable tie pagination and exact metadata filters", async () => {
  const f = fixture(3), actor = f.delegation("admin.list");
  const first = await f.holds.list(actor, { limit: 2 });
  const second = await f.holds.list(actor, { limit: 2, before: first.nextCursor! });
  assert.equal(first.conversations.length, 2); assert.equal(second.conversations.length, 1);
  assert.notEqual(first.conversations[1]!.id, second.conversations[0]!.id);
  const exact = await f.holds.list(actor, { appointmentId: f.state().conversations[0]!.appointmentId });
  assert.equal(exact.conversations.length, 1);
  assert.equal(messageHoldListQuery.safeParse({ limit: 51 }).success, false);
  assert.equal(messageHoldPlaceInput.safeParse({ expectedVersion: 0, reasonCode: "investigation", reference: "Clinical narrative text" }).success, false);
  assert.equal(messageHoldPlaceInput.safeParse({ expectedVersion: 0, reasonCode: "investigation", reference: "x".repeat(97) }).success, false);
});

test("Messaging hold outbox failure rolls back mutation, history, and command result", async () => {
  const f = fixture(), id = f.state().conversations[0]!.id; f.failOutbox();
  await assert.rejects(f.holds.place(f.delegation("hold.place"), id, f.meta(), { expectedVersion: 0, reasonCode: "investigation", reference: "R-1" }));
  assert.equal(f.state().holds.length, 0); assert.equal(f.state().conversations[0]!.version, 0);
  assert.deepEqual(f.state().commands, {});
});

test("Messaging retention flags off and missing keys never touch the database", async () => {
  const f = fixture();
  await createMessagingRetention(f.pool, {}, f.clock).tick(); assert.equal(f.calls.length, 0);
  await assert.rejects(createMessagingRetention(f.pool, { VITAL_EDA_MESSAGING_ENABLED: "true", VITAL_EDA_MESSAGING_RETENTION_SCAN_ENABLED: "true" }, f.clock).tick());
  assert.equal(f.calls.length, 0);
});

test("Messaging retention defaults to daily bounded dry-run and requires every purge approval", async () => {
  const f = fixture(101), retention = f.retention();
  const first = await retention.tick(); assert.equal(first.scanned, 100); assert.equal(first.eligible, 100); assert.equal(first.mode, "dry-run");
  assert.equal(first.completed, false); assert.equal(f.state().messages.length, 101);
  const second = await retention.tick(); assert.equal(second.scanned, 1); assert.equal(second.completed, true);
  const later = await retention.tick(); assert.equal(later.busy, true); assert.equal(later.scanned, 0);
  for (const missing of ["VITAL_EDA_MESSAGING_RETENTION_ENABLED", "MESSAGE_RETENTION_APPROVED", "MESSAGE_RETENTION_POLICY_APPROVAL_ID"]) {
    const one = fixture(); Object.assign(one.env, { VITAL_EDA_MESSAGING_RETENTION_ENABLED: "true", MESSAGE_RETENTION_APPROVED: "true", MESSAGE_RETENTION_POLICY_APPROVAL_ID: "POLICY-1" });
    delete one.env[missing]; assert.equal((await one.retention().tick()).mode, "dry-run"); assert.equal(one.state().purges.length, 0);
  }
});

test("Messaging retention retains held/recent-visit conversations across any doctor", async () => {
  const f = fixture(3);
  f.state().conversations[0]!.legalHoldAt = now;
  f.state().appointments[1]!.doctorId = randomUUID(); f.state().appointments[1]!.completedAt = now;
  const result = await f.retention().tick(); assert.equal(result.eligible, 0); assert.equal(f.state().messages.length, 3);
  assert.ok(f.calls.some(c => c.sql.includes('MAX(v."completedAt")') && !c.sql.includes('v."doctorId"')));
});

test("Messaging retention purges ciphertext/receipts only and fences tombstone reprocessing", async () => {
  const f = fixture(); Object.assign(f.env, { VITAL_EDA_MESSAGING_RETENTION_ENABLED: "true", MESSAGE_RETENTION_APPROVED: "true", MESSAGE_RETENTION_POLICY_APPROVAL_ID: "POLICY-1" });
  const result = await f.retention().tick(); assert.equal(result.purged, 1); assert.equal(f.state().messages.length, 0);
  const c = f.state().conversations[0]!;
  assert.equal(c.purgedAt?.getTime(), now.getTime()); assert.equal(c.patientLastReadAt, null); assert.equal(c.doctorLastReadAt, null);
  assert.equal(f.state().appointments.length, 1); assert.equal(f.state().purges.length, 1); assert.equal(f.state().outbox.length, 1);
  const nextDay = createMessagingRetention(f.pool, f.env, () => now.getTime() + 86_400_000);
  assert.equal((await nextDay.tick()).scanned, 0); assert.equal(f.state().outbox.length, 1);
  await assert.rejects(f.holds.place(f.delegation("hold.place"), c.id, f.meta(), { expectedVersion: c.version, reasonCode: "investigation", reference: "R-1" }), { code: "MESSAGE_CONVERSATION_PURGED" });
});

test("Messaging retention purge/outbox failure rolls back ciphertext and durable cursor", async () => {
  const f = fixture(); Object.assign(f.env, { VITAL_EDA_MESSAGING_RETENTION_ENABLED: "true", MESSAGE_RETENTION_APPROVED: "true", MESSAGE_RETENTION_POLICY_APPROVAL_ID: "POLICY-1" }); f.failOutbox();
  await assert.rejects(f.retention().tick()); assert.equal(f.state().messages.length, 1);
  assert.equal(f.state().conversations[0]!.purgedAt, null); assert.equal(f.state().scan.afterId, null); assert.equal(f.state().purges.length, 0);
});

test("Messaging retention resumes an expired lease without replaying scanned progress", async () => {
  const f = fixture(3); f.state().scan.afterId = f.state().conversations[0]!.id;
  f.state().scan.upperId = f.state().conversations[2]!.id; f.state().scan.scanStartedAt = old;
  f.state().scan.leaseOwner = randomUUID(); f.state().scan.leaseUntil = old;
  const result = await f.retention().tick(); assert.equal(result.scanned, 2); assert.equal(result.completed, true);
});

test("Messaging retention honors shutdown and an existing live scanner lease", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  const result = await f.retention().tick(controller.signal); assert.equal(result.aborted, true); assert.equal(f.calls.length, 0);
  f.state().scan.leaseUntil = new Date(now.getTime() + 30_000); f.state().scan.leaseOwner = randomUUID();
  assert.equal((await f.retention().tick()).busy, true); assert.equal(f.state().messages.length, 1);
});

test("Messaging hold/purge lock order uses calendar then appointment then conversation", async () => {
  const f = fixture(), id = f.state().conversations[0]!.id;
  await f.holds.place(f.delegation("hold.place"), id, f.meta(), { expectedVersion: 0, reasonCode: "records_review", reference: "R-1" });
  const calendar = f.calls.findIndex(c => c.args[0] === "appointment-calendar:" + f.state().appointments[0]!.doctorId);
  const appointment = f.calls.findIndex(c => c.sql.includes("FOR UPDATE OF a"));
  const conversation = f.calls.findIndex(c => c.sql.startsWith("SELECT * FROM message_conversations") && c.sql.includes("FOR UPDATE"));
  assert.ok(calendar >= 0 && calendar < appointment && appointment < conversation);
});

test('Messaging retention reads a newly completed cross-doctor visit after the patient fence', async () => {
  const f = fixture();
  Object.assign(f.env, { VITAL_EDA_MESSAGING_RETENTION_ENABLED: 'true', MESSAGE_RETENTION_APPROVED: 'true', MESSAGE_RETENTION_POLICY_APPROVAL_ID: 'POLICY-1' });
  f.onPatientFence(() => {
    f.state().appointments.push({ ...f.state().appointments[0]!, id: randomUUID(), doctorId: randomUUID(), completedAt: now, updatedAt: now });
  });
  const result = await f.retention().tick();
  assert.equal(result.eligible, 0); assert.equal(result.purged, 0); assert.equal(f.state().messages.length, 1);
  const fence = f.calls.findIndex(call => String(call.args[0]).startsWith('messaging-patient-retention:'));
  const evidence = f.calls.findIndex(call => call.sql.startsWith('SELECT a."updatedAt"'));
  assert.ok(fence >= 0 && fence < evidence);
  assert.equal(f.calls.find(call => call.sql.startsWith('BEGIN'))?.sql, 'BEGIN ISOLATION LEVEL READ COMMITTED');
});

test('Messaging retention yields its time budget without skipping durable progress', async () => {
  const f = fixture(3); let instant = now.getTime();
  f.onPatientFence(() => { instant += 11_000; });
  const retention = createMessagingRetention(f.pool, f.env, () => instant);
  const first = await retention.tick();
  assert.equal(first.scanned, 1); assert.equal(first.completed, false);
  assert.equal(f.state().scan.afterId, f.state().conversations[0]!.id);
  const next = await retention.tick();
  assert.equal(next.scanned, 1); assert.equal(next.completed, false);
  assert.equal(f.state().scan.afterId, f.state().conversations[1]!.id);
});

test("Messaging transactions retry serialization/deadlock without duplicate effects", async () => {
  for (const code of ["40001", "40P01"]) {
    const f = fixture(), id = f.state().conversations[0]!.id; f.conflict(code);
    await f.holds.place(f.delegation("hold.place"), id, f.meta(), { expectedVersion: 0, reasonCode: "investigation", reference: "R-1" });
    assert.equal(f.state().holds.length, 1); assert.equal(f.state().outbox.length, 1);
    assert.equal(f.calls.filter(c => c.sql.startsWith("BEGIN")).length, 2);
  }
  let attempts = 0;
  const pool = { connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} }) } as unknown as Pool;
  await assert.rejects(messagingTransaction(pool, async () => { attempts++; throw Object.assign(new Error("deadlock"), { code: "40P01" }); }));
  assert.equal(attempts, 3);
});

test("Messaging isolated retention schema enforces active holds, tombstones and restricted worker privilege", {
  skip: process.env.EDA_TEST_ENABLED !== "true" || process.env.EDA_TEST_MESSAGING_ENABLED !== "true",
}, async () => {
  const environment = process.env;
  assert.equal(environment.EDA_TEST_ISOLATED, "yes");
  const url = new URL(environment.EDA_TEST_CORE_DATABASE_URL ?? "");
  assert.equal(url.hostname, "postgres"); assert.equal(url.pathname, "/vital_core_test");
  assert.equal(decodeURIComponent(url.username), "vital_core_worker");
  assert.equal(url.search, ""); assert.equal(url.hash, ""); assert.equal(url.port || "5432", "5432");
  assert.ok(["postgresql:", "postgres:"].includes(url.protocol)); assert.ok(environment.EDA_TEST_DATABASE_CA_FILE);
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1,
    ssl: { ca: readFileSync(environment.EDA_TEST_DATABASE_CA_FILE!, "utf8"), rejectUnauthorized: true } });
  try {
    const indexes = (await pool.query("SELECT indexdef FROM pg_indexes WHERE tablename='message_legal_holds'")).rows;
    assert.ok(indexes.some(row => /UNIQUE.*conversationId.*WHERE.*releasedAt.*IS NULL/.test(row.indexdef)));
    const tombstone = await pool.query("SELECT conname FROM pg_constraint WHERE conname='message_conversations_purge_receipts_check'");
    assert.equal(tombstone.rowCount, 1);
    const privileges = (await pool.query(`SELECT has_table_privilege(current_user,'appointment_messages','DELETE') AS purge,
      has_table_privilege(current_user,'message_retention_scans','UPDATE') AS scan,
      has_schema_privilege(current_user,'public','CREATE') AS ddl`)).rows[0];
    assert.equal(privileges.purge, true); assert.equal(privileges.scan, true); assert.equal(privileges.ddl, false);
  } finally { await pool.end(); }
});
