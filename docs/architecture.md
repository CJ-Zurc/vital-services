# VITAL architecture

Browser routes terminate in Web/BFF. Gateway owns login, refresh/session claims,
system access and browser-facing integration routing. Web calls the modular API
over private mTLS with short-lived signed actor/request assertions. Browser code
never calls Docker service origins directly.

Core owns profiles, appointments, clinical document workflows, encrypted messages
and operational relationships. Integrations owns provider operations, durable
delivery/receipts and integration projections. Each uses separate runtime roles.
Transactions append outbox events; RabbitMQ and the shared worker deliver them
with inbox/idempotency protection. Privileged migration/provision/seed tools are
separate from runtime processes.

Auth owns identities/credentials. EHR owns hospital patients, MRNs and clinical
case persistence. TRACE owns department UUIDs. VITAL links owner-issued IDs and
never opens another owner's database. Audit and Notification accept their scoped
delivery contracts. Analytics reads only the documented operational exports.

Object storage has separate Records/profile principals. Files are scanned and
encrypted as required; browser links use the public Gateway media route. API,
worker and Web have process-specific configuration and bounded resource limits.


Sprint 6 patient administration adds a separate read-only patient-monitoring
view and bounded admin summary route. Messaging now follows scheduled 24-hour
appointment/follow-up windows with retained read-only history. See
[integration contracts](integration_guide.md#s6-005-patient-monitoring-and-s6-009-messaging)
for routes, ownership, response fields and boundary behavior.


## S6 local workflow routing

VITAL browser -> same-origin VITAL Web BFF -> private VITAL Services is the
operational path. Gateway connects the BFF to Auth/SSO, EHR, central Notifications
and other owners. Signatures, prescription/QR retrieval, acknowledgments, patient
monitoring, ratings, complaint correction, calendar review/save and the bell's
local API need no new Gateway BFF routes. The shared notification service keeps
its Gateway routes and recipient isolation. All Gateway browser compatibility routes are retired;
no migration or domain-policy change is introduced by this routing revision.

## VITAL intelligence prototype

[Intelligent intake and analytics](intelligence.md) documents the new Core-owned AI tables, private Python/Node job runtimes, scoped APIs, encryption keys, independent AI feature flags and root Compose overlay. Appointment privacy and access-code controls remain enforced when AI is disabled; specialty recommendations are retired. No legacy analytics data is imported.


## Operator observability revision (2026-10-28)

The private API emits api_request metadata at response headers without consuming bodies. Only route templates, method/status, header latency and verified actor correlation enter observations. The worker emits delivery_snapshot counts/ages every thirty seconds for Audit and Notifications; snapshot failure never changes delivery behavior.


See [portal consistency and clinical review](portal-consistency.md) for appointment review, name masking, batch slots and the merged dashboard.


See [portal consistency v2](portal-consistency-v2.md) for anonymous patient ratings and the screenshot-aligned portal changes.


Manual Google Meet links replace the retired connection/generation feature. See [manual meeting workflow](manual-meet-links.md).


See [dashboard and doctor discovery redesign](dashboard-redesign.md) for chart scopes, monthly highlights, privacy and paired reporting contracts.

## Native TRACE disputes

See [the implemented contract and rollout ledger](integrations/trace/patient-feedback/VITAL_TRACE_Implementation_Changes_and_Verification.md). All native cross-system delivery uses Gateway; callbacks enter after JSON parsing and the existing Web mTLS/signed assertion boundary. `VITAL_TRACE_DISPUTES_ENABLED` defaults off. Complete resumes original payment/clinical checks; refund issuance is separate.


See [doctor profiles, criterion ratings and directory pagination](doctor-profiles-ratings-pagination.md) for updated forms, rating eligibility, the trusted search projection, worker configuration and paired rollout.


See [EHR lifecycle integration](ehr-lifecycle-integration.md) for the new scoped routes, Core migration, worker delivery/recovery, signing/key configuration and paired rollout.
\n\nSee [capstone dashboard and portal refinements](capstone-dashboard-experience.md) for interval-aware reporting, Dashboard tabs, code replacement, loading states, and verification limits.\n