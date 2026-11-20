# VITAL–TRACE integration revision for TRACE review

Updated 20 November 2026. Status — initial proposal awaiting TRACE and BGH API Gateway agreement.

VITAL proposes that patients submit telemedicine appointment disputes inside VITAL and that all VITAL–TRACE communication pass through BGH API Gateway. This revision replaces Google Forms intake, prefilled appeal links, form submission deadlines, and form synchronization as the proposed patient reporting flow. The earlier implementation is recorded in the [historical Google Forms ledger](../trace-integration-changes.md).

The report modal, TRACE approval queue, Gateway contracts, patient progress tracker, and patient resolution actions described below require further implementation after the teams agree on the contract. This documentation proposal is prepared on a fresh branch from development. The earlier integration branches remain historical implementation context. Keep `VITAL_TRACE_DISPUTES_ENABLED=false` until the replacement flow and paired acceptance checks are ready.

## Agreed scope and responsibilities

This first revision covers telemedicine appointment disputes. Face-to-face reporting is a future item for agreement. General ratings, compliments, and suggestions continue through their existing feedback channels.

| Owner | Responsibility |
| --- | --- |
| VITAL Web | Appointment report button and modal, submission feedback, patient-visible progress, resolution details, and patient acknowledgment or rejection of completion. |
| VITAL Services | Appointment ownership and eligibility checks, trusted identity metadata, atomic report and completion hold, durable delivery, linked ticket state, and valid appointment transitions. |
| BGH API Gateway | Approved cross-system routes, authenticated user or service context, correlation propagation, and forwarding in both directions. |
| TRACE | Pending-report storage, approval/rejection queue, patient creator mapping, ticket creation, staff routing, investigation, progress and resolution, acknowledgment deadlines, automatic resolution, and reconciliation reads. |
| Accounting | Issue approved refunds externally and confirm issuance separately through the agreed integration. |

Every authenticated account with the TRACE Admin role may approve or reject reports in the queue, regardless of department assignment. A VITAL Admin role alone does not authorize TRACE approval. Subsequent staff investigation and Accounting actions retain their own role restrictions.

## Patient submission and TRACE approval

1. On an eligible appointment's details page, show a red **Report an issue** button with an exclamation icon, an accessible name, and visible explanatory text.
2. Open a modal containing a subject, description, approved dispute category, applicable subcategory, and optional report evidence. Explain what is being submitted and display validation errors without losing the patient's input. Opening or cancelling the modal has no appointment effect.
3. On submission, VITAL verifies the signed-in patient's ownership and current appointment eligibility. Derive the appointment, doctor, patient, and Auth identity from trusted server data. Under the appointment lock, persist the report, completion hold, original completion deadline, and outbound delivery intent together so submission cannot race automatic completion.
4. VITAL returns the stable report reference. Deliver the report through Gateway using that reference for retries. Show **Pending delivery** until TRACE confirms durable receipt. An unavailable Gateway or TRACE keeps the report and hold pending reconciliation. Retry without creating a second report or ticket.
5. TRACE persists a report in a **Pending approval** queue visible to its Admin accounts and returns a receiving identifier. This receipt is distinct from approval or staff acknowledgment. Approval creates or activates exactly one linked ticket and continues TRACE's normal ticket workflow.
6. Rejection requires a patient-visible reason. VITAL records it, clears the report's completion hold, and resumes the original completion deadline through normal payment and clinical-record checks. Rejecting a report must not bypass those checks.
7. A concern redirected to VITAL Admin retains its review hold until an authorized resolution. TRACE should confirm whether redirection remains a supported queue action alongside approval and rejection.

TRACE must confirm eligibility by appointment state and incident type, the cutoff for completion disputes, the policy for duplicate active reports, and handling of complaints submitted after appointment completion. A post-completion report must not silently reverse a completed appointment.

## Proposed data sent to TRACE

Field names below are proposed integration names for TRACE review. They distinguish patient input from VITAL-owned identifiers and transport metadata. TRACE's current `TicketCreate` schema contains subject, description, category/subcategory, creator, priority, status, department, and created-for fields. Its documented ticket type is Employee. A patient-report adapter and an identity mapping are needed to support this flow.

