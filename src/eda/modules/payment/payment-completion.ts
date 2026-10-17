import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { DomainError, type Actor } from '../../contracts/actor.js';
import { completionCount, completionRole, completionUnavailable, type CompletionFinancialOwner } from '../../contracts/completion.js';

export interface CompletionPaymentAuthority {
  patient(actor: Actor): Promise<string>;
  admin(actor: Actor): Promise<void>;
}
const fingerprint = (rows: unknown[]) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const patientPayments = `SELECT id,version,"appointmentId","billingLineageId","associationVersion","patientAuthId","doctorAuthId",status
  FROM payments WHERE "patientAuthId"=$1 ORDER BY id`;
interface FinancialAssociation { id: string; version: number; appointmentId: string; billingLineageId: string; associationVersion: number;
  patientAuthId: string; doctorAuthId: string; status: string }

export function createPaymentCompletionOwner(integrationsPool: Pool, authority?: CompletionPaymentAuthority): CompletionFinancialOwner {
  return {
    async summary(actor) {
      completionRole(actor, 'admin', 'completion.admin.dashboard');
      if (!authority) completionUnavailable('PAYMENT_AUTHORITY');
      await authority.admin(actor);
      const rows = (await integrationsPool.query<{ status: string; count: string; volume: string }>(`SELECT status,COUNT(*) AS count,
        trim_scale(COALESCE(SUM(COALESCE("amountCentavos"::numeric,amount*100,0)) FILTER (WHERE status='paid'),0))::text AS volume FROM payments GROUP BY status`)).rows;
      // Sum exact centavos in PostgreSQL, converting once for the legacy numeric DTO.
      const centavos = rows.reduce((sum, row) => {
        if (!/^\d+$/.test(row.volume)) throw new DomainError(503, 'COMPLETION_PAYMENT_AMOUNT_INVALID', 'Invalid financial aggregate.');
        return sum + BigInt(row.volume);
      }, 0n);
      if (centavos > BigInt(Number.MAX_SAFE_INTEGER)) completionUnavailable('PAYMENT_AMOUNT');
      await authority.admin(actor);
      return { paymentCounts: Object.fromEntries(rows.map(row => [row.status, completionCount(row.count)])),
        paidVolume: Number(centavos) / 100 };
    },
    async patientSummary(actor, patientId, associations) {
      completionRole(actor, 'patient', 'completion.patient.dashboard');
      if (!authority) completionUnavailable('PAYMENT_AUTHORITY');
      if (await authority.patient(actor) !== patientId) throw new DomainError(403, 'COMPLETION_PAYMENT_OWNER_DENIED', 'Patient ownership changed.');
      const rows = (await integrationsPool.query<FinancialAssociation>(patientPayments, [actor.authId])).rows;
      const owned = new Map(associations.map(row => [row.id, row]));
      const lineages = new Set<string>();
      for (const payment of rows) {
        const current = owned.get(payment.appointmentId);
        if (!current || payment.patientAuthId !== actor.authId || current.doctorAuthId !== payment.doctorAuthId
          || current.billingLineageId !== payment.billingLineageId || current.associationVersion !== payment.associationVersion
          || current.paymentVersion !== undefined && current.paymentVersion !== payment.version || lineages.has(payment.billingLineageId))
          throw new DomainError(409, 'COMPLETION_PAYMENT_ASSOCIATION_CHANGED', 'Payment association changed.');
        lineages.add(payment.billingLineageId);
      }
      const paidAppointments = new Set(rows.map(row => row.appointmentId));
      if (associations.some(row => row.paymentVersion !== undefined && row.paymentVersion !== null && !paidAppointments.has(row.id)))
        throw new DomainError(409, 'COMPLETION_PAYMENT_ASSOCIATION_CHANGED', 'Payment association changed.');
      const expected = fingerprint(rows);
      const validate = async () => {
        if (await authority.patient(actor) !== patientId || fingerprint((await integrationsPool.query(patientPayments, [actor.authId])).rows) !== expected)
          throw new DomainError(409, 'COMPLETION_PAYMENT_CHANGED', 'Payment changed during composition.');
      };
      await validate();
      return { paid: completionCount(rows.filter(row => row.status === 'paid').length), validate };
    },
  };
}
