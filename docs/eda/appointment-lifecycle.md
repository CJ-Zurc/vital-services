# Appointment lifecycle checkpoint

Authority: `EDA_TRANSITION_PLAN_REVISED.md` and the approved Appointment Lifecycle
And Saga Implementation plan. Target flags remain off. This document is the
pre-extraction manifest; implementation evidence is recorded separately. Legacy
staging remains unchanged. No cross-database transaction or legacy writer bridge.

## Browser and internal route manifest

All browser routes keep Gateway/session authentication, correlation and refreshed
session headers/cookies. Internal routes require process mTLS and signed actor
delegation, independently checked membership/ownership, strict versioned DTOs and
mutation command IDs/hash binding. Validation errors use 400/422, ownership 403,
missing resources 404, stale versions/replay conflicts 409, unavailable owners
503, and unfinished durable operations 202. Browser adapters retain paths and
session transport and decode versioned mutation DTOs. Full composed legacy
response parity remains gated, not claimed by this checkpoint.

| Browser method/path | Internal surface | Authority/dependencies/readiness |
| --- | --- | --- |
| GET `/api/patient/doctors`, `/api/patient/doctors/{id}/availability` | GET `/internal/v1/appointments/doctors`, `/doctors/{id}/availability` | Patient; composed discovery view explicitly 503 until parity |
| GET/POST `/api/doctor/schedule`; PATCH/DELETE `/{slotId}` | `/internal/v1/schedules` and `/{slotId}`; delete is internal POST `/{slotId}/delete` | Owning doctor; GET composition gated; affected bookings require cancellation participants |
| GET/POST `/api/doctor/date-blocks`; DELETE `/{blockId}` | `/internal/v1/date-blocks`; internal POST `/{blockId}/delete` | Owning doctor; acknowledgement count; blocks do not cancel bookings |
| GET/POST `/api/patient/appointments` | GET/POST `/internal/v1/appointments` | Patient membership; own EHR identity verified through BFF; intake/consent in Core |
| GET `/api/doctor/appointments`, `/api/doctor/appointment-requests` | GET `/internal/v1/appointments` with doctor view | Owning doctor; financial/Video composition must not invent fields |
| PATCH `/api/doctor/appointment-requests/{id}/approve` | Appointment workflows prepare/status/commit | Owning doctor; required EHR receipt; Video/Records gates; checkout warning after approval |
| PATCH `/api/doctor/appointment-requests/{id}/reject` | POST `/internal/v1/appointments/{id}/reject` | Owning doctor; pending only; reason stays Core |
| PATCH `/api/{patient,doctor}/appointments/{id}/cancel` | POST `/internal/v1/appointments/{id}/cancel` | Owning actor; committed cancellation time/financial intents; required Records gate |
| PATCH `/api/{patient,doctor}/appointments/{id}/reschedule` | POST `/internal/v1/appointments/{id}/reschedule` | Owning actor; one unresolved proposal per lineage; accepted quotas |
| PATCH `/api/patient/appointments/{id}/accept-reschedule` | POST `/internal/v1/appointments/{id}/accept-reschedule` | Patient; durable coordinator; unavailable participant blocks before pivot |
| PATCH `/api/patient/appointments/{id}/decline-reschedule` | POST `/internal/v1/appointments/{id}/decline-reschedule` | Patient; actual prior state and reason; no quota consumed |
| PATCH `/api/appointments/{id}/complete` | POST `/internal/v1/appointments/{id}/complete` | Assigned patient/doctor; paid/confirmed; Records completion gate |
| POST `/api/doctor/appointments/{id}/follow-up` | Appointment workflows | Owning doctor; completed source; new EHR case, bill and meeting lineage |
| POST `/api/internal/appointments/auto-complete` | Existing worker maintenance, no Web callback in target | Scoped worker; fresh state/version; no pending proposal; Records gate |
| GET `/integrations/v1/appointments`, `/integrations/v1/patient/appointments`; Analytics pre-consultations export | Existing directional adapter contracts | Preserve auth/privacy; no legacy reads in target; explicitly gate uncomposed exports |
| Clinical/vitals/documents, Meet OAuth/generation, chat and both SSE flows | Future owner interfaces | Not extracted here; fail closed in target; no synthetic success |

Workflow methods: POST `/internal/v1/appointments/workflows`, GET
`/internal/v1/appointments/workflows/{id}`, POST `/{id}/external-start`, POST `/{id}/commit`. Prepare and
commit have distinct command IDs, the same workflow/input binding and expected
versions. Clinical request transport is user-scoped BFF -> Gateway/EHR; no
tokens or duplicate clinical bodies in the workflow ledger.

Private operation GET `/internal/v1/appointments/operations/{id}` permits the
owning patient/doctor or independently verified Core admin. POST `/{id}/resume`
is Core-admin-only with expected fence and audited command binding. Resume only
compensates before pivot or recovers forward after pivot; it cannot force a new
pivot, overwrite an unknown provider operation or release a committed hold.

## Runtime readiness

Calendar writes, date-block reads/writes, booking/intake, rejection/proposals and
decline contracts are implemented. Offering a new consultation type via schedule
creation requires a future Profile availability upgrade interface; otherwise
`PROFILE_SCHEDULE_UPGRADE_UNAVAILABLE` prevents bypassing Profile ownership.
All list/discovery/schedule browser views require full composition/parity and
remain 503 at the HTTP boundary. Private scoped appointment reads are available
for workflow orchestration, not a replacement browser serializer.

Approval/follow-up require real Records, Video and scoped EHR recovery. Payment
coordination is implemented against its actual Integrations ledger. Reschedule
also needs real Records/Video; cancellation needs Records; confirmation and
completion need Records plus verified financial evidence. Runtime supplies no
fake participant. Messaging/SSE contracts are defined but streams, history
composition and chain delivery remain later-owner gates.

