# VITAL–TRACE native dispute changes and verification

Updated 22 November 2026. Source implementation on isolated feature worktrees; deployment is **disabled**. This document supersedes transport examples and implementation claims in the earlier proposal. Google Forms is historical and is not a dependency of the native flow.

## Branches and baseline

| Repository | Branch | Starting remote tip |
|---|---|---|
| VITAL Services | `feat/trace-in-system-implementation` | `ac69f18` |
| VITAL Web | `feat/trace-in-system-implementation` | `81c0585` |
| TRACE Backend | `feat/vital-dispute-in-trace-implementation` | `fea6ae2` |
| BGH API Gateway | `feat/gateway/vital-dispute-integration` | Latest fetched `origin/development`, `2fb33e4` |

Origin was fetched before setup. Existing implementation branches were preserved without rebasing. Gateway's cleanup checkout was not changed. Publication is limited to the feature branches listed above; see their commit history for the delivered revision. Deployment remains disabled pending the checks below.

## Changes by owner

**Services:** Registers the identifier-only appeal event and audit vocabulary. Patient ownership, telemedicine state, the 15-minute doctor absence threshold, report, original completion deadline, hold and delivery intent are checked/recorded in one transaction. Duplicate submission recovers its report; rejected reports cannot create another report. Intake, evidence and patient responses have leased durable delivery. Callback inbox hashes prevent conflicting event reuse; versions and decision predecessors prevent older snapshots overwriting current state. Independent reconciliation repairs missed updates. Legacy unverified identities require review.

Complete releases the hold to the existing maintenance owner; original deadlines and payment/clinical checks remain authoritative. Invalidate calls Records lifecycle and the appointment transition owner. Reschedule authorizes one patient-selected published replacement outside ordinary quotas, through the existing doctor-approved coordinator and Payment association. Authorization is checked at proposal, acceptance, participant authority and pivot; consumed only on committed replacement. Source access is revoked and the replacement receives its own code. Automatic resolution without a selection creates a VITAL Admin follow-up, retaining the hold.

External refund receipts are reconciled by Payment with a stable case operation, without calling the refund provider. Approval, invalidation and external issuance remain separate. An explicit Admin doctor-fault finding is required for refund approval. Mutual absence remains ineligible. Conflicting payment activity goes to Admin review rather than another refund.

**Web:** Replaces synchronous best-effort TRACE calls with authenticated owner BFF commands and typed decoding. Native routes are included in actual proxy/session policy. Mutations enforce same-origin requests. Patient inputs cannot supply a foreign case, reporter or staff category. The tracker polls owner state and distinguishes delivery retry, pending patient response, Acknowledged and Automatically Resolved. Rejection displays the Admin reason and BGH contact modal. Optional report evidence uses new, report-owned uploads. An Admin follow-up page is available at `/admin/dashboard/disputes`. Web has no operational database, storage or provider credentials.

**TRACE Backend:** Provides versioned native intake for patients without TRACE staff accounts, preserving distinct Auth and VITAL identifiers. Approval creates one operational ticket; the approving TRACE Admin is the initial assignee. The case retains the effective patient creator without inventing a TRACE-local user. Rejection records an action before ticket creation. Staff updates move approval to investigation; only Admin can finalize a proposal. Patient rejection records an Auth-attributed ticket timeline action, reopens the ticket, clears completion/proposal/deadline and returns Stage 3. Ordinary ticket resolution/reopening cannot bypass the native cycle. Native automatic resolution uses VITAL timeout confirmation and commits its state and outbox together. Accounting and doctor restrictions apply to dispute/ticket lists, detail, comments, attachments and history exports. Accounting has a separate financial projection.

**Gateway:** Exact POST integration allowlists, separate directional service keys, bounded bodies/responses and fresh verified downstream service context. Caller cookies, Authorization and identity/service headers are not forwarded. Ordinary TRACE staff authentication remains unchanged. TRACE callbacks target Web, then use the existing private Web certificate and signed assertion to Services.

## Five stages

| Stage | Meaning |
|---|---|
| 1 — Dispute Sent | VITAL durably records patient confirmation and the hold; delivery may still be pending. |
| 2 — Dispute Approved or Rejected | TRACE Admin and timestamp recorded; approval assigns that Admin, rejection includes the patient-visible reason. |
| 3 — Dispute in Process | Investigation/routing; patient rejection also returns here and removes the previous countdown. |
| 4 — Completed | Admin-approved Reschedule / Invalidate / Complete proposal is recorded as available in VITAL. |
| 5 — Acknowledged | Patient accepted and TRACE confirmed. The automatic alternative is labelled Automatically Resolved. |

