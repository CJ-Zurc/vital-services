# Completion Reads And Profile Assets Checkpoint

Updated 2026-10-16. Disabled by default; not staging acceptance. Canonical env
guide: `Capstone_BGH/docs/deployment/vital-eda-environment-handoff.md`.
No UI/layout change, provider operation, migration application or deployment.

## Complete Aggregates And Consent Pages

Patient dashboard counts cover the complete owning Appointment/Payment/Records
sets, not the ordinary 500-item snapshot limit. Only four upcoming cards are
hydrated. Core and financial association/version fingerprints and current Core
membership are checked again after composition; unavailable owners fail closed.
Admin financial sums use exact PostgreSQL centavos before the final legacy
numeric DTO conversion. Runtime supplies real Payment/Video readers and current
Core membership to the financial owner, never synthetic authorization.

Private consent GET accepts `patientId`, `limit` (at most 200) and an opaque
keyset cursor. Each page rechecks admin membership. Web exhausts these pages,
verifies total/identity/cursor progress and retains the existing browser array.
The cursor binds its filter and upper bound. This replaces the earlier overflow
gate, not pagination in the UI.

Doctor dashboard aggregates also cover its whole history. The existing five
today/five pending cards are hydrated separately through current Payment/Video
owners. Slot-date precedence and Philippine dates are preserved. Source
fingerprints and current membership fence composition; Web preserves the
existing summary and card DTOs. Ordinary historical list limits remain separate
composition work.

## Route Manifest

All private routes require mTLS, fresh audience/action/resource/hash-bound actor
assertions and current Core membership. Signed command IDs authorize mutations;
browser adapters preserve cookies/refresh headers and decode versioned DTOs.

| Browser method/path | Private owner route | Authority / dependency | Response |
| --- | --- | --- | --- |
| GET `/api/patient/dashboard` | GET `/internal/v1/completion/patient/dashboard` | Own patient; Appointment/Records/Payment/Video + central notification snapshot | Existing summary/upcoming/status/notification fields; missing owners fail closed. |
| GET `/api/admin/dashboard` | GET `/internal/v1/completion/admin/dashboard` | Core admin; Profile counts, Appointment counts, Payment totals | Existing summary/count fields; no cross-database joins. |
| GET `/api/doctor/dashboard` | GET `/internal/v1/appointments/dashboard` | Current Core doctor; Appointment totals and real Payment/Video card owners | Complete summary/counts, bounded today/pending cards, existing browser DTO. |
| GET `/api/auth/consent`, `/api/admin/consent` | GET `/internal/v1/completion/consents` | Core admin; optional patient filter, bounded keyset pages | Complete legacy registration-row array through verified page composition. |
| POST `/api/auth/consent` | POST `/internal/v1/completion/consents` | Own patient, same origin, strict accepted=true, Profile writes | 201, consent DTO; atomic command replay/effects. |
| GET `/api/internal/analytics/v1/pre-consultations` | GET `/internal/v1/completion/analytics/pre-consultations` | Existing Analytics key; fixed readonly service principal | Submitted complaints, cursor/watermark; no drafts/identity. |
| GET/POST `/api/doctor/payment-qr` | GET/POST `/internal/v1/profile/doctor/payment-qr` | Own doctor; QR/Profile writes, scoped storage/scanner | Ready QR fields; internal pending=202, browser pending=503 + Retry-After. |
| PATCH `/api/doctor/payment-qr/{id}` | PATCH `/internal/v1/profile/doctor/payment-qr/{id}` | Owning doctor, signed idempotent command | Existing activation DTO. |
| GET `/api/doctor/payment-qr/operations/{id}` | GET `/internal/v1/profile/doctor/payment-qr/operations/{id}` | Owning doctor | Pending/completed/rejected; no object keys. |
| GET `/api/doctor/payment-qr/{id}/file` | GET `/internal/v1/profile/doctor/payment-qr/{id}/file` | Owning doctor, ready asset | Bounded checksum-verified bytes; no-store/no-referrer/nosniff. |

Private responses use contractVersion 1. QR scopes are `profile.qr.read/write`
bound to the doctor's Auth UUID. Completion scopes are exact and caller-bound.
Export alone uses a dedicated service principal, never admin impersonation.
Flags `VITAL_EDA_COMPLETION_ENABLED` and `VITAL_EDA_PROFILE_QR_ENABLED` remain false.

## Durable Effects

Consent serializes on the Profile user row, rechecks membership before replay,
binds command action/resource/hash and commits consent, command result, Profile
revision, one source fact, one audit intent and Auth-stale intent together.
Existing consent under a different command preserves the legacy 409.

QR remains Profile-owned, not clinical data. The existing worker claims bounded
durable jobs, scans original and normalized bytes, verifies the published object
and commits the ready row/command/Profile effects together. PNG/JPEG/WebP only,
one file, 5 MiB bytes, bounded multipart. Missing/stale scanner never means clean.
Separate storage credentials are limited to QR quarantine/final prefixes. Lease
ownership and current doctor membership are rechecked before publication.

## Notification Contract

Web uses Gateway `/notifications/api/v1/notifications/vital/snapshot`, forwarding
to the receiver's `/api/v1/notifications/vital/snapshot`. Trusted Gateway identity
selects the current recipient's persisted VITAL receipts/in-app rows, newest five
with ID tiebreaker. No Redis, generic inbox or unrelated ingress rows. Missing
template provenance fails closed. New Notification revision `c031d5e6f7a8` follows
`b920c4d5e6f7`; no migration is applied. Naive Manila timestamps are explicitly
converted to offset timestamps. Web supplies the independently resolved local
patient ID and maps owned templates to existing notification categories. Inbox
persistence is not email/SMS, socket receipt or user acknowledgement.

## Remaining Gates

- Ordinary historical lists/discovery still have overflow gates; their complete
  parity is not proved by complete dashboard aggregates.
- Staff/portal Appointment/Payment/Video composition and foreign-admin doctor
  provisioning remain gated. Real patient bootstrap/history, notice dismissal,
  feedback and paged OPQRST contracts now exist; see `remaining-owners.md` and
  `portal-integrations.md` for boundaries.
- Web Prisma/legacy implementations remain for real callers. Target mode never
  substitutes legacy writes or synthetic owner acknowledgements.
- Real PostgreSQL/RabbitMQ/MinIO/scanner/mTLS/Gateway and Node 22/Linux evidence
  remains pending. Fixture tests do not establish release acceptance.

Tests: backend `eda-completion`/`eda-profile-qr`, Web `eda-completion-qr`, central
Notification `test_vital_ingest` and Gateway `test_vital_bff`, in the root catalog.