Unstarted expired workflows can be abandoned under the doctor calendar lock and
their pending follow-up drafts rejected before a new preparation. Started/unknown
EHR operations are never abandoned as proof of absence; require scoped resolution
and a fresh authorized session. Changed/irreconcilable Core state remains review
work, not permission for background clinical creation.

## Legal transitions and corrections

Pending requests can be rejected or approved; doctor proposals require patient
acceptance. Only approved/confirmed appointments occupy committed slots.
Verified current paid observations can confirm eligible approved appointments,
never cancelled/rejected/rescheduled/expired ones. Reschedule acceptance commits
source `rescheduled` plus replacement approved/confirmed according to verified
financial state; preserve the two accepted changes per initiator and history.
Cancellation is patient pending/approved/confirmed or doctor approved/confirmed.
Completion requires paid/confirmed, start reached and no unresolved proposal.
The first acknowledgement starts 24 hours; doctor acknowledgement locks paperwork.
Both acknowledgements or the existing fallback deadline may complete only with
required Records effects. Follow-up requires a completed source and no active
follow-up, and is a new billed/meeting workflow.

Approved corrections: schedule cancellation uses the full doctor-cancellation
contract; auto-completion waits for unresolved reschedules and rechecks versions;
expiry uses slot/proposed end or start when absent. Do not introduce a new public
status enum. One unresolved proposal applies to both initiators; reasons and true
prior states are preserved.

Expired proposals become the existing `rejected` terminal state, releasing the
unique proposal fence without consuming accepted quotas. Source cancellation or
expiry rejects its open proposals. Maintenance checks due records in bounded
batches with a persisted retry cursor so blocked rows cannot monopolize scans.
Repeated acknowledgement cannot extend the first deadline or emit duplicate audit.

## Transaction and participant contracts

All calendar writers use one doctor-scoped transaction advisory lock and check
interval overlap across committed occupancy and live holds. Pending requests
remain competing. Reservations have 60-second leases renewed every 15 seconds;
preparation deadline is five minutes, independent of patient-facing expiry.

Saga: validate/reserve -> owner preparation/freeze receipts -> Core pivot -> owner
finalization -> completed. Required absence blocks preparation. Explicit verified
no-resource is not equivalent to timeout. Before pivot abort/release; after pivot
recover forward, and never expire a participant without checking pivot evidence.
Store immutable request/resource/version/lineage/association bindings and fences.

Payment owns prepare/abort/finalize and its freeze. Unknown writes block transfer.
Retain immutable provider-origin identity separately from current association;
preserve provider IDs, frozen quote and historical invoices. Core owns source and
replacement status/counters/EHR linkage. Records/Video require real interfaces;
no legacy Prisma fallback, synthetic ACK or new provider creation on reschedule.

## Facts and audit

Facts carry IDs, source versions, lineage/association and operation/causation only.
Participant commands are distinct from committed facts. Separate inbox consumers
for payment projection and Appointment confirmation. Persist effects/outbox/inbox
before ACK. One central audit intent per mutation; central notification delivery
only. No clinical text, chat body, reasons, URLs, provider responses or secrets in
event/log payloads.

`vital.appointment.participant.requested` is a command, not a source fact; phases
are prepare/abort/finalize, with stable phase event IDs. Its separate
`appointment-saga` inbox commits a durable wake before ACK. The existing worker
resumes participant protocols under leases, including after a wake/worker crash.
Payment and Video do not mistake broker ACK for a preparation receipt.
Records/Video/Messaging each have a separate bounded durable future-owner queue
for Appointment facts. No placeholder consumers discard those facts. Observe
queue limits/backpressure before future activation; they add no new containers.

Central audit mappings include lifecycle facts, completion acknowledgement,
recovery request, schedule created/updated/deleted and date-block created/deleted.
Cancellation/follow-up alone activate existing central in-app templates. No new
email/SMS, direct notification sockets or legacy broker fallback.

Core and Integrations migrations are additive after earlier checkpoints. New
interval/fence/active-lineage constraints and pool-local UTC timestamp parsing
support Philippine overnight rules without changing legacy process timezones.
No migration was applied to any shared database.

## Exit

### Browser Compatibility Completion

The API mounts `POST /internal/v1/appointments/command-preparations` and
`GET /internal/v1/appointments/command-preparations/{commandId}` before generic
Appointment routes. Distinct `appointments.command.prepare/read` scopes bind
the resource to the command UUID. The Core ledger stores identifiers/hashes and
original revisions only; membership is rechecked on prepare/read/replay. The
additive `202610160003_appointment_command_preparations` migration and maintained
Prisma model describe the same table. No migration was executed here.

Approval preparation accepts the existing `confirmConflicts` boolean. Under the
doctor calendar fence, unconfirmed competing pending requests return the typed
`APPOINTMENT_SLOT_PENDING_CONFLICTS` response before Video/EHR preparation. Only
IDs leave that error boundary. Web composes the existing dialog payload through
authorized current request reads; changed/missing conflicts require refresh.
Confirmed retries still pass the calendar/lifecycle checks. Follow-ups reject
this approval-only field.

Committed cancellation returns its existing business success while retaining
separate pending financial processing metadata. Unfinished approval/reschedule
work returns a non-success conflict with Retry-After; it is not presented as a
completed operation. Empty optional decline/schedule-reason fields retain their
legacy normalization without accepting caller identity or authority fields.

Code checkpoint only: static/build/regression evidence, additive migrations,
contract and crash scenarios, explicit runtime gates. Live PG/RabbitMQ/mTLS,
provider, UI/SSE/ingress, resource and rollback acceptance remain deferred. No
commits, pushes, shared resets, ports, provider actions or deployment.