The original appointment completion deadline is retained through review. Opening/cancelling the modal has no appointment effect. Intake rejection resumes original checks; a passed deadline triggers maintenance checks immediately. Finalized appointments use the BGH contact process. Ratings/suggestions remain separate.

## Request contracts

All native requests have `contract_version: 1`; IDs are UUIDs and timestamps are UTC. Correlation IDs are preserved as `X-Correlation-ID`. Stable report/operation/event IDs are the idempotency identities.

| Request | Fields |
|---|---|
| Intake | `report_id`, `appointment_id`, `patient_id`, `doctor_id`, `reporter_auth_id`, `source_system: vital`, `appointment_type: telemedicine`, `submitted_at`, `subject` (3–255), `description` (5–5000), `complaint_type`, `evidence` manifest. |
| Concern values | `doctor_no_show`, `missing_paperwork`, `technical_failure`, `doctor_conduct`, `mutual_absence`, `other`. These are patient concerns, not a determination of fault. |
| Evidence manifest | Up to five `{attachment_id, title, mime_type, sha256, byte_length}` entries. PDF, PNG, JPEG, WebP; each at most 10 MiB. |
| Evidence transfer | `report_id`, `case_id`, `attachment_id`, `sha256`, `content_base64`. VITAL validates/normalizes, quarantines and scans bytes before transfer; TRACE verifies declared IDs/length/hash and stores them under the report. |
| Patient response | `operation_id`, `report_id`, `case_id`, `appointment_id`, `reporter_auth_id`, `decision_id`, `action: acknowledge|reject`, `feedback_reason` (required for rejection), `accepted_at`. |
| Reconciliation | `report_id`, `case_id`, `appointment_id`, `reporter_auth_id`; returns the latest complete patient-visible event or null before a decision. |

`patient_id` identifies the VITAL patient record. `reporter_auth_id` identifies the authenticated account that submitted it. They are not interchangeable. The patient never selects TRACE category UUIDs: Admin supplies official category/subcategory, department and priority on approval. `appeal_reference` remains a compatibility storage field populated from the native report ID; it is not a required patient input or the native deduplication key. No identity is inferred for old records.

## Gateway routes and authorization

| Caller | Method and Gateway path | Downstream owner |
|---|---|---|
| VITAL worker | `POST /trace/api/integrations/v1/vital-disputes/intake` | TRACE native case owner |
| VITAL worker | `POST /trace/api/integrations/v1/vital-disputes/evidence` | TRACE report evidence |
| VITAL worker | `POST /trace/api/integrations/v1/vital-disputes/response` | TRACE original-patient response |
| VITAL worker | `POST /trace/api/integrations/v1/vital-disputes/progress` | TRACE reconciliation |
| TRACE worker | `POST /vital/integrations/v1/trace-disputes/events` | Web adapter → private Services `/internal/v1/trace-disputes/events` |
| TRACE worker | `POST /vital/integrations/v1/trace-disputes/refund-confirmed` | Web adapter → private Services refund confirmation |
| TRACE scheduler | `POST /vital/integrations/v1/trace-disputes/timeout` | Web adapter → private Services timeout owner |

Service callers send only their directional `X-Dispute-Service-Key`. Gateway validates it against the exact route direction and injects `X-Gateway-Secret`, `X-Gateway-Dispute-Service` and the target-specific `X-Gateway-Dispute-Key`. Downstream adapters verify both trust keys and the service identity. Do not reuse patient sessions or inject staff impersonation. Web delegates as a dedicated configured service actor using its existing mTLS certificate and asymmetric request-bound assertion. The prior direct native TRACE-to-Services transport is retired. The private `POST /internal/v1/appointments/appeals/refund-confirmed` alias uses the same signed assertion and native event schema; it is not a public/shared-key bypass.

TRACE staff continue to use existing authenticated `/api/disputes/{case_id}/approve`, `/reject`, `/resolve-tag` and `/confirm-refund` routes through Gateway. New staff reads are `/api/disputes/{case_id}/actions`, `/api/disputes/{case_id}/evidence`, and Accounting `/api/disputes/financial`. The latter exposes `can_confirm_refund` after approval and confirmed resolution. Staff can record first human acknowledgment at `/api/disputes/{case_id}/acknowledge-intake`; approval/rejection also records it. The one-business-day target starts at trusted VITAL submission receipt and includes delivery and triage waiting. Native patient actions use VITAL BFF, not the legacy TRACE acknowledgment endpoint.

## Event contract and ordering

