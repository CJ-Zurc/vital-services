# VITAL-TRACE Integration: Telemedicine Dispute Resolution & Lifecycle Ledger

> **Target Services:** `vital-services`, `vital-web`  
> **TRACE Reference Commits:** `1e7b451`, `e2d005d`, `417a5f6`, `f1afdbf`, `95f032d`  
> **Status:** Active Cross-Service Integration Ledger  
> **Last Updated:** 10 November 2026  

---

## 1. Executive Summary & Architecture Overview

In physical hospital operations, patient attendance, documentation disputes, and cashier refund requests are physically mediated by clinic receptionists, nursing triage, and hospital billing officers. In Bernardino General Hospital's (BGH) digital ecosystem, **VITAL Telemedicine** handles remote video consultations, advance digital payments through PayMongo, and electronic health record generation.

To resolve dispute failure modes (doctor/patient no-shows, missing paperwork, auto-completion races, and unhandled refunds), VITAL and TRACE operate under a **Hybrid Architecture**:
- **`vital-web`**: Provides an authenticated **"Start appeal"** action on the patient appointment card, atomically freezing the auto-completion timer, issuing a single-use `appeal_reference`, and launching a pre-filled Google Form link without exposing patient PII or internal database UUIDs.
- **`vital-services`**: Manages the appointment state machine (`in_review`, `invalid`, `no_show`), holds 48-hour auto-completion, runs the 24-hour abandoned hold verification sweeper against TRACE, ingests authenticated TRACE receipts and dispositions, and handles Accounting external refund confirmations.
- **`TRACE`**: Handles employee investigation, HR physician conduct review, and Accounting refund tracking, communicating with VITAL via internal service credentials.

---

## 2. Cross-Service Contract Matrix

| Contract / Endpoint | Direction | Caller | Receiver | Auth Method | Purpose |
|---|---|---|---|---|---|
| `POST /internal/v1/appointments/appeals/receipt` | Inbound to VITAL | TRACE Backend | VITAL Services | `X-Internal-Service: trace` + `X-Internal-Service-Key` | Locks hold and records `traceCaseId` upon timely Google Form submission |
| `POST /internal/v1/appointments/appeals/disposition` | Inbound to VITAL | TRACE Backend | VITAL Services | `X-Internal-Service: trace` + `X-Internal-Service-Key` | Applies HR/Admin final disposition (`appointment_invalidated`, `appeal_dismissed`, `reschedule_agreed`) |
| `POST /internal/v1/appointments/appeals/refund-confirmed` | Inbound to VITAL | TRACE Backend | VITAL Services | `X-Internal-Service: trace` + `X-Internal-Service-Key` | Records external Accounting refund reference in financial ledger |
| `POST /internal/v1/appointments/appeals/redirect-to-admin` | Inbound to VITAL | TRACE Backend | VITAL Services | `X-Internal-Service: trace` + `X-Internal-Service-Key` | Flags patient-only or out-of-scope disputes to VITAL Admin queue |
| `GET /trace/api/patient-forms/responses/check` | Outbound from VITAL | VITAL Services | TRACE Backend | `X-Internal-Service: vital` + `X-Internal-Service-Key` | Tri-state sync check (`submitted`, `sync_pending`, `confirmed_no_response`) before releasing 24h holds |
| `GET /trace/api/patient-forms/public-qr` | Outbound from VITAL | VITAL Web BFF | TRACE Backend | Public Edge Gateway | Retrieves active Google Form base URL and prefill entry key (`entry.1045781291`) |

---

## 3. Agreed Operational SLAs & Timers

| Lifecycle Event | SLA / Threshold | System Enforcement |
|---|---|---|
| Check-in Window | Opens 10 minutes prior to scheduled start | VITAL Web / Services |
| No-Show Reporting Window | Unlocks 15 minutes post scheduled start | Doctor / Patient Dashboards |
| Technical Dropout Buffer | 10-minute reconnection grace period | Consultation Video Scaffolding |
| Doctor Documentation Mandate | Required within 24 hours of consultation end | Background Maintenance Worker |
| Patient Confirmation Window | 48 hours from doctor completion submission | Background Maintenance Worker |
| Appeal Form Submission Deadline | 24 hours from clicking "Start appeal" | VITAL Services & TRACE Sweeper |
| Advance Payment Deadline | Hard cutoff 3 hours before scheduled start | Payment Maintenance Worker |
| Human Triage Acknowledgment SLA | 1 business day (24h) from verified receipt | TRACE HR Intake Queue |

