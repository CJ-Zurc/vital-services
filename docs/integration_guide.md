# VITAL integration contracts

- Browser business/auth calls enter Web BFF or Gateway. User session/RBAC checks
  use Gateway; active UHSE integration routes remain `/vital/integrations/v1/*`
  and reviewed `/vital/bff/*` routes. Unknown generic paths are rejected.
- Web/API transport uses mTLS and signed assertions bound to actor, method, path,
  request hash, resource and correlation ID. Plain `X-User-*` headers do not grant
  API access.
- Auth owns identities, login/refresh/OTP and system access. Backend profile and
  stale-control requests call protected Auth internal contracts directly with
  distinct directional keys. No VITAL process connects to Auth's database.
- EHR owns hospital patient IDs/MRNs, clinical persistence, signed Records
  evidence and doctor mirrors. TRACE owns department UUIDs and names.
- Baseline seed commands exchange a credential-free manifest containing resolved
  owner IDs. EHR patient IDs, Auth IDs and VITAL user IDs are not interchangeable.
- API mutations write Core outbox events. Worker delivery uses durable RabbitMQ,
  inbox protection and receipt-aware Audit/Notification clients. Notification
  email/SMS providers remain disabled in staging.
- Auth-facing VITAL roles are served by Web delegating to Core ownership.
  Analytics reads only the authenticated submitted-preconsultation export.
- Gateway diagnostics calls Web's protected `/api/internal/vital/readiness`;
  Web checks API `/internal/readiness` over mTLS without impersonating a user.

## Capstone document contract release

Doctor honorific has been removed from Profile, appointment and portal doctor DTOs. Deploy the paired Web schema after Core/Integrations migrations. New self-scoped signature and patient/admin acknowledgment routes, snapshot versions and QR retrieval are detailed in [Capstone documents](capstone-documents.md). EHR evidence endpoints are unchanged; no EHR-owned tables are modified.


## S6-005 patient monitoring and S6-009 messaging

Patient Monitoring is `/admin/dashboard/patients`, backed by read-only admin
`GET /api/admin/patients`. Auth owns identity, verification and VITAL access;
Core owns role membership and onboarding. The BFF checks current Core admin
membership before Auth directory reads, combines search/status filters with the
patient membership set before pagination, and enriches only the displayed page.
Core `GET /internal/v1/profile/admin/patients?authIds=<comma-separated UUIDs>`
requires self-bound `profile.admin.read`, current admin membership and 1-100
UUIDs. Its strict response contains only `authId` and `isOnboardingComplete`.
The browser projection excludes clinical data, signatures, secrets and global
administrative privileges. Account mutations remain in User Management;
patient/doctor links initialize its role and email search. Doctor identity
lookup consumes every role-filtered directory page rather than the first 100.

Messaging uses scheduled intervals in Core: ordinary appointments open at
approval and close at scheduled end +24 hours. Accepted follow-ups (including
accepted reschedule replacements of follow-ups) open at start -24 hours and
close at end +24 hours. Completed same-patient/same-doctor linked conversations
reopen only within qualifying follow-up windows; overlaps merge, gaps remain
closed. Cancellation immediately closes that conversation and removes its
window; superseded rescheduled conversations remain read-only. Missing or
invalid schedule ends deny new sends. Schedule-slot ends take precedence over
stored proposed ends, including Philippine overnight slots. Completion time
does not move the deadline. Opening is inclusive; closing is exclusive.

History/conversation DTOs now require `nextOpenAt` and `availabilityReason`
(`open`, `before_follow_up`, `window_closed`, `cancelled`, `rescheduled`,
`schedule_unavailable`, `processing`, `purged`). `sendUntil` is the current
continuous open window's end. Deploy compatible Web and Services together.
Web displays Philippine time, refreshes at boundaries/focus/visibility and polls
at 30-second intervals, while Core rechecks every new send under lifecycle
locks. Clock-skew retries are bounded. Previously committed same-ID retries
return their original message; sending never grants history to another actor.
Stream read authorization remains independent of send-window availability.
Closing does not delete messages or change retention/legal-hold behavior.
No database migration, data reset or additional environment variable is needed.


## S6-011–S6-014 contracts

See [appointment revisions](eda/sprint6-appointment-revisions.md) for the coordinated Core/Web/Gateway/Notification routes. Deploy compatible sources together. Core owns migration `202610210001_s6_appointment_revisions`; EHR schemas remain unchanged. Notification delivery is durable metadata-only in-app intent with recipient-scoped VITAL reads; no producer URLs or clinical text are accepted.
