# Revised EDA Contracts

The machine inventory is `route-baseline.json`; unreviewed entries are explicit
release blockers. It covers exported function handlers, variable handlers and
named re-exports. Source regex hints cannot establish route authentication or
indirect database ownership. Complete the reviewed caller/auth/owner/DTO/cookie/
body/timeout columns before replacing the route. Do not infer callback exceptions
from a broad path prefix.

## Domain API

Backend routes use `/internal/v1/*`, never the public browser API namespace.
API TLS authenticates the client certificate, then actor assertions bind exact
method/path/body, issuer/audience/key, process name, Auth subject, scopes and
resource. UUID command ID is signed in `jti`. A command replay with a different
hash/resource is 409. All scoped domain reads/writes still enforce business
eligibility; a valid signature does not confer patient access.

Profile foundation routes: GET `/profile/me`, POST `/profile/materialize`, GET
`/profile/roles/{authId}`, GET/PATCH `/profile/patient/me`, GET/PATCH
`/profile/doctor/me`, all relative to `/internal/v1`. Profile service role lookup
requires `profile.roles.read` and the exact target Auth UUID. Other Profile
routes require exact own Auth UUID resource and named scopes. Onboarding and
specialty updates require trusted EHR/TRACE preparation receipts and remain
unavailable until their contracts are implemented.

Web keeps browser `/api/*`, Auth callbacks/SSO, `/vital/integrations/v1/*`,
file responses and directional Analytics exports through tested adapters.
Same-origin ingress must route reviewed browser APIs through Gateway's new
`/vital/bff/api/*` mapping. Static UI delivery does not authorize direct BFF API
or server-action bypass. The Gateway patch alone does not enforce Web origin
protection; both must pass negative tests before activation.

## Committed Facts

The initial version-one catalog is executable in `src/eda/contracts/events.ts`.
The stable envelope contains eventId/type/version/producer/time, aggregate ID
and version, correlation/causation IDs and strict content-minimal data.

| Fact | Owner | Initial receiving handler |
| --- | --- | --- |
| profile.changed | Profile | Profile projection/delivery foundation |
| payment.completed / payment.changed | Payment | Appointment payment projection |
| appointment.approved/confirmed/rescheduled/cancelled/completed | Appointment | Lifecycle handlers still pending |
| messaging.changed | Messaging | UI eligibility/fan-out work still pending |
| video.changed | Video | Participant workflow still pending |
| audit.requested | Source module | Integrations central audit delivery |
| notification.requested | Appointment | Integrations central in-app delivery |

Only source owners emit their facts. Projection handlers do not republish the
same facts; derived effects use their own type/aggregate/version and causation
ID. Payment facts must bind data paymentId/version to the envelope. Consumer
inbox is keyed by logical consumer + stable eventId. Business keys, source
versions and legal transitions provide additional guards across distinct events.
No clinical text, bodies, URLs, credentials or user tokens are in events.

Module topic exchanges are `vital.{module}.events`. Each registered logical
consumer has its own durable bounded queue. Publishing any catalog fact with
no installed routing is rejected and its outbox row remains retryable/blocked;
do not enable producers before their full intended routing/handlers are ready.
DLQ replay requires explicit owner review, unchanged stable event ID, current
source/eligibility checks and an operator procedure; no replay command exists
yet. Never make a DLQ replay automatically repeat an unknown provider action.

Delayed queues dead-letter through `vital.resume`, not the default exchange;
each logical queue is bound by its consumer ID. Runtime credentials cannot
write this resume exchange or provision topology. Provisioner permissions cover
only the VITAL namespace. This avoids granting default-exchange access just for
retry declaration. Invalid-event diagnostics retain a validated event ID from
the safe transport header when available, not a potentially sensitive body.

## Outbox And Inbox

Core transaction: domain mutation + source outbox. Worker claims recoverable
leases and publishes persistent/mandatory messages. Only a successful publisher
confirm with no return permits published marking. Confirm uncertainty retains
the row, so duplicates are expected. Consumer commits its inbox plus local
effects before ACK. Retry transfer is itself mandatory/confirmed before ACK.
Invalid payloads are quarantined as content-free diagnostics, not copied with
potential patient data into another queue.

There is no atomic Core/Integrations/provider transaction. Reschedule requires
prepare/reserve, Core pivot, participant finalization; compensation applies
before pivot and forward recovery after it. That saga is not implemented by
merely declaring its database tables.

## Central Delivery

Audit POST `/ingest/business` uses scoped VITAL key and stable event_id, system
vital, minimal snake_case metadata. Notification POST
`/internal/v1/vital/notifications` uses the dedicated service key and strict
requestId/recipient/template/appointment/source/version parameters. First
templates are `appointment.cancelled` and `appointment.follow_up`, with only
optional scheduledAt; cancellation reasons stay out of delivery/event payloads.
Accept only persisted 202 receipts; retries retain request ID and request hash.
No new email/SMS or legacy broker/socket path is enabled.

## Release Dependencies

Gateway namespace/streaming and Web trust adapters must ship together. Profile
must preserve Auth role and stale/mirror contracts before Web session reads move.
Payment/Video must preserve appointment approval/reschedule semantics before
their state split activates. Central services must demonstrate unique indices
and atomic ingestion. EHR recovery is read-only and cannot create cases after
an interactive session expires. Auth UUIDs/EHR references survive any scoped
VITAL fixture reset. Analytics export parity remains mandatory; NLP is deferred.