Every complete state snapshot contains `event_id`, `report_id`, `case_id`, `appointment_id`, increasing `state_version`, `correlation_id`, `occurred_at`, `stage`, `intake_status`, deciding Admin/time, rejection reason, ticket/display identifiers, `decision_id`, `supersedes_decision_id`, proposed tag/explanation, `resolution_method`, `fault_classification`, `refund_approved`, `refund_reference`, and `refund_issued_at`. Nullable fields are explicitly null.

Allowed intake states map exactly: approved/rejected → 2, in_process → 3, completed → 4, resolved/auto_resolved → 5. Resolution method is `patient_acknowledged` or `auto_resolved_72h` only at Stage 5. A correction requires a fresh decision and the active predecessor. Refund approval requires `fault_classification: doctor_fault`; `patient_fault`, `mutual_absence` and `other` cannot approve refunds. The patient concern code alone never establishes fault.

TRACE commits each change and its outbound event in the same transaction. Both workers claim expiring leases and retry the same persisted identity with bounded exponential backoff. VITAL persists an event hash and result: identical repeats recover the original result; conflicting reuse fails; stale snapshots are ignored. Incompatible decisions create an Admin follow-up and return `applied: false, reason: admin_review`. External issuance confirmation has a separate Payment delivery intent. A transport retry is not another business decision.

## Response window and timeout race

1. Admin finalizes a fresh proposal; TRACE queues it without a countdown.
2. VITAL records `resolution_available_at` under its appointment lock using server time and derives `acknowledgment_deadline_at = availability + 72 hours`. The HTTP receipt returns these stored timestamps. Duplicate delivery never extends the window.
3. TRACE stores the receipt before its scheduler can consider automatic resolution. Receipt loss retries the original event and recovers the same times.
4. VITAL durably records an original-patient response for the active decision before the deadline. It remains pending until TRACE confirms. Delayed delivery uses that trusted acceptance time.
5. TRACE requests timeout confirmation through Gateway. Under the same appointment lock VITAL checks current case/decision and any timely response. A pending timely response blocks timeout. Otherwise, after the deadline, an idempotent confirmation closes the response window.
6. TRACE rechecks its decision/version, resolves the ticket and stores its final outbound event together. Without confirmation it preserves the unresolved case and retries.

Rejecting completion clears the countdown and completion fields and returns Stage 3. Another Admin review produces a new decision and new availability window. No default system acceptance is recorded as an actual patient acknowledgment.

## Configuration and migration checklist

Keep `VITAL_TRACE_DISPUTES_ENABLED=false` in Services API, worker, Web, TRACE and Gateway until coordinated acceptance succeeds. Do not enable only Web or only Services.

| Process | Required configuration |
|---|---|
| Gateway | `GATEWAY_VITAL_DISPUTE_KEY`, `GATEWAY_TRACE_DISPUTE_KEY`, `TRACE_DISPUTE_ADAPTER_KEY`, `VITAL_DISPUTE_ADAPTER_KEY`, existing `GATEWAY_SECRET`, `TRACE_URL`, `VITAL_WEB_URL`. |
| VITAL worker | `VITAL_TRACE_GATEWAY_URL`, `GATEWAY_VITAL_DISPUTE_KEY`, `VITAL_TRACE_SERVICE_ACTOR_ID`; existing Core/Integrations ownership, Records storage and ClamAV configuration. HTTP in production is limited to explicitly permitted private Gateway origins. |
| Services API | Same `VITAL_TRACE_SERVICE_ACTOR_ID`, existing Web mTLS/assertion verification and appointment, Payment/Records owners. `VITAL_BGH_CONTACT_PHONE` and `VITAL_BGH_CONTACT_ADDRESS` are pending hospital values. |
| Web | `VITAL_DISPUTE_ADAPTER_KEY`, same service actor ID, existing Gateway secret and private BFF mTLS/assertion keys. No worker credential, database, scanner or storage secret. |
| TRACE | `GATEWAY_TRACE_DISPUTE_KEY`, `TRACE_DISPUTE_ADAPTER_KEY`, existing `API_GATEWAY_URL`, `API_GATEWAY_SECRET`, TRACE database and MinIO. |

Keys must be dedicated random secrets delivered through deployment secret management. No live keys were generated, copied or committed. Service actor ID is a dedicated process UUID, not an Admin/patient identity.

Apply Services additive Core migration `202611210002_native_dispute_reliability` after the existing dispute migration; regenerate both Prisma clients and reapply runtime DML grants. No Integrations schema change is needed for Payment's existing operations ledger. Apply TRACE `v6/migration_v6.0.21_native_dispute_reliability.sql`, registered in `MIGRATION_SCRIPTS`. Its failure now stops startup. Migration 20 referenced a nonexistent `SubCategory` table; migration 21 additively repairs the missing native fields using the actual Category hierarchy without rewriting historical SQL. Existing case history is retained; unresolved old identity/decision links stay in review. The TRACE registration audit also reports eight pre-existing historical SQL files not registered; do not apply them blindly over the unified baseline.

