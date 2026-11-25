import {reportRange} from "../../contracts/admin-reporting.js";
import { DomainError, type Actor } from '../../contracts/actor.js';
import { authorizeExport, completionCount, completionRole, completionUnavailable, type CompletionOwners, type ExportQuery } from '../../contracts/completion.js';
import type { createCompletionProfileOwner } from '../profile/profile-completion.js';

export function createCompletionReads(profile: ReturnType<typeof createCompletionProfileOwner>, owners: CompletionOwners = {}) {
  return {
    async patientDashboard(actor: Actor) {
      completionRole(actor, 'patient', 'completion.patient.dashboard');
      const patientId = await profile.patient(actor);
      if (!owners.appointments) completionUnavailable('APPOINTMENT');
      if (!owners.records) completionUnavailable('RECORDS');
      if (!owners.financial) completionUnavailable('PAYMENT');
      const snapshot = await owners.appointments.patient(actor);
      const { appointments } = snapshot;
      if (snapshot.patientId !== patientId || appointments.length > 4 || appointments.some(row => row.patientAuthId !== actor.authId || row.patientId !== patientId))
        throw new DomainError(409, 'COMPLETION_PATIENT_CHANGED', 'Patient ownership changed.');
      const summary = await owners.records.patientSummary(actor, patientId);
      const financial = await owners.financial.patientSummary(actor, patientId, snapshot.associations);
      await snapshot.validate();
      await financial.validate();
      if (await profile.patient(actor) !== patientId) throw new DomainError(409, 'COMPLETION_PATIENT_CHANGED', 'Patient ownership changed.');
      // Auth-name enrichment and central Gateway notifications are BFF composition, not Core storage.
      return { patientId, appointments, statusCounts: snapshot.statusCounts, paid: completionCount(financial.paid),
        documents: completionCount(summary.documents), files: completionCount(summary.files) };
    },
    async adminDashboard(actor: Actor) {
      completionRole(actor, 'admin', 'completion.admin.dashboard');
      await profile.admin(actor);
      if (!owners.appointments) completionUnavailable('APPOINTMENT');
      const accounts = await profile.accounts();
      const overview = await owners.appointments.adminOverview(actor);
      await profile.admin(actor);
      return { summary: accounts, ...overview };
    },
    async adminReport(actor:Actor,kind:"collections"|"satisfaction"|"specialties",raw:unknown){
      completionRole(actor,"admin","completion.admin."+kind);await profile.admin(actor);const range=reportRange(raw);
      const read=kind==="collections"?owners.financial?.collections:owners.appointments?.[kind];
      if(!read)completionUnavailable(kind==="collections"?"PAYMENT":"APPOINTMENT");
      const result=await read(actor,range);await profile.admin(actor);return result;
    },
    consents: profile.consents,
    consentStatus: profile.consentStatus,
    acceptConsent: profile.acceptConsent,
    async exportSubmitted(actor: Actor, query: ExportQuery) {
      authorizeExport(actor);
      if (!owners.appointments) completionUnavailable('APPOINTMENT');
      return owners.appointments.exportSubmitted(actor, query);
    },
  };
}

export type CompletionReads = ReturnType<typeof createCompletionReads>;
