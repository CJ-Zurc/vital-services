import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { parseEvent, type EventEnvelope } from "../contracts/events.js";
import { envelopeFromRow, processWithInbox, type OutboxRow } from "../infrastructure/outbox.js";

export interface PaidAppointmentEvidence {
  appointmentId:string;paymentId:string;paymentVersion:number;billingLineageId:string;associationVersion:number;
  reviewRequired:boolean;status:string;eventId:string;correlationId:string;
}
export type ApplyPaymentConfirmation=(tx:PoolClient,evidence:PaidAppointmentEvidence)=>Promise<void>;
export async function consumeAppointmentPayment(core:Pool,integrations:Pool,raw:EventEnvelope,apply:ApplyPaymentConfirmation){
  const event=parseEvent(raw);
  if(!['vital.payment.completed','vital.payment.changed'].includes(event.eventType)||event.producer!=="payment")throw new Error("APPOINTMENT_PAYMENT_SUBSCRIPTION_MISMATCH");
  const fact=(await integrations.query<OutboxRow>('SELECT * FROM outbox_events WHERE id=$1',[event.eventId])).rows[0];
  if(!fact||!isDeepStrictEqual(envelopeFromRow(fact),event))throw new Error("PAYMENT_FACT_UNCOMMITTED");
  const source=(await integrations.query<{id:string;appointmentId:string;billingLineageId:string;associationVersion:number;version:number;
    status:string;providerMode:string;paidAt:Date|null;reviewRequired:boolean}>(
    'SELECT id,"appointmentId","billingLineageId","associationVersion",version,status,"providerMode","paidAt","reviewRequired" FROM payments WHERE id=$1',[event.aggregateId])).rows[0];
  if(!source||source.id!==event.aggregateId||source.providerMode!=="sandbox"||!Number.isSafeInteger(source.version)||source.version<event.aggregateVersion
    ||source.billingLineageId!==event.data.billingLineageId||!Number.isSafeInteger(source.associationVersion)||source.associationVersion<Number(event.data.associationVersion)
    ||typeof source.reviewRequired!=="boolean")throw new Error("PAYMENT_SOURCE_UNVERIFIED");
  if(source.associationVersion===event.data.associationVersion&&source.appointmentId!==event.data.appointmentId)throw new Error("PAYMENT_ASSOCIATION_UNVERIFIED");
  if(source.version===event.aggregateVersion&&(source.reviewRequired!==event.data.reviewRequired
    ||event.eventType==='vital.payment.completed'&&(source.status!=='paid'||source.paidAt?.toISOString()!==event.data.paidAt)
    ||event.eventType==='vital.payment.changed'&&source.status!==event.data.status))throw new Error("PAYMENT_SOURCE_UNVERIFIED");
  await processWithInbox(core,"appointment-confirmation",event,async tx=>{
    if(source.associationVersion>Number(event.data.associationVersion)||source.status!=="paid"||source.reviewRequired)return;
    if(!source.paidAt)throw new Error("PAYMENT_PAID_RECEIPT_MISSING");
    await apply(tx,{appointmentId:source.appointmentId,paymentId:source.id,paymentVersion:source.version,billingLineageId:source.billingLineageId,
      associationVersion:source.associationVersion,reviewRequired:source.reviewRequired,status:source.status,eventId:event.eventId,correlationId:event.correlationId});
  });
}