## Verification ledger

Cleanup before publication: at the owner’s request, the four newly added dispute test suites, embedded PostgreSQL helper and direct PGlite development dependency were removed after verification. Temporary test tooling and the added local Python packages were also removed. The results below are historical evidence from before cleanup, not retained executable coverage. Existing test suites and corrections that align them with the implementation remain. Future regression checks must restore equivalent coverage or use the paired acceptance checklist.

| Check | Result and limits |
|---|---|
| Services full existing suite | 507 passed, 6 skipped, 0 failed (513 total). |
| Services focused native regressions | 14 passed, including isolated PostgreSQL migration execution, timing/decision guards, paid replacement coordinator, and external refund idempotency. |
| Services production build and Prisma | Production build and both client generations passed; Core Prisma validation passed. Additive Core migration exercised by focused tests. |
| Web tests | 335 passed, 0 failed; includes three focused dispute/BFF contract checks. |
| Web TypeScript and BFF boundary | Passed. |
| Web production build | Webpack compiled, type-checked and generated 162 static pages, but the command exited unsuccessfully at the installed Next.js security advisory gate. Dependency remediation and a clean production build remain required. Default Turbopack also cannot use this worktree's external dependency junction. No Next.js upgrade was made in this integration change. |
| Gateway full suite | 465 passed, including five new directional trust/route tests. |
| TRACE focused regression suite | 26 passed, including eight new native tests, existing dispute/privacy tests and comment guards. |
| TRACE broader suite | 128 passed, 7 failed, 2 skipped in the recorded full run. Three failures require unavailable PostgreSQL/Redis/MinIO infrastructure. The four log-pagination/summary/cache failures were independently reproduced unchanged at baseline `fea6ae2`. Later focused tests cover the final native changes; a green full infrastructure-backed suite is still required. |
| TRACE source and additive migration | Application compilation and actual route registration passed. New migration applied successfully and reapplied safely in isolated PostgreSQL, including repair of the missing migration-20 fields. Migration registration audit reports eight pre-existing historical omissions. |
| Diff and documentation | All four repository whitespace checks passed. Proposal, execution plan, handoff and documentation indexes updated; no live environment files changed. |
| Live deployment acceptance | Not run. Docker engine was unavailable, and real directional credentials/private mTLS, scanner/storage and separately owned TRACE staff UI were not deployed. Integration remains disabled. |

The test counts refer to individual recorded runs, not a single combined production acceptance run. Services focused tests use embedded PostgreSQL; Gateway tests use isolated configuration. Neither substitutes for paired acceptance through the deployed trust chain.

## Deployment and separately owned UI dependencies

- Root Compose/generated environment wiring must supply the process-specific variables, secrets, permission grants, storage/scanner resources and actual Gateway/Web origins. No stack was deployed or flag activated here.
- TRACE Frontend is separately owned and unavailable in these authorized worktrees. Wire official category/priority approval, approving Admin assignment, pre-ticket rejection actions, native action timeline with `creator_identity_namespace: auth`, report evidence, Admin-only resolution/correction, fault finding, and Accounting's approved-only confirmation control. Preserve financial-only masking and do not use legacy patient acknowledgment endpoints.
- Hospital phone/address remain pending; configure them before patient rollout.
- Run paired isolated acceptance through the actual Gateway and private Web→Services mTLS with real test service credentials, MinIO and ClamAV. Required cases: doctor no-show at 14:59/15:00 without completion; a patient with no TRACE account; duplicate intake/evidence/response; delivery failure and lease recovery; rejection before ticket creation; missed/out-of-order updates; late proposal; timely response delivered late; timeout/response race; renewed Admin decision after rejection; Complete blocked by missing financial/clinical evidence; invalidation/refund separation; duplicate external receipt; mutual absence; paid replacement after original visit with exhausted quota, competing selections, doctor rejection/retry, and automatic-resolution Admin follow-up.
- Monitor `trace_dispute_deliveries` pending/processing/admin_review, oldest unresolved `reviewHold`, `trace_dispute_responses` pending age, open `trace_dispute_reviews`, TRACE callback pending/processing/admin_review and cases awaiting VITAL availability receipts. Investigate Accounting reconciliation conflicts rather than issuing another refund.

Source tests and embedded PostgreSQL verify code and migration behavior. They do not establish that deployed routing, secrets, TLS, scanner, storage or staff UI are ready. Enable all processes together only after recording paired acceptance evidence.
