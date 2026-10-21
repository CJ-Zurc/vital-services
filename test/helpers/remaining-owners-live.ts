import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { previewDateBlocks,saveDateBlocks } from '../../src/eda/modules/appointment/appointment-date-blocks.js';
import { createAppointmentExtras } from '../../src/eda/modules/appointment/appointment-extras.js';
import { createAppointmentReads } from '../../src/eda/modules/appointment/appointment-reads.js';
import { readPaymentProjectionAppointment } from '../../src/eda/modules/appointment/appointment-billing.js';
import { consumePayment } from '../../src/eda/workers/handlers.js';
import { envelopeFromRow, type OutboxRow } from '../../src/eda/infrastructure/outbox.js';
import { fixture, type Context } from './payment-live.js';

export async function remainingOwnersLiveScenarios(t: TestContext, context: Context) {
  await t.test('S6 PostgreSQL complaint concurrency and atomic calendar reviews preserve private history',()=>fixture(context,async f=>{
    const owner=createAppointmentExtras(context.core,{}),meta=()=>({operationId:randomUUID(),requestHash:'a'.repeat(64)});
    const actor={...f.actor,authId:f.doctorAuthId,role:'doctor' as const,scopes:['appointments.intake.read','appointments.intake.write']};
    await context.core.query('UPDATE appointments SET status=\'pending\',"scheduledAt"=\'2099-11-01T01:00:00\',"proposedEndAt"=\'2099-11-01T01:30:00\' WHERE id=$1',[f.appointmentId]);
    try {
      const attempts=await Promise.allSettled([owner.correctComplaint(actor,f.appointmentId,meta(),{expectedVersion:0,chiefComplaint:'Fictional correction A'}),owner.correctComplaint(actor,f.appointmentId,meta(),{expectedVersion:0,chiefComplaint:'Fictional correction B'})]);
      assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);
      const history=await owner.complaint(actor,f.appointmentId,{});assert.equal(history.history.length,1);assert.equal(history.history[0].previousText,null);
      const calendar={...actor,resource:f.doctorAuthId,scopes:['appointments.blocks.read','appointments.blocks.write']};
      const selection={mode:'custom',dates:['2099-11-01','2099-11-03']};
      const first=await previewDateBlocks(context.core,calendar,selection,Date.now());
      await context.core.query('UPDATE appointments SET version=version+1 WHERE id=$1',[f.appointmentId]);
      await assert.rejects(saveDateBlocks(context.core,calendar,meta(),{selection,previewHash:first.previewHash},Date.now()),{code:'DATE_BLOCK_REVIEW_CHANGED'});
      const review=await previewDateBlocks(context.core,calendar,selection,Date.now());assert.equal(review.appointmentCount,1);
      const command=meta(),input={selection,previewHash:review.previewHash};
      const [saved,retry]=await Promise.all([saveDateBlocks(context.core,calendar,command,input,Date.now()),saveDateBlocks(context.core,calendar,command,input,Date.now())]);
      assert.deepEqual(saved,retry);assert.equal(saved.createdDateCount,2);
      assert.equal((await context.core.query('SELECT status FROM appointments WHERE id=$1',[f.appointmentId])).rows[0].status,'pending');
    }finally{
      await context.core.query('DELETE FROM chief_complaint_history WHERE "appointmentId"=$1',[f.appointmentId]);
      await context.core.query('DELETE FROM pre_consultations WHERE "appointmentId"=$1',[f.appointmentId]);
      await context.core.query('DELETE FROM doctor_date_blocks WHERE doctor_id=$1',[f.doctorId]);
    }
  }));
  await t.test('EDA doctor dashboard PostgreSQL aggregates beyond ordinary history caps', () => fixture(context, async f => {
    await context.core.query('UPDATE appointments SET status=$2 WHERE id=$1', [f.appointmentId, 'pending']);
    // Isolated owner fixture only; no production lifecycle transitions or provider operations.
    await context.core.query(`INSERT INTO appointments (id,"patientId","doctorId",status,"scheduledAt","updatedAt","billingLineageId")
      SELECT gen_random_uuid()::text,$1,$2,'completed',NOW()-INTERVAL '1 year',NOW(),$3 FROM generate_series(1,620)`,
    [f.patientId, f.doctorId, f.lineage]);
    const actor = { ...f.actor, authId: f.doctorAuthId, role: 'doctor' as const, resource: f.doctorAuthId, scopes: ['appointments.dashboard.read'] };
    const result = await createAppointmentReads(context.core, { payment: f.store }).dashboard(actor);
    assert.deepEqual(result.summary, { today: 0, pending: 1, patients: 1, completed: 620 });
    assert.deepEqual(result.statusCounts, { pending: 1, completed: 620 });
    assert.deepEqual(result.pendingRequestIds, [f.appointmentId]);
    assert.equal(result.appointments.length, 1);
    await context.core.query('UPDATE appointments SET status=$2,"consultationType"=$3,"scheduledAt"=$4 WHERE id=$1',
      [f.appointmentId, 'approved', 'in_person', new Date('2026-10-15T17:00:00Z')]);
    const manila = await createAppointmentReads(context.core, { payment: f.store }, () => Date.parse('2026-10-15T17:00:00Z')).dashboard(actor);
    assert.deepEqual(manila.summary, { today: 1, pending: 0, patients: 1, completed: 620 });
    assert.deepEqual(manila.todayAppointmentIds, [f.appointmentId]);
    await assert.rejects(createAppointmentReads(context.core, { payment: f.store }).dashboard({ ...actor, authId: randomUUID() }),
      { code: 'ACTOR_SCOPE_DENIED' });
  }));
  await t.test('EDA remaining owners PostgreSQL feedback deduplicates concurrent commands without SQL injection', () => fixture(context, async f => {
    const command = () => ({ operationId: randomUUID(), requestHash: 'a'.repeat(64) });
    await f.module.checkout(f.actor, f.appointmentId, command());
    f.pay(); await f.module.reconcile({ ...f.actor, scopes: ['payments.reconcile'] }, f.appointmentId, command());
    const payment = (await f.store.byAppointment(f.appointmentId))!;
    const fact = (await context.integrations.query<OutboxRow>('SELECT * FROM outbox_events WHERE "aggregateId"=$1 AND "eventType"=$2', [payment.id, 'vital.payment.completed'])).rows[0]!;
    await consumePayment(context.core, context.integrations, envelopeFromRow(fact), readPaymentProjectionAppointment);
    // Owner-scoped fixture setup, not evidence of Appointment confirmation acceptance.
    await context.core.query('UPDATE appointments SET status=$2 WHERE id=$1', [f.appointmentId, 'completed']);
    const owner = createAppointmentExtras(context.core, { financial: { verifyPaid: f.module.verifyAppointmentPaid } });
    const actor = { ...f.actor, scopes: ['appointments.feedback'] }, meta = command();
    try {
      const input = { expectedVersion: 0, rating: 5 };
      const [first, retry] = await Promise.all([owner.feedback(actor, f.appointmentId, meta, input), owner.feedback(actor, f.appointmentId, meta, input)]);
      assert.equal(first.feedback.id, retry.feedback.id);
      assert.equal((await context.core.query('SELECT COUNT(*) AS count FROM feedback WHERE "appointmentId"=$1', [f.appointmentId])).rows[0].count, '1');
      assert.equal((await context.core.query('SELECT "starRating" FROM vital_doctors WHERE "userId"=$1', [f.doctorId])).rows[0].starRating, 5);
      assert.equal((await context.core.query('SELECT feedback FROM feedback WHERE "appointmentId"=$1',[f.appointmentId])).rows[0].feedback,null);
      const journal = (await context.core.query('SELECT result FROM command_operations WHERE "actorId"=$1 AND "operationId"=$2', [actor.authId, meta.operationId])).rows[0].result;
      assert.deepEqual(journal, { feedbackId: first.feedback.id });
      assert.equal((await context.core.query('SELECT COUNT(*) AS count FROM outbox_events WHERE "aggregateId"=$1 AND payload->>\'auditType\'=$2', [f.appointmentId, 'vital.appointment.feedback_saved'])).rows[0].count, '1');
      await assert.rejects(owner.feedback(actor, f.appointmentId, meta, { ...input, rating: 1 }), { code: 'COMMAND_REPLAY_CONFLICT' });
    } finally { await context.core.query('DELETE FROM feedback WHERE "appointmentId"=$1', [f.appointmentId]); }
  }));
  await t.test('EDA remaining owners PostgreSQL intake denies unrelated doctors and preserves provenance', () => fixture(context, async f => {
    const submittedAt = new Date('2026-10-01T01:02:03.000Z'), intakeId = randomUUID();
    await context.core.query(`INSERT INTO pre_consultations (id,"appointmentId","chiefComplaint",opqrst,"submittedAt") VALUES ($1,$2,$3,'null'::jsonb,$4)`, [intakeId, f.appointmentId, 'Fixture intake', submittedAt]);
    try {
      const owner = createAppointmentExtras(context.core, {});
      const actor = { ...f.actor, authId: f.doctorAuthId, role: 'doctor' as const, resource: f.patientId, scopes: ['appointments.intake.read'] };
      const result = await owner.intakes(actor, f.patientId, {});
      assert.equal(result.items[0].submittedAt.toISOString(), submittedAt.toISOString());
      assert.equal(result.items[0].appointmentId, f.appointmentId);
      await assert.rejects(owner.intakes({ ...actor, authId: randomUUID() }, f.patientId, {}), { code: 'APPOINTMENT_MEMBERSHIP_REVOKED' });
      await assert.rejects(owner.intakes({ ...actor, resource: randomUUID() }, f.patientId, {}), { code: 'ACTOR_SCOPE_DENIED' });
    } finally { await context.core.query('DELETE FROM pre_consultations WHERE id=$1 AND "appointmentId"=$2', [intakeId, f.appointmentId]); }
  }));
}
