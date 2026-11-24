# VITAL virtual EHR lifecycle

## Scope and activation

The implementation spans EHR, VITAL Services and VITAL Web. F2F appointments,
including F2F follow-ups of virtual appointments, remain booking-only: no case,
EHR follow-up plan, payment, prescription/certificate or clinical-access grant is
created by that flow. Hospital-origin follow-up booking is not supported.

Enable `VITAL_EHR_LIFECYCLE_ENABLED=true` in compatible Web and Services only
after migrations, grants and EHR configuration. Services requires appointment
maintenance enabled, `VITAL_EHR_INTERNAL_URL`, the existing
`VITAL_EHR_RECORDS_PUBLIC_KEYS_FILE`, and the separate
`VITAL_SERVICES_EHR_LIFECYCLE_KEY`. Web receives neither the key nor signing keys.
The existing EHR Records evidence signer must be enabled. Directional credentials
are not interchangeable with mirror, recovery, Gateway or Auth credentials.

## Onboarding and intake

`GET /api/patient/profile/onboarding-prefill` requires a current patient session,
rejects query parameters, and reads the authenticated EHR patient-self endpoint
through Gateway in VITAL context. It is deliberately permitted before agreement
acceptance and before the Core EHR link exists. Only onboarding demographics
are returned; no IDs, MRN, names, diagnoses or clinical history are projected.
Only a genuine EHR 404 yields `found:false`. Denials/outages remain visible
failures and block submission until retried. Late/retried reads preserve edited
fields. Agreement acceptance remains mandatory before onboarding submission.
Existing-patient writes still use the existing contact/address allowlist and
receipt recovery. This does not bypass EHR's independent write authorization.

Chief-complaint correction remains doctor-only, virtual/confirmed, versioned,
code-unlocked, within its live paperwork window and free of conflicting operations.
Pre-acceptance review and F2F complaints are read-only. Corrections preserve
history and existing AI reanalysis; they are not diagnoses.

## Final diagnosis and completion

Doctor BFF routes under `/api/doctor/appointments/{id}/ehr` provide
`GET/POST final-diagnosis`, `GET status`, and `POST retry`. Owning patients have
`GET /api/patient/appointments/{id}/ehr/status`. Domain operations use signed
Web-to-Services transport with exact `appointments.ehr.read/write` scopes.
The internal `POST /internal/v1/appointments/{id}/ehr/readiness` is used before
completion snapshot capture; it is not a public browser mutation endpoint.

Final-diagnosis writes require explicit `description`, optional `condition_id`,
`certainty` (`provisional`, `confirmed`, `ruled_out`) and `notes`; role is fixed
to `discharge`. `expectedVersion`, `expectedDiagnosisId` and stable idempotency
keys protect revisions. Browser-supplied case/patient/doctor IDs are denied.
Services checks current membership/ownership, live code access, consent,
processing/hold state and verified payment before clinical transport.

EHR signs short-lived readiness with its Records key and separate audience
`vital-services.lifecycle`, bound to appointment, patient, doctor, case and
diagnosis revision. Services verifies it before freezing the completion snapshot
and before the completion transaction. Missing diagnosis prevents completion;
maintenance leaves the appointment unresolved with its prerequisite indicator.
A diagnosis revision after doctor acknowledgment requires reconciliation rather
than silently substituting a different final assessment.

Only an actual virtual Completed transition creates a closure intent, atomically
with that transition. `appointment_ehr_lifecycle` stores IDs, delivery payload,
receipt and safe error codes, not clinical text. States are `ready`, `pending`,
`synced`, `needs_attention`; reads use `not_ready` before a readiness record exists.
Completion and synchronization states are distinct. Worker delivery has a
60-second claim lease, bounded exponential retry (30 seconds to one hour), and
attention after 12 attempts or a non-transient conflict. An assigned doctor may
explicitly retry a completed encounter's failed synchronization. No UI claims
EHR closure succeeded before a validated receipt is stored.

## Follow-up and recovery

A virtual follow-up requires a completed virtual source whose EHR closure is
synced. EHR creates a dated plan owned by the same attending physician. Existing
one-pending-plan-per-patient constraints remain authoritative; hospital plans
are never overwritten or cancelled by VITAL.

The workflow persists `ehrPlanStartedAt` before the external plan request and
recovers that same operation ID after ambiguous responses. `ehrFollowUpId`
links the new child appointment's case creation payload to the EHR plan.
Opening the new case fulfills the plan and records `follow_up_of`; it does not
complete the VITAL consultation. The previous case stays closed. Manual Meet
links, payment, calendar validation and appointment versions remain enforced.
Rescheduling transfers the existing case association rather than consuming the
plan again.

Expired preparations with no case-opening attempt are recovered before their
unused VITAL-owned plan is cancelled and the local child is rejected. Uncertain
case-opening operations retain existing case-receipt recovery; they are never
treated as permission to cancel a potentially consumed plan. A return visit
requires its own final diagnosis and closure intent.

## Rollout and verification

1. Apply EHR's `202611240001` lifecycle-receipt migration on its existing branch
   after `202611160001`; retain the repository's other migration heads.
2. Deploy compatible EHR with its dedicated lifecycle key and Records signer.
3. Apply Services Core `202611240001_ehr_lifecycle` and normal runtime grants.
4. Deploy compatible Web/Services, configure the worker and then enable the flag.

These are operator steps; no migration or deployment is performed by the source
change. No historical case closure, plan population, or appointment backfill is
automatic. Existing virtual records may require explicit final-diagnosis review
when completing after activation. Cancellation/abandoned accepted-case closure
policy remains separate; this feature closes only completed virtual visits.

Source/fixture test results and live integration acceptance must be reported
separately. PostgreSQL locking, actual Auth/EHR delivery and a paired deployed
journey require operator verification with the compatible schema and credentials.

See [the verification record](ehr-lifecycle-verification.md) for completed checks and blocked native/live acceptance.
