import type { Pool } from 'pg';
import { DomainError, requireScope, type Actor } from '../../contracts/actor.js';
import { createPaymentReceiptPdf } from '../records/bgh-pdf.js';
import type { RecordsFontConfig } from '../records/pdf.js';
import { sha256 } from '../records/upload-validation.js';
import type { BillingAuthority } from './payment.js';

const verifiedStates = ['paid', 'refund_pending', 'refunded', 'refund_failed', 'non_refundable'];

export function createPaymentReceipts(
  pool: Pool,
  billing: BillingAuthority,
  fonts: RecordsFontConfig,
  names: (patientId: string, doctorId: string) => Promise<{ patientName: string; doctorName: string }>,
) {
  return async (actor: Actor, appointmentId: string, file = false) => {
    requireScope(actor, 'payments.receipt.read', appointmentId);
    if (actor.role !== 'patient') throw new DomainError(403, 'PAYMENT_RECEIPT_DENIED', 'Patient ownership required.');
    const context = await billing.authorize(actor, appointmentId);
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      const row = (await tx.query(`
        SELECT id,"appointmentId","providerOriginAppointmentId","doctorAuthId","paymongoPaymentId",
          "paymentProvider","providerMode","amountCentavos",currency,status,"paidAt","verifiedAt",
          "refundedAt","reviewRequired","receiptPdf","receiptHash"
        FROM payments WHERE "billingLineageId"=$1 AND "patientAuthId"=$2
          AND ("appointmentId"=$3 OR "providerOriginAppointmentId"=$3) FOR UPDATE
      `, [context.billingLineageId, actor.authId, appointmentId])).rows[0];
      if (!row || row.reviewRequired || !verifiedStates.includes(row.status) || !row.paidAt ||
        !row.verifiedAt || !row.paymongoPaymentId || !row.doctorAuthId || row.currency !== 'PHP') {
        throw new DomainError(409, 'PAYMENT_RECEIPT_NOT_READY', 'Verified payment is required.');
      }
      const reference = 'VITAL-RCT-' + row.id.toUpperCase();
      let bytes: Buffer | undefined;
      if (file) {
        bytes = row.receiptPdf;
        if (bytes && sha256(bytes) !== row.receiptHash)
          throw new DomainError(503, 'PAYMENT_RECEIPT_HASH_INVALID', 'Receipt unavailable.');
        if (!bytes) {
          const identities = await names(actor.authId, row.doctorAuthId);
          bytes = await createPaymentReceiptPdf({
            ...identities, reference, appointmentId: row.providerOriginAppointmentId ?? row.appointmentId,
            paymentReference: row.paymongoPaymentId, paymentMethod: row.paymentProvider,
            amountCentavos: Number(row.amountCentavos), paidAt: row.paidAt.toISOString(),
            sandbox: row.providerMode === 'sandbox', service: 'Consultation',
          }, fonts);
          await tx.query('UPDATE payments SET "receiptPdf"=$2,"receiptHash"=$3 WHERE id=$1', [row.id, bytes, sha256(bytes)]);
        }
      }
      await tx.query('COMMIT');
      return {
        appointmentId, reference, paymentStatus: row.status, refundedAt: row.refundedAt?.toISOString() ?? null,
        ...(bytes ? { base64: bytes.toString('base64'), sha256: sha256(bytes) } : {}),
      };
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
  };
}
