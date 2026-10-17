import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError, type Actor } from '../../contracts/actor.js';
import { completionCount, completionRole, completionUnavailable } from '../../contracts/completion.js';
import { appendProfileSqlEffects } from './profile-sql-effects.js';

const consentPosition = z.object({ consentedAt: z.iso.datetime({ offset: true }), id: z.uuid() }).strict();

const consentCursor = z.object({ after: consentPosition, upper: consentPosition, patientId: z.string().max(256).nullable() }).strict();

export interface CompletionConsentRow { id: string; patientId: string; appointmentId: string | null;
  consentType: 'registration'; accepted: boolean; consentedAt: Date }

// Profile owns membership, account counts and immutable registration consent only.
export function createCompletionProfileOwner(pool: Pool, options: { consentWrites?: boolean } = {}) {
  async function patient(actor: Actor, db: Pick<Pool, 'query'> = pool) {
    const row = (await db.query<{ userId: string }>(`SELECT p."userId" FROM vital_patients p
      JOIN vital_users u ON u.id=p."userId" AND u."authId"=p."authId"
      WHERE p."authId"=$1 AND u.role='patient'`, [actor.authId])).rows[0];
    if (!row) throw new DomainError(404, 'PROFILE_PATIENT_NOT_FOUND', 'Patient not found');
    return row.userId;
  }
  async function admin(actor: Actor, db: Pick<Pool, 'query'> = pool) {
    const row = (await db.query(`SELECT a."userId" FROM vital_admins a JOIN vital_users u
      ON u.id=a."userId" AND u."authId"=a."authId" WHERE a."authId"=$1 AND u.role='admin'`, [actor.authId])).rows[0];
    if (!row) throw new DomainError(403, 'PROFILE_ADMIN_MEMBERSHIP_REQUIRED', 'Forbidden');
  }
  return {
    patient, admin,
    async accounts() {
      const row = (await pool.query<{ patients: string; doctors: string }>(`SELECT
        (SELECT COUNT(*) FROM vital_patients) AS patients,(SELECT COUNT(*) FROM vital_doctors) AS doctors`)).rows[0]!;
      const patients = completionCount(row.patients), doctors = completionCount(row.doctors);
      return { patients, doctors, accounts: completionCount(patients + doctors) };
    },
    async consents(actor: Actor, input: unknown) {
      completionRole(actor, 'admin', 'profile.consent.read');
      const query = z.object({ patientId: z.string().max(256).optional(), cursor: z.string().max(4096).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(200) }).strict().parse(input);
      let cursor: z.infer<typeof consentCursor> | undefined;
      if (query.cursor) {
        try { cursor = consentCursor.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))); }
        catch { throw new DomainError(400, 'COMPLETION_CONSENT_CURSOR_INVALID', 'Invalid consent cursor.'); }
        if (cursor.patientId !== (query.patientId || null))
          throw new DomainError(400, 'COMPLETION_CONSENT_CURSOR_INVALID', 'Invalid consent cursor.');
      }
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await admin(actor, tx);
        const upper = cursor?.upper ?? (await tx.query<{ id: string; consentedAt: Date }>(`SELECT id,"consentedAt" FROM consent_records
          WHERE "consentType"='registration' AND ($1::text IS NULL OR "patientId"=$1)
          ORDER BY "consentedAt" DESC,id DESC LIMIT 1`, [query.patientId || null])).rows[0];
        const upperDate = upper ? new Date(upper.consentedAt) : null;
        const args = [query.patientId || null, upperDate, upper?.id ?? null, cursor ? new Date(cursor.after.consentedAt) : null, cursor?.after.id ?? null];
        const predicate = `"consentType"='registration' AND ($1::text IS NULL OR "patientId"=$1)
          AND ("consentedAt",id)<=($2::timestamp,$3::text)`;
        const total = upper ? completionCount((await tx.query<{ total: string }>(`SELECT COUNT(*) AS total FROM consent_records WHERE ${predicate}`, args.slice(0, 3))).rows[0]!.total) : 0;
        const rows = upper ? (await tx.query<CompletionConsentRow>(`SELECT id,"patientId","appointmentId","consentType",accepted,"consentedAt"
          FROM consent_records WHERE ${predicate} AND ($4::timestamp IS NULL OR ("consentedAt",id)<($4::timestamp,$5::text))
          ORDER BY "consentedAt" DESC,id DESC LIMIT $6`, [...args, query.limit + 1])).rows : [];
        const data = rows.slice(0, query.limit), last = data.at(-1);
        const nextCursor = rows.length > query.limit && last && upper ? Buffer.from(JSON.stringify({ patientId: query.patientId || null,
          after: { consentedAt: last.consentedAt.toISOString(), id: last.id }, upper: { consentedAt: upperDate!.toISOString(), id: upper.id } })).toString('base64url') : null;
        await tx.query('COMMIT');
        await admin(actor);
        return { data, meta: { nextCursor, total } };
      } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
    },
    async acceptConsent(actor: Actor, input: unknown, command?: { operationId: string; requestHash: string }) {
      completionRole(actor, 'patient', 'profile.consent.accept');
      if (!(input && typeof input === 'object' && 'accepted' in input && input.accepted === true))
        throw new DomainError(400, 'PROFILE_CONSENT_REQUIRED', 'Consent must be explicitly accepted to proceed');
      if (!options.consentWrites) completionUnavailable('CONSENT_WRITES');
      z.object({ accepted: z.literal(true) }).strict().parse(input);
      if (!command) throw new DomainError(401, 'COMMAND_METADATA_REQUIRED', 'Signed command required.');
      const meta = z.object({ operationId: z.uuid(), requestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(command);
      for (let attempt = 0; ; attempt++) {
        const tx = await pool.connect();
        try {
          await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
          // Shares the Profile user row with bootstrap/materialization; no consent update/delete path.
          await tx.query('SELECT id FROM vital_users WHERE "authId"=$1 FOR UPDATE', [actor.authId]);
          const patientId = await patient(actor, tx);
          const replay = (await tx.query<{ action: string; resourceId: string; requestHash: string; result: unknown }>(
            'SELECT action,"resourceId","requestHash",result FROM command_operations WHERE "actorId"=$1 AND "operationId"=$2',
            [actor.authId, meta.operationId])).rows[0];
          if (replay) {
            if (replay.action !== 'profile.consent.accept' || replay.resourceId !== actor.authId || replay.requestHash !== meta.requestHash)
              throw new DomainError(409, 'COMMAND_REPLAY_CONFLICT', 'Command replay conflicts.');
            await tx.query('COMMIT');
            return replay.result;
          }
          const existing = await tx.query(`SELECT id FROM consent_records WHERE "patientId"=$1 AND "consentType"='registration' LIMIT 1`, [patientId]);
          if (existing.rows.length) throw new DomainError(409, 'PROFILE_CONSENT_EXISTS', 'Registration consent already recorded');
          const row = (await tx.query(`INSERT INTO consent_records (id,"patientId","consentType",accepted,"consentedAt")
            VALUES (gen_random_uuid()::text,$1,'registration',true,NOW())
            RETURNING id AS "consentId","consentType",accepted,"consentedAt"`, [patientId])).rows[0];
          await appendProfileSqlEffects(tx, { userId: patientId, authId: actor.authId, role: 'patient', correlationId: actor.correlationId });
          await tx.query(`INSERT INTO command_operations (id,"actorId",action,"resourceId","operationId","requestHash",status,result,"createdAt","updatedAt")
            VALUES($1,$2,'profile.consent.accept',$2,$3,$4,'completed',$5::jsonb,NOW(),NOW())`,
          [randomUUID(), actor.authId, meta.operationId, meta.requestHash, JSON.stringify(row)]);
          await tx.query('COMMIT');
          return row;
        } catch (error) {
          await tx.query('ROLLBACK');
          const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
          if (!['40001', '40P01'].includes(String(code)) || attempt >= 2) throw error;
        } finally { tx.release(); }
      }
    },
  };
}
