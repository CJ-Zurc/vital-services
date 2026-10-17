# SSE Ownership

This is default-off implementation, not runtime or ingress acceptance.
`VITAL_EDA_SSE_ENABLED=false` is the default in both backend and Web. Enabling
backend SSE requires actual Appointment and Messaging owners.

| Browser GET | Internal GET | Scope / actor |
| --- | --- | --- |
| `/api/doctor/appointment-requests/stream` | `/internal/v1/appointments/requests/stream` | `appointments.requests.read`, doctor, own Auth UUID |
| `/api/appointments/{id}/messages/stream` | `/internal/v1/messaging/appointments/{id}/messages/stream` | `messaging.stream`, owning patient/doctor, appointment UUID |

No query parameters or browser identity overrides are accepted. Existing event
names remain: `requests` with the composed requests list, and content-free chat
`ready`, `message`, `read`, `eligibility`, `heartbeat`. Reconnect fetches history;
notifications do not claim durable replay. Approval/lifecycle rules are unchanged.

The API shares one bounded Core LISTEN connection, not one per client. Committed
outbox writes signal content-free Appointment invalidations; Messaging already
signals committed message/read changes. Listener gaps close subscribers so they
reconnect through fresh authorization and recover authoritative HTTP state.

Every stream verifies mTLS and exact actor action/resource/hash. Current Core
membership and ownership are checked before first data and every invalidation or
ten-second heartbeat. Streams close before assertion expiry (BFF issues at most
30 seconds; backend hard maximum 55 seconds). Clock tolerance cannot extend an
open stream. At most two streams per actor/kind and 200 per API are admitted;
backpressure/oversize frames close rather than accumulate an unbounded queue.
These process-local limits complement, not replace, edge/global admission policy.

Web forwards bounded HTTPS streams, repeated session cookies and refreshed-token
headers without a database listener. It never publishes browser messages through
RabbitMQ. Server-only runtime capabilities enable the existing Live indicator
only when both Messaging and SSE are configured. Polling remains fallback.

Actual ingress flush, revocation, certificate rotation, multi-replica fan-out,
slow readers and recovery require disposable CI runtime acceptance. Local Docker
is unavailable by user constraint. Shared staging, provider actions and retention
deletion remain unauthorized. Fixtures are not end-to-end evidence.

Local checkpoint evidence (2026-10-15): seven focused SSE/health cases and five
Web streaming/composition cases passed; strict focused TypeScript, source builds
and full regressions passed. The backend overall suite has 341 passes/two skips;
Web has 300 passes/two skips. These counts are not real ingress acceptance.
