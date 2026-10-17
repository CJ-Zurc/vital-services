import type { Pool } from 'pg';
import type { AppointmentReads } from '../appointment/appointment-reads.js';
import { createAppointmentCompletionOwner } from '../appointment/appointment-completion.js';
import { createCompletionProfileOwner } from '../profile/profile-completion.js';
import { createCompletionReads } from './completion-reads.js';
import { createRecordsCompletionOwner } from '../records/completion.js';
import { createPaymentCompletionOwner } from '../payment/payment-completion.js';
import { createPaymentStore } from '../payment/payment-store.js';
import type { VideoRuntime } from '../video/runtime.js';

export function completionRuntime(databases: { corePool: Pool; integrationsPool: Pool },
  appointment: { reads: AppointmentReads } | undefined, environment: NodeJS.ProcessEnv = process.env, video?: VideoRuntime) {
  if (environment.VITAL_EDA_COMPLETION_ENABLED !== 'true') return undefined;
  if (environment.VITAL_EDA_ENABLED !== 'true') throw new Error('COMPLETION_RUNTIME_DISABLED');
  const profile = createCompletionProfileOwner(databases.corePool, {
    consentWrites: environment.VITAL_EDA_PROFILE_WRITES_ENABLED === 'true',
  });
  return createCompletionReads(profile, {
    appointments: appointment ? createAppointmentCompletionOwner(databases.corePool, appointment.reads, {
      ...(environment.VITAL_EDA_PAYMENT_ENABLED === 'true' ? { payment: createPaymentStore(databases.integrationsPool) } : {}),
      ...(video ? { video } : {}),
    }) : undefined,
    records: environment.VITAL_EDA_RECORDS_ENABLED === 'true' ? createRecordsCompletionOwner(databases.corePool) : undefined,
    financial: environment.VITAL_EDA_PAYMENT_ENABLED === 'true' ? createPaymentCompletionOwner(databases.integrationsPool, profile) : undefined,
  });
}