| Field | Source | Purpose and proposed treatment |
| --- | --- | --- |
| `subject` | Patient | Required title. Follow TRACE's subject validation, including its 5–255 character rule and invalid-subject responses. |
| `description` | Patient | Required concern and requested resolution. TRACE to confirm length and accepted formatting. |
| `category_id` | Patient from approved options | TRACE-owned dispute category UUID. VITAL fetches the permitted categories through Gateway. |
| `sub_category_id` | Patient from approved options | Subcategory UUID when applicable. TRACE confirms whether it is required for the selected category. |
| `attachments` | Patient through an approved upload flow | Optional evidence submitted specifically for this report. Exchange authorized attachment references and agreed metadata after upload validation. TRACE to confirm its pending-report upload API and limits. |
| `appointment_id` | VITAL server | UUID of the appointment owned by the signed-in patient. |
| `patient_id` | VITAL server | VITAL patient identifier linked to that appointment. |
| `doctor_id` | VITAL server | Assigned doctor's VITAL identifier for that appointment. |
| `reporter_auth_id` | Auth/Gateway-verified session | Auth-owned UUID of the reporting patient. TRACE uses the agreed mapping to preserve the original creator for access and resolution actions. |
| `source_system` | VITAL server | Fixed value `vital`. |
| `appointment_type` | VITAL server | Telemedicine classification. TRACE to agree on the wire value and its mapping from VITAL's current `virtual` type. |
| `report_id` | VITAL server | Stable UUID for the submitted report and cross-system deduplication. |
| `submitted_at` | VITAL server | UTC timestamp when VITAL atomically accepts the report. Retries preserve this timestamp. |
| `X-Correlation-ID` | Trusted request context | Correlates delivery, processing, and acknowledgment across systems. |
| Idempotency identifier | VITAL server | Reused for the same submission. TRACE to confirm the header and duplicate-response contract. |

TRACE owns priority, department routing, assignments, ticket type, status, and audit attribution. Patient input must not set those authority fields. If TRACE continues to use local `created_by` or `created_for` UUIDs, TRACE must resolve them from `reporter_auth_id`; VITAL patient IDs, Auth IDs, and TRACE user IDs are separate namespaces. The service processing delivery must not replace the patient as the report's creator.

Patient display name may be included or resolved only where needed and authorized. Contact fields, schedule or billing context beyond the listed identifiers require an agreed purpose and contract. Appointment uploads, EHR records, prescriptions, medical reports, and the full patient profile are excluded from automatic transmission. The patient selects report evidence explicitly.

## Gateway interfaces requested from TRACE

Agree exact routes, schemas, response codes, and authorization with the Gateway team before implementation. The existing generic employee-ticket API and former direct-service callbacks do not establish authorization for this proposal.

| Operation | Required behavior |
| --- | --- |
| Category and upload preparation | Return the categories/subcategories patients may select and the authorized report-evidence upload mechanism. |
| Submit patient report | Persist a pending report and return its receiving ID, report ID, queue state, and receipt time. Repeated delivery returns the same report. |
| Approve/reject report | TRACE Admin records the decision. Approval links one ticket; rejection returns a patient-visible reason. VITAL receives the update through Gateway. |
| Read report and ticket progress | Return only patient-visible stages, current state, history/timestamps, linked identifiers, version, and permitted patient actions. Support reconciliation after lost updates. |
| Deliver progress and resolution updates | Preserve report, case where applicable, ticket, and appointment identifiers with an event ID, ordering/version information, UTC event time, and correlation context. |
| Read resolution and acknowledgment deadline | Return the patient-visible resolution, staff completion time, current acknowledgment deadline, and allowed response actions. |
| Acknowledge resolution | Verify the original reporting patient, current ticket state, and version. Return the resulting TRACE resolution state idempotently. |
| Reject staff completion | Verify the same creator and require a reason. Apply TRACE's return-to-work or reopening framework and return its resulting progress and deadline behavior. |
| Send appointment disposition and refund confirmation | Deliver explicit business outcomes separately from generic ticket progress or closure. Preserve decision IDs, correction links, and refund reconciliation identity. |

