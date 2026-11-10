import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import type { Pool } from 'pg';
import type { Actor } from '../src/eda/contracts/actor.js';
import type { BillingAuthority } from '../src/eda/modules/payment/payment.js';
import { createPaymentReceipts } from '../src/eda/modules/payment/payment-receipts.js';

const appointmentId = '11111111-1111-4111-8111-111111111111';
const patientId = '22222222-2222-4222-8222-222222222222';
const doctorId = '33333333-3333-4333-8333-333333333333';
const actor = { role: 'patient', authId: patientId, scopes: ['payments.receipt.read'], resource: appointmentId } as Actor;
const regularPath = ['C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find(existsSync);
const boldPath = ['C:/Windows/Fonts/arialbd.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'].find(existsSync);

test('payment receipt verifies ownership and payment, serves one immutable PDF, and reports refunds separately', { skip: !regularPath || !boldPath }, async () => {
  const row = {
    id: '44444444-4444-4444-8444-444444444444', appointmentId, providerOriginAppointmentId: appointmentId,
    doctorAuthId: doctorId, paymongoPaymentId: 'pay_fixture', paymentProvider: 'paymongo', providerMode: 'sandbox',
    amountCentavos: '50000', currency: 'PHP', status: 'unpaid', paidAt: new Date('2026-11-09T01:00:00Z'),
    verifiedAt: new Date('2026-11-09T01:01:00Z'), refundedAt: null as Date | null, reviewRequired: false,
    receiptPdf: null as Buffer | null, receiptHash: null as string | null,
  };
  let writes = 0;
  const pool = { connect: async () => ({
    async query(sql: string, args: unknown[]) {
      if (sql.includes('FROM payments')) {
        assert.deepEqual(args, ['lineage', patientId, appointmentId]);
        return { rows: [row] };
      }
      if (sql.startsWith('UPDATE payments')) {
        writes++;
        row.receiptPdf = args[1] as Buffer;
        row.receiptHash = args[2] as string;
      }
      return { rows: [] };
    },
    release() {},
  }) } as unknown as Pool;
  const billing = { authorize: async (caller: Actor) => {
    if (caller.authId !== patientId) throw new Error('OWNERSHIP_DENIED');
    return { billingLineageId: 'lineage', status: 'approved' };
  } } as BillingAuthority;
  const receipt = createPaymentReceipts(pool, billing, { regularPath: regularPath!, boldPath: boldPath! },
    async () => ({ patientName: 'Fictional Patient', doctorName: 'Fictional Doctor' }));
  await assert.rejects(receipt(actor, appointmentId), /Verified payment is required/);
  await assert.rejects(receipt({ ...actor, authId: doctorId }, appointmentId), /OWNERSHIP_DENIED/);
  row.status = 'paid';
  assert.match((await receipt(actor, appointmentId)).reference, /^VITAL-RCT-/);
  const initial = await receipt(actor, appointmentId, true);
  assert.match(Buffer.from(initial.base64!, 'base64').subarray(0, 5).toString(), /^%PDF-/);
  row.status = 'refunded';
  row.refundedAt = new Date('2026-11-10T01:00:00Z');
  const refunded = await receipt(actor, appointmentId, true);
  assert.equal(refunded.reference, initial.reference);
  assert.equal(refunded.base64, initial.base64);
  assert.equal(refunded.refundedAt, row.refundedAt.toISOString());
  assert.equal(writes, 1);
});
