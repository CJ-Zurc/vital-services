import type { Pool } from 'pg';
import { DomainError } from '../../contracts/actor.js';
import { completionCount, completionRole, type CompletionRecordsOwner } from '../../contracts/completion.js';
import { createCompletionProfileOwner } from '../profile/profile-completion.js';

export function createRecordsCompletionOwner(pool: Pool): CompletionRecordsOwner {
  const profile = createCompletionProfileOwner(pool);
  return {
    async patientSummary(actor, patientId) {
      completionRole(actor, 'patient', 'completion.patient.dashboard');
      if (await profile.patient(actor) !== patientId) throw new DomainError(403, 'COMPLETION_RECORDS_OWNER_DENIED', 'Patient ownership changed.');
      // Records owns patient IDs and appointment references. Independent documents
      // remain excluded, matching the legacy appointment-linked dashboard total.
      const row = (await pool.query<{ documents: string; files: string }>(`SELECT
        ((SELECT COUNT(*) FROM prescriptions WHERE "patientId"=$1 AND "appointmentId" IS NOT NULL)+
         (SELECT COUNT(*) FROM medical_certificates WHERE "patientId"=$1 AND "appointmentId" IS NOT NULL)) AS documents,
        (SELECT COUNT(*) FROM health_records WHERE "patientId"=$1 AND "filePath" IS NOT NULL) AS files`, [patientId])).rows[0]!;
      if (await profile.patient(actor) !== patientId) throw new DomainError(403, 'COMPLETION_RECORDS_OWNER_DENIED', 'Patient ownership changed.');
      return { documents: completionCount(row.documents), files: completionCount(row.files) };
    },
  };
}