All VITAL–TRACE submissions, reads, evidence exchanges, updates, and patient resolution actions pass through Gateway. The owners must agree user and service authentication, directional scopes, and a supported return route into VITAL's existing Web/API trust boundary. Patients need an authorized route even when they have no TRACE staff account or TRACE staff system role. A browser-supplied creator UUID or an unverified identity header cannot grant access.

Durable report delivery and TRACE state changes must retain their retry intent with the owning transaction. Accepted events are deduplicated. Older or out-of-order updates must not overwrite newer progress. Reconcile by stable report/ticket identity after delivery failures, and show a pending or stale state until the owner confirms the outcome. Define retry exhaustion and manual review handling without silently releasing a completion hold.

## Progress, appointment outcomes, and patient acknowledgment

VITAL requests TRACE's progress-bar component or a design reference with its stage definitions, order, labels, colors, and dynamic-status behavior. Adapt it to appointment details as a patient-visible tracker. Patients view staff progress and use only their authorized response actions.

| TRACE event/state | VITAL presentation and appointment effect |
| --- | --- |
| Report pending delivery or approval | Show that stage and retain the review hold. |
| Approved, assigned, or investigation progressing | Show TRACE's current stage and keep the appointment In Review. |
| Staff work Completed | Show the resolution and acknowledgment deadline with **Acknowledge resolution** and **Issue not resolved** actions. Staff completion alone does not determine the appointment outcome. |
| Patient rejects completion | Require a reason, submit it to TRACE, and reflect TRACE's resulting state. Keep the hold while the matter remains unresolved. |
| Patient acknowledges or TRACE automatically resolves | Show the confirmed resolution method and timestamp. Apply only an accompanying explicit, eligible appointment disposition. |
| Ticket Closed or another terminal staff status | Show the patient-visible status. Obtain an explicit disposition before clearing the appointment hold or changing its outcome. |

TRACE's development code currently marks staff work Completed and automatically resolves it after **72 hours** if the creator does not respond. An older completion backlog still states **48 hours**. VITAL proposes following TRACE's current framework and displaying a TRACE-supplied `acknowledgment_deadline_at`, subject to TRACE's confirmation. VITAL does not calculate its own ticket-resolution deadline. This ticket acknowledgment clock is distinct from VITAL's existing 48-hour consultation completion window and the target for a human intake acknowledgment.

TRACE should confirm when the acknowledgment clock starts, notification and reminder behavior, rejection/reopening rules, and how automatic resolution is reported. A system auto-resolution must be identified as automatic; it must not be recorded as the patient's explicit acknowledgment.

Preserve the agreed appointment dispositions. **Appeal dismissed** resumes the original completion deadline and normal checks. **Appointment invalidated** records Invalid. **Reschedule agreed** starts VITAL's validated rescheduling workflow. Corrections carry a new decision ID referencing the active decision being superseded. Stale, conflicting, or no-longer-valid transitions go to VITAL Admin. The final mapping and timing relative to patient acknowledgment require TRACE's confirmation.

## Refunds, privacy, and other retained policies

Appointment invalidation, refund approval, and refund issuance are separate outcomes. Accounting issues an approved refund externally, then supplies the case/report link, issuance time, and reconciliation reference. Delivery is idempotent. Generic ticket closure or patient acknowledgment does not establish refund issuance. The former `/internal/v1/appointments/appeals/refund-confirmed` operation describes the existing receiving behavior; its Gateway-facing replacement must be agreed.

Confirmed doctor absence or failure to provide required paperwork remains eligible for refund review. Patient-only absence stays with VITAL Admin and has no refund under the agreed policy. Mutual absence remains ineligible even if TRACE separately investigates a doctor's failure to explain the absence. Technical failure requires investigation before assigning responsibility.

Authorized Admin/HR reviewers receive the concern and relevant report evidence. Accounting receives the identifiers and approved financial outcome needed for processing; complaint narrative and evidence remain restricted across case, ticket, attachment, and progress responses. TRACE must confirm how its general Admin approval access interacts with Accounting role combinations. VITAL receives only patient-visible resolution/progress content, excluding internal staff discussion and unrelated cases.

