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