---

## 4. Phase-by-Phase Change Ledger

### Phase 1: Database Schema & Migration (Completed)
- **`prisma/core/schema.prisma`**:
  - Extended `AppointmentStatus` enum with:
    - `in_review`: Pauses auto-completion worker while dispute investigation is active.
    - `invalid`: Set when consultation is invalidated by HR disposition (awaiting external Accounting refund).
    - `no_show`: Set when patient fails to attend (zero refund; doctor compensated).
  - Added dispute tracking fields to `Appointment` model:
    - `traceTicketId` (`UUID?`): Linked TRACE employee ticket ID.
    - `traceCaseId` (`UUID?`): Linked `Patient_Dispute_Case` ID in TRACE.
    - `reviewHold` (`Boolean`, default `false`): Atomic flag freezing 48h auto-completion.
    - `appealReference` (`VarChar(64)?`, unique): Cryptographic single-use reference pre-filled into Google Form URL.
    - `appealDeadlineAt` (`Timestamptz?`): 24-hour deadline for Google Form submission.
    - `disputeReason` (`Text?`): Selected dispute reason category.
    - `disputedAt` (`Timestamptz?`): Timestamp when appeal was initiated.
    - `activeDecisionId` (`UUID?`): Tracks TRACE decision ID for supersedes conflict verification.
    - `accountingRef` (`Text?`): External bank/reconciliation reference from Accounting payout.
    - `accountingRefundIssuedAt` (`Timestamptz?`): Payout timestamp.
    - `doctorProofScreenshotUrl` (`Text?`): Sanitized video attendance screenshot URL.
    - `doctorDeliverableType` (`Text?`): Deliverable issued (`prescription`, `medical_certificate`, `consultation_summary`).
    - `doctorDeliverableRef` (`Text?`): Record/snapshot ID of delivered paperwork.
  - Added indices on `appealReference`, `reviewHold`, and `traceCaseId`.
- **`prisma/core/migrations/202611100001_patient_dispute_resolution/migration.sql`**:
  - Incremental SQL migration deploying enum updates and column additions.

### Phase 2: Core State Machine & 48h Lifecycle Alignment (Completed)
- **`src/eda/modules/appointment/appointment-contracts.ts`**:
  - Updated `effectiveCompletionDeadline` default calculation from 24h to **48 hours** (`+172_800_000` ms) from doctor completion submission.
  - Extended `AppointmentRow` TypeScript interface with dispute fields (`reviewHold`, `appealReference`, `appealDeadlineAt`, `traceTicketId`, `traceCaseId`, `disputeReason`, `disputedAt`, `activeDecisionId`, `accountingRef`, etc.).
- **`src/eda/modules/appointment/appointment.ts`**:
  - Updated doctor completion confirmation logic in `complete()` to set 48h deadline (`now + 172_800_000`).
  - Implemented `startAppeal(actor, id, meta, body)`:
    - Restricts to patient role and verifies appointment ownership and eligibility (`status === 'confirmed'` and `doctorConfirmedAt != null` and within 48h window).
    - Prevents duplicate appeals when `reviewHold = true` or `status === 'in_review'`.
    - Atomically flags `reviewHold = true`, transitions `status = 'in_review'`, generates single-use `appealReference` (`app-ref-[hex]`), and calculates 24-hour `appealDeadlineAt`.
    - Appends state log `appeal_started` and emits `vital.appointment.appeal_started` and `vital.audit.requested` outbox events.
- **`src/eda/http/appointment-router.ts`**:
  - Mounted `POST /internal/v1/appointments/:id/appeal` mapped to `runtime.module.startAppeal`.
- **`src/eda/modules/appointment/appointment-maintenance.ts`**:
  - Guarded candidate selector and processing loop against active review holds (`a."reviewHold" = false AND a.status <> 'in_review'`), freezing the 48-hour auto-completion clock while disputes are active.
  - Implemented 3-hour advance payment deadline cutoff: bookings remaining unpaid 3 hours before `scheduledAt` automatically cancel with `cancellationReason = 'payment_deadline_expired'`, freeing the schedule slot.
- **`src/eda/modules/appointment/appointment-reads.ts`**:
  - Projected dispute fields (`reviewHold`, `appealReference`, `appealDeadlineAt`, `traceCaseId`, `disputedAt`, `disputeReason`, `accountingRef`, `accountingRefundIssuedAt`) in read and list responses.

