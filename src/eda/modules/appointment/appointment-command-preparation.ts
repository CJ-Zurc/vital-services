import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError, requireScope, type Actor } from '../../contracts/actor.js';
import { requestHash } from '../../infrastructure/security.js';
import { appointmentOwn, calendarLock, lockAppointment, membership, readAppointment } from './appointment.js';

const version = z.number().int().nonnegative();
const inputSchema = z.object({
  commandId: z.uuid(), browserHash: z.string().regex(/^[a-f0-9]{64}$/),
  action: z.enum(['approve', 'follow-up', 'reject', 'reschedule', 'decline-reschedule', 'accept-reschedule', 'cancel', 'complete', 'schedule.write', 'blocks.write']),
  resource: z.uuid(), expectedVersion: version.optional(), expectedSourceVersion: version.optional(),
}).strict();
export type AppointmentPreparationInput = z.infer<typeof inputSchema>;
export interface AppointmentCommandPreparation {
  commandId: string; browserHash: string; action: AppointmentPreparationInput['action']; resource: string;
  expectedVersion: number; expectedSourceVersion: number | null; sourceAppointmentId: string | null;
}
type Stored = AppointmentCommandPreparation & { actorRole: string; bindingHash: string };
function deny(status: number, code: string): never { throw new DomainError(status, code, 'Appointment command preparation is unavailable.'); }

// This ledger stores identifiers, digests and revisions only. Browser bodies never enter it.
export function createAppointmentCommandPreparation(pool: Pool) {
  async function authority(tx: PoolClient, actor: Actor, input: Pick<AppointmentPreparationInput, 'action' | 'resource'>) {
    const doctorOnly = ['approve', 'follow-up', 'reject', 'schedule.write', 'blocks.write'].includes(input.action);
    const member = await membership(tx, actor, doctorOnly ? 'doctor' : actor.role);
    if (input.action === 'schedule.write' || input.action === 'blocks.write') {
      await calendarLock(tx, member.userId);
      const sql = input.action === 'schedule.write'
        ? 'SELECT version FROM schedules WHERE id=$1 AND "doctorId"=$2 FOR SHARE'
        : 'SELECT version FROM doctor_date_blocks WHERE id=$1 AND doctor_id=$2 FOR SHARE';
      const row = (await tx.query<{version: number}>(sql, [input.resource, member.userId])).rows[0];
      // A completed delete may remove the resource; the command journal proves its original scope.
      return row ? { expectedVersion: row.version, expectedSourceVersion: null, sourceAppointmentId: null } : null;
    }
    const target = await lockAppointment(tx, input.resource); appointmentOwn(actor, target);
    let sourceVersion: number | null = null;
    if (target.sourceAppointmentId && ['approve', 'accept-reschedule'].includes(input.action)) {
      const source = await readAppointment(tx, target.sourceAppointmentId, true); appointmentOwn(actor, source);
      sourceVersion = source.version;
    }
    return { expectedVersion: target.version, expectedSourceVersion: sourceVersion,
      sourceAppointmentId: sourceVersion === null ? null : target.sourceAppointmentId };
  }
  async function run(actor: Actor, commandId: string, submitted?: AppointmentPreparationInput) {
    z.uuid().parse(commandId); requireScope(actor, submitted ? 'appointments.command.prepare' : 'appointments.command.read', commandId);
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['appointment-preparation:' + actor.authId + ':' + commandId]);
      const old = (await tx.query<Stored>('SELECT * FROM appointment_command_preparations WHERE "actorAuthId"=$1 AND "commandId"=$2::uuid', [actor.authId, commandId])).rows[0];
      if (!submitted && !old) {
        await membership(tx, actor); deny(404, 'APPOINTMENT_COMMAND_PREPARATION_NOT_FOUND');
      }
      const binding = submitted ?? old!;
      const current = await authority(tx, actor, binding);
      const bindingHash = submitted ? requestHash('APPOINTMENT-PREPARATION', submitted.action, submitted) : old!.bindingHash;
      if (old) {
        if (old.actorRole !== actor.role || old.bindingHash !== bindingHash) deny(409, 'COMMAND_REPLAY_CONFLICT');
        if (!current) {
          const completed = (await tx.query('SELECT "operationId" FROM command_operations WHERE "actorId"=$1 AND "operationId"=$2 AND action=$3 AND "resourceId"=$4 AND status=\'completed\'', [actor.authId, commandId, old.action, old.resource])).rows[0];
          if (!completed) deny(403, 'APPOINTMENT_OWNER_DENIED');
        }
        // Never replace pinned versions with current values on replay, even after a successful mutation.
        await tx.query('COMMIT'); return dto(old);
      }
      if (!current) deny(404, 'APPOINTMENT_PREPARATION_RESOURCE_NOT_FOUND');
      if (submitted!.expectedVersion !== undefined && submitted!.expectedVersion !== current.expectedVersion
        || submitted!.expectedSourceVersion !== undefined && submitted!.expectedSourceVersion !== current.expectedSourceVersion) deny(409, 'APPOINTMENT_VERSION_CHANGED');
      const value = { commandId, browserHash: submitted!.browserHash, action: submitted!.action, resource: submitted!.resource, ...current };
      await tx.query(`INSERT INTO appointment_command_preparations
        (id,"actorAuthId","actorRole","commandId",action,resource,"browserHash","bindingHash","expectedVersion","expectedSourceVersion","sourceAppointmentId")
        VALUES($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11)`,
      [randomUUID(), actor.authId, actor.role, commandId, value.action, value.resource, value.browserHash, bindingHash,
        value.expectedVersion, value.expectedSourceVersion, value.sourceAppointmentId]);
      await tx.query('COMMIT'); return value;
    } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
  }
  return {
    prepare: (actor: Actor, raw: unknown) => { const input = inputSchema.parse(raw); return run(actor, input.commandId, input); },
    read: (actor: Actor, commandId: string) => run(actor, commandId),
  };
}
function dto(value: AppointmentCommandPreparation): AppointmentCommandPreparation {
  return { commandId: value.commandId, browserHash: value.browserHash, action: value.action, resource: value.resource,
    expectedVersion: value.expectedVersion, expectedSourceVersion: value.expectedSourceVersion, sourceAppointmentId: value.sourceAppointmentId };
}
