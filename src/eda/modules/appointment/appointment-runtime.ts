import {readFileSync} from 'node:fs';
import {createEhrLifecycle} from './ehr-lifecycle.js';
import { acknowledgmentNames } from '../payment/acknowledgment-names.js';
import { createBookingAcknowledgments } from './booking-acknowledgment.js';
import type { Pool } from "pg";
import type { PaymentModule } from "../../http/payment-router.js";
import { createAppointmentModule } from "./appointment.js";
import { createAppointmentSaga } from "./appointment-saga.js";
import type { AppointmentRuntime } from "../../http/appointment-router.js";
import { createAppointmentMaintenance } from "./appointment-maintenance.js";
import { resumeAppointmentSaga } from "./appointment-review.js";
import { createEhrCaseRecovery } from "./adapters/ehr-case-recovery.js";
import type { RecordsRuntime } from "../records/runtime.js";
import type { VideoRuntime } from '../video/runtime.js';
import { createAppointmentReads } from './appointment-reads.js';
import { createPaymentStore } from '../payment/payment-store.js';

export function appointmentRuntime(databases:{corePool:Pool;integrationsPool:Pool},payment:PaymentModule|undefined,environment=process.env,records?:RecordsRuntime,video?:VideoRuntime):AppointmentRuntime|undefined{
  if(environment.VITAL_EDA_APPOINTMENT_ENABLED!=="true"){
    if(environment.VITAL_EDA_APPOINTMENT_MAINTENANCE_ENABLED==="true")throw new Error("APPOINTMENT_MAINTENANCE_WITHOUT_OWNER");return undefined;
  }
  if(environment.VITAL_EDA_ENABLED!=="true")throw new Error("APPOINTMENT_RUNTIME_DISABLED");
  const owners={...(payment?{financial:{verifyPaid:payment.verifyAppointmentPaid},payment:{prepare:(id:string)=>payment.prepareReassociation(id),abort:(id:string,token?:string)=>payment.abortReassociation(id,token),finalize:(id:string,token:string)=>payment.finalizeReassociation(id,token)}}:{})};
  if(environment.VITAL_EHR_LIFECYCLE_ENABLED==='true'&&environment.VITAL_EDA_APPOINTMENT_MAINTENANCE_ENABLED!=='true')throw new Error('EHR_LIFECYCLE_REQUIRES_MAINTENANCE');
  const recovery=environment.VITAL_SERVICES_EHR_RECOVERY_KEY;
  const ehrLifecycle=environment.VITAL_EHR_LIFECYCLE_ENABLED==='true'?createEhrLifecycle(databases.corePool,{baseUrl:environment.VITAL_EHR_INTERNAL_URL??'',key:environment.VITAL_SERVICES_EHR_LIFECYCLE_KEY??'',financial:owners.financial,keys:JSON.parse(readFileSync(environment.VITAL_EHR_RECORDS_PUBLIC_KEYS_FILE??'','utf8'))}):undefined;
  const configuredOwners={...(ehrLifecycle?{ehrLifecycle}:{}),...owners,bookingNames:acknowledgmentNames(environment),...(records?{records:records.lifecycle}:{}),...(video?{video:video.associations}:{}),...(recovery?{ehrRecovery:createEhrCaseRecovery({baseUrl:environment.VITAL_EHR_INTERNAL_URL??"",key:recovery})}:{})};
  // Unextracted owners are deliberately absent, not success-shaped placeholders.
  const module=createAppointmentModule(databases.corePool,configuredOwners);const saga=createAppointmentSaga(databases.corePool,configuredOwners);
  const maintenance=createAppointmentMaintenance(databases.corePool,configuredOwners,payment);
  const reads=createAppointmentReads(databases.corePool,{...(payment?{payment:createPaymentStore(databases.integrationsPool)}:{}),...(video?{video}:{})});
  return{module,saga,reads,ehrLifecycle,bookingAcknowledgment:createBookingAcknowledgments(databases.corePool,{regularPath:environment.VITAL_RECORDS_FONT_REGULAR_FILE??"/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",boldPath:environment.VITAL_RECORDS_FONT_BOLD_FILE??"/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"}),listRequests:reads.streamRequests,resume:(actor,id,meta,body)=>resumeAppointmentSaga(databases.corePool,actor,id,meta,body),async maintenanceTick(){await saga.recover();if(ehrLifecycle){await ehrLifecycle.abandonExpired();await ehrLifecycle.deliver();}const lifecycle=await maintenance.lifecycle();const deliveries=await maintenance.deliverBilling();return{...lifecycle,deliveries};}};
}