### Phase 3: TRACE Integration Endpoints & Tri-State Sync Client (Completed)
- **`src/eda/http/internal-service-auth.ts`**:
  - Implemented `createInternalServiceAuth("trace")` middleware validating `X-Internal-Service: trace` and constant-time match with `VITAL_INTERNAL_SERVICE_KEY` while preserving `X-Correlation-ID`.
- **`src/eda/http/appointment-appeals-router.ts`**:
  - Implemented `POST /internal/v1/appointments/appeals/receipt`:
    - Ingests `{ appeal_reference, case_id, form_id, response_id, submitted_at }`.
    - Locks hold, associates `traceCaseId = case_id`, validates timely submission before 24h deadline, and emits `vital.appointment.appeal_receipt_locked`.
  - Implemented `POST /internal/v1/appointments/appeals/disposition`:
    - Ingests `{ event_id, case_id, appeal_reference, appointment_id, decision_id, supersedes_decision_id, disposition, decided_by_role, decided_at }`.
    - Validates decision amendment against `activeDecisionId`; conflicts route to VITAL Admin (`recordsBlockCode = 'DISPUTE_DECISION_CONFLICT'`).
    - Applies `appointment_invalidated` (`status = 'invalid'`, `reviewHold = false`), `appeal_dismissed` (clears hold and resumes completion countdown), or `reschedule_agreed`.
  - Implemented `POST /internal/v1/appointments/appeals/refund-confirmed`:
    - Ingests `{ event_id, case_id, appeal_reference, appointment_id, reconciliation_reference, issuance_date, refund_amount }`.
    - Idempotently updates financial ledger and payment projection status to `refunded`.
  - Implemented `POST /internal/v1/appointments/appeals/redirect-to-admin`:
    - Routes patient-only non-attendance or out-of-scope complaints to VITAL Admin queue (`recordsBlockCode = 'REDIRECTED_VITAL_ADMIN'`).
- **`src/eda/http/app.ts` & `src/eda/entrypoints/api.ts`**:
  - Mounted `/internal/v1/appointments/appeals` with `internalServiceAuth` before general peer delegation.
  - Injected `corePool` from API launcher databases.
- **`src/eda/modules/appointment/appointment-maintenance.ts`**:
  - Implemented `checkTraceAppealStatus` helper calling TRACE `GET /trace/api/patient-forms/responses/check?appeal_reference={ref}`.
  - Implemented 24-hour abandoned hold sweeper verifying submission presence before releasing holds (`submitted`, `sync_pending`, `confirmed_no_response`).
- **`.env.vital_eda_api.example`**:
  - Documented `VITAL_INTERNAL_SERVICE_KEY`, `TRACE_BASE_URL`, and `TRACE_INTERNAL_SERVICE_KEY`.

### Phase 4: BFF Route Handlers in `vital-web` (Completed)
- **`app/api/patient/appointments/[appointmentId]/appeal/route.ts`**:
  - Implemented `POST /api/patient/appointments/:id/appeal`:
    - Validates patient session via `requireBffSession(req)`.
    - Dispatches authenticated mTLS command to `vital-services` `POST /internal/v1/appointments/:id/appeal`.
    - Dynamically generates single-use prefilled Google Form URL (`entry.1045781291=<appealReference>`) using `TRACE_PATIENT_DISPUTE_FORM_URL`.
    - Returns `{ id, appealReference, appealDeadlineAt, formUrl }`.
- **`app/api/patient/appointments/[appointmentId]/appeal-status/route.ts`**:
  - Implemented `GET /api/patient/appointments/:id/appeal-status`:
    - Reads dispute tracking state (`reviewHold`, `appealReference`, `appealDeadlineAt`, `traceCaseId`, `accountingRef`, `accountingRefundIssuedAt`).
- **`app/api/doctor/appointments/[appointmentId]/report-no-show/route.ts`**:
  - Implemented `POST /api/doctor/appointments/:id/report-no-show`:
    - Restricts to attending doctor role.
    - Enforces 15-minute gate (`now >= scheduledAt + 15m`). Returns 400 `NO_SHOW_TOO_EARLY` if called prematurely.
    - Records patient no-show report and optional private replacement slot offer.
- **`lib/eda/appointment-paths.ts`**:
  - Registered `appeal` and `report-no-show` actions in `appointmentDelegation` matrix.

