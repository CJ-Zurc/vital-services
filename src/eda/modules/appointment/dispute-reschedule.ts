import type { PoolClient } from 'pg';
import type { AppointmentRow } from './appointment-contracts.js';

/** The grant is separate from normal quotas and stays bound to its reviewed decision. */
export async function disputeRescheduleGrant(tx:Pick<PoolClient,'query'>,source:AppointmentRow,proposal?:AppointmentRow){
  if(source.status!=='in_review'||!source.reviewHold)return null;
  const grant=(await tx.query(`SELECT id,"decisionId" FROM appointment_disputes WHERE "appointmentId"=$1 AND stage=5 AND "proposedOutcomeTag"='reschedule'
    AND "rescheduleGranted"=true AND "rescheduleConsumedAt" IS NULL AND "resolutionMethod" IN ('patient_acknowledged','auto_resolved_72h')`,[source.id])).rows[0];
  if(!grant||proposal&&(proposal.disputeAuthorizationId!==grant.id||proposal.disputeDecisionId!==grant.decisionId))return null;
  return grant as {id:string;decisionId:string};
}
