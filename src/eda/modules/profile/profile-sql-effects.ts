import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DomainError } from '../../contracts/actor.js';
import { appendSqlOutbox } from '../../infrastructure/outbox.js';
import { requestHash } from '../../infrastructure/security.js';

// Run only in the transaction committing the Profile mutation.
export async function appendProfileSqlEffects(tx: PoolClient, input: {
  userId: string; authId: string; role: 'patient' | 'doctor'; correlationId: string;
}) {
  const user = (await tx.query<{ version: number }>(
    'UPDATE vital_users SET version=version+1 WHERE id=$1 AND "authId"=$2 AND role=$3 RETURNING version',
    [input.userId, input.authId, input.role])).rows[0];
  if (!user) throw new DomainError(409, 'PROFILE_MEMBERSHIP_CHANGED', 'Profile membership changed.');
  const source = await appendSqlOutbox(tx, { producer: 'profile', eventType: 'vital.profile.changed',
    aggregateId: input.userId, aggregateVersion: user.version, correlationId: input.correlationId,
    data: { authId: input.authId, role: input.role, actorAuthId: input.authId, operation: 'profile_updated' } });
  await appendSqlOutbox(tx, { producer: 'profile', eventType: 'vital.audit.requested',
    aggregateId: input.userId, aggregateVersion: user.version, correlationId: input.correlationId, causationId: source.eventId,
    data: { auditType: 'vital.profile.updated', actorAuthId: input.authId, resourceId: input.userId, resourceType: 'profile' } });
  const intentId = randomUUID();
  await tx.query(`INSERT INTO profile_sync_intents
    (id,"profileId","authId","sourceVersion",destination,"requestId","requestHash",payload,"createdAt")
    VALUES($1,$2,$3,$4,'auth-stale',$5,$6,'{}'::jsonb,NOW())`,
  [intentId, input.userId, input.authId, user.version, randomUUID(), requestHash('POST', `/internal/users/${input.authId}/stale`, {})]);
  await appendSqlOutbox(tx, { producer: 'profile', eventType: 'vital.profile.sync.requested',
    aggregateId: input.userId, aggregateVersion: user.version, correlationId: input.correlationId, causationId: source.eventId,
    data: { intentId, authId: input.authId, destination: 'auth-stale' } });
}