Existing agreed check-in, no-show, reconnect, paperwork, payment, completion, and private-reschedule timings remain the policy baseline for further review. The old 24-hour Google Form submission deadline and sync-watermark release rules are superseded by this in-system submission proposal. TRACE must confirm whether the one-business-day human acknowledgment target should run from VITAL acceptance or TRACE's durable receipt, including time awaiting approval.

## Requested TRACE response

| Confirmation | Details needed |
| --- | --- |
| Pending reports and approval | Schema, ticket creation timing, any TRACE Admin's approval authority, rejection reasons, and redirection support. |
| Patient creator identity | Mapping from Auth identity to TRACE ownership, patients without staff accounts, and restrictions on read/acknowledge/reject actions. |
| Progress UI | Component or design reference, core and dynamic stages, patient-visible fields, and update/reconciliation mechanism. |
| Acknowledgment | Confirm the 72-hour framework, returned deadline, reminders, automatic resolution, completion rejection, and reopening behavior. |
| Appointment effects | Explicit dispositions, when each releases a hold, correction handling, and timing relative to patient acknowledgment. |
| Evidence and privacy | Upload lifecycle and limits, validation/scanning, report attachment ownership, internal-message masking, and Accounting restrictions. |
| Gateway transport | Route/method matrix, user/service credentials and scopes, versioning, retries, deduplication, and outage reconciliation. |
| Eligibility and reporting policy | Allowed states and incident categories, duplicate active reports, post-completion complaints, withdrawal, and unresolved-hold escalation. |

## Acceptance scenarios for the replacement flow

- Patient submits from their own eligible telemedicine appointment. Trusted appointment, doctor, patient, and Auth IDs reach TRACE and one pending report appears in the Admin queue.
- Opening/cancelling the modal leaves the appointment untouched. Valid submission racing automatic completion produces one consistent result under the appointment lock.
- Duplicate clicks or a timeout after TRACE persisted the report recover the same report/ticket. An unavailable Gateway/TRACE preserves the pending state and hold, and retry eventually delivers once.
- TRACE Admin approval starts one ticket. Rejection returns its reason and resumes existing completion checks. A non-Admin account cannot approve a report.
- Progress updates appear on the correct appointment. Duplicate, stale, out-of-order, or missed updates are deduplicated or reconciled without regressing the tracker.
- Staff completion presents the resolution and TRACE deadline. Only the original patient can acknowledge or reject it. Rejection requires a reason and follows TRACE's framework.
- TRACE automatic resolution updates VITAL with an automatic-resolution marker. It does not masquerade as patient acknowledgment or automatically establish a refund or appointment outcome.
- An explicit disposition, correction, or duplicate refund confirmation follows the existing appointment/payment guards. Mutual absence produces no refund.
- Another patient, a forged identifier, or a patient without TRACE staff access cannot obtain unrelated reports, staff-only actions, internal comments, or protected evidence. Accounting restrictions hold through every response and attachment route.

These are proposed acceptance checks for the next implementation. Deployment acceptance remains pending agreement on the contract, Gateway wiring, migrations, and paired tests.

## Source review references

Reviewed against TRACE development `4220edf`, TRACE's previous integration branch `cfee9cc`, Gateway development `2fb33e4`, VITAL Services development `22990f9`, and VITAL Web development `e7e7300` after fetching origin on 20 November 2026.

- [TRACE ticket fields](https://github.com/Oeubx/TRACE_Backend/blob/4220edf/app/modules/ticket/schemas.py), [ticket service](https://github.com/Oeubx/TRACE_Backend/blob/4220edf/app/modules/ticket/services.py), and [72-hour auto-resolution scheduler](https://github.com/Oeubx/TRACE_Backend/blob/4220edf/app/services/scheduler.py).
- [TRACE lifecycle and progress layout](https://github.com/Oeubx/TRACE_Backend/blob/4220edf/docs/backlogs/module-5-lifecycle-escalation/status_state_machine.md) and [older completion backlog with the 48-hour discrepancy](https://github.com/Oeubx/TRACE_Backend/blob/4220edf/docs/backlogs/module-5-lifecycle-escalation/work_completion_and_resolution.md).
- [Previous Forms integration handoff](https://github.com/Oeubx/TRACE_Backend/blob/cfee9cc/docs/integration/patient-feedback/vital-trace-implementation-handoff.md), retained as historical implementation context.