### Phase 5: Patient Appeal UI & Dialogs in `vital-web` (Completed)
- **`components/ui/PatientAppealModal.tsx`**:
  - Implemented patient dispute initiation and progress dialog conforming to BGH One UI standard.
  - Explains the dispute process, pauses auto-completion notice, displays single-use `appealReference` with copy-to-clipboard button, and provides 24-hour countdown timer.
  - Features prominent primary button launching the pre-filled Google Form link (`entry.1045781291=<ref>`) in a new tab.
- **`components/ui/DisputeStatusBanner.tsx`**:
  - Implemented multi-state contextual alert banner rendering on appointment cards:
    - `reviewHold` without `traceCaseId`: Warning alert indicating pending form submission with deadline countdown and reopen button.
    - `reviewHold` with `traceCaseId`: Informational alert indicating HR / Medical Affairs investigation in progress (1 business day target SLA).
    - `status === 'invalid'` with `accountingRef`: Success alert displaying reconciled refund reference.
    - `status === 'invalid'` without `accountingRef`: Secondary alert indicating consultation voided, awaiting Accounting payout.
    - `status === 'no_show'`: Neutral alert indicating unexcused absence with zero refund under policy.
- **`components/ui/AppointmentCard.tsx` & `app/(patient)/patient/dashboard/appointments/page.tsx`**:
  - Added status color styling and labels for `in_review` (`bg-status-warning/15 text-status-warning`), `invalid` (`bg-brand-secondary/10 text-brand-secondary`), and `no_show` (`bg-gray-light/50 text-gray-mid`).
  - Added "Start Appeal" button alongside "Confirm Done" during the 48-hour completion window.
  - Mounted `DisputeStatusBanner` and `PatientAppealModal` on appointment detail view.

### Phase 6: Doctor & Admin Dispute Management in `vital-web` (Completed)
- **`components/ui/DoctorNoShowModal.tsx`**:
  - Implemented doctor dialog to declare patient absence after the mandatory 15-minute grace period (`now >= scheduledAt + 15m`).
  - Provides option to submit absence as an unexcused absence (voiding consultation fee per policy) or offer a private reschedule slot (>24h in the future).
- **`app/(doctor)/doctor/dashboard/appointments/DoctorAppointmentsView.tsx`**:
  - Added "Report Patient No-Show" button visible when status is `confirmed`, the 15-minute wait threshold has passed, and consultation is not marked done.
  - Mounted `DoctorNoShowModal` in both list and detail views.
- **`components/ui/StatusBars.tsx` & `app/(admin)/admin/dashboard/page.tsx`**:
  - Registered `in_review` (In Review / Dispute Hold), `invalid` (Invalid Dispute), and `no_show` (No-Show) status styles with designated brand colors in operations `StatusBars`.
  - Ensures administrative dashboard accurately aggregates active dispute holds and resolved outcomes.

### Phase 7: Verification, Test Suite & Documentation (Completed)
- **`vital-services/test/eda-dispute-resolution.test.ts`**:
  - Validates `startAppeal` hold creation, single-use `appealReference` formatting, and 24h deadline calculation.
  - Validates duplicate appeal rejection (409 `APPEAL_ALREADY_ACTIVE`) and caller authorization check (403 Forbidden).
  - Validates appointment maintenance freezing completion candidate query while `reviewHold` is active.
  - Validates TRACE response status discrimination across `submitted`, `sync_pending`, and `confirmed_no_response`.
  - Validates `/receipt` updates and hold locking.
- **`vital-web/tests/patient-appeal-bff.test.ts`**:
  - Validates registration of `appeal` and `report-no-show` routes and role access in `appointmentDelegation`.
  - Validates Google Form URL construction with `entry.1045781291=<ref>` query parameter without leaking patient PII or internal IDs.
  - Validates extended 48-hour completion deadline in `newCompletionDeadline`.
  - Validates doctor 15-minute wait gate (`NO_SHOW_TOO_EARLY`).
- **`vital-web/lib/appointment-lifecycle.ts` & `vital-web/tests/appointment-lifecycle.test.ts`**:
  - Synchronized `COMPLETION_WINDOW_MS` to 48 hours (`48 * HOUR_MS`).
- **`docs/backlogs/UHSE_Automated_Unit_Tests.md`**:
  - Formally registered all 10 new automated unit tests under `VITAL-EDA-F1`.
