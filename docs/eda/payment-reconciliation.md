# Payment Ownership And Reconciliation Checkpoint

Updated: 2026-10-13. Implemented code checkpoint; not release acceptance.

Architecture authority remains the revised EDA plan. Payment owns the Integrations
ledger, provider operations, reconciliation and invoice metadata. Appointment owns
Core billing authorization, frozen quotes, lifecycle and association identity.
Cross-database identifiers are scalar; no distributed transaction is claimed.

## Gates And Ownership

`VITAL_EDA_ENABLED`, `VITAL_EDA_PAYMENT_ENABLED` and
`VITAL_EDA_PAYMENT_RECONCILE_ENABLED` remain off by default. Web uses the
master and Payment gate; the worker requires all applicable backend gates.
`PAYMONGO_SECRET_KEY` must be a sandbox key and `VITAL_PAYMENT_APP_ORIGIN` is
configured server-side. Production requires HTTPS. The v1 provider API is retained.
No webhook, new email/SMS, deployment, provider action or database reset is enabled.

There is no writer bridge from legacy Web appointments to target Payment. Only
target Core appointments authorize target checkout. Existing approval, cancellation,
follow-up, completion, rescheduling, mixed queries and exports retain legacy
ownership while flags are off and remain blocked where unmigrated in target mode.
Do not enable this partial implementation for general traffic.

## API And Delegation

All paths below are relative to `/internal/v1/payments`. Process mTLS and a
short-lived signed actor assertion bind method/path/body, audience, resource and
command UUID. Domain checks independently verify current ownership/membership.

| Method/path | Scope | Resource | Body |
| --- | --- | --- | --- |
| GET `/appointments/{id}` | `payments.read` | Appointment UUID | None |
| POST `/appointments/{id}/checkout` | `payments.checkout` | Appointment UUID | Empty object |
| POST `/appointments/{id}/reconcile` | `payments.reconcile` | Appointment UUID | Empty object |
| GET `/admin/reviews` | `payments.review.read` | Admin Auth UUID | None |
| GET `/admin/reviews/{id}` | `payments.review.read` | Payment UUID | None |
| POST `/admin/reviews/{id}/receipt` | `payments.review.write` | Payment UUID | kind, providerId, expectedVersion |
| POST `/admin/reviews/{id}/refund` | `payments.review.write` | Payment UUID | expectedVersion |

Patient APIs reject amounts, eligibility and provider IDs from the browser. Admin
review APIs are internal only; no public review route or screen is introduced.
Lists are bounded to 100 cases. Review rechecks Core admin membership, including
replay. A receipt is retrieved and checked server-side; review cannot force paid,
erase unresolved writes or repeat an unknown refund.
Exhausted reads of an already-known receipt can recover through reviewed,
server-verified receipt linking without a new provider write. That recovery
resets retrieval backoff, but retains review if any other write remains unknown.

The v1 success envelope contains `success`, `contractVersion` and
`data: {payment, operationStatus, operationId?}`. Pending/unknown command outcomes
use HTTP 202, resolved outcomes HTTP 200. Financial payment status is separate
from provider-operation status. Web validates this DTO and preserves session
headers/cookies. Browser POST/PATCH payment paths remain compatible; target
mutations require a UUID `Idempotency-Key`. See the Web route manifest for details.

## Preparation And Recovery

Appointment preparation locks current ownership/association, checks lifecycle and
open transitions, and freezes fee/currency/consultation type in Core once per
billing lineage. Decimal strings become integer centavos without float rounding.
Later doctor fee changes do not modify the quote. Core intent renewal requires
fresh authorization and the same actor/command/hash/source revisions.

Integrations serializes each billing lineage with transaction-scoped advisory
locks. One aggregate per lineage, unique provider IDs and deterministic
checkout/refund business keys guard distinct commands as well as retries.
Command replay conflicts return 409. Command results and outbox facts commit
with local financial state; external I/O never occurs in a retryable transaction.

An execution-start marker commits before a provider write. An expired lease after
that marker becomes unknown, not permission to repeat. A never-started claim can
be reclaimed only following fresh authorization. Transient Core verification
failure leaves that claim pending; authoritative rejection fails closed.
Provider success followed by a lost local commit requires verified receipt
recovery. Missing provider IDs block automated recovery until evidence exists.

Checkout/refund creation sends the stable persisted operation ID as provider
idempotency key. PayMongo's key-retention window does not authorize repeating an
unknown write. Definite provider rejection is distinguished from ambiguous
transport/response outcomes, but neither automatically creates a new checkout.

## Reconciliation

The existing worker scans every 60 seconds, at most 20 due records, concurrency
two. Patient refresh uses the same 60-second lease and 15-second coalescing path.
Provider calls have a 15-second total deadline and bounded response size. Only
known checkout/refund IDs are retrieved; the worker never repeats creation.

Failures back off 60/300/900/3600 seconds, honor longer Retry-After instructions
and stop scheduled reconciliation after ten consecutive failures for review.
Pending/unknown reconciliation commands retain their original binding but not a
permanently cached failed observation; fresh authorized refresh can retrieve again
after backoff with the same command ID. This read-only recovery never reopens a
checkout/refund write. Manual refresh also respects the recorded failure backoff.
Never-started claims are excluded before the expired-execution scan limit.
Unknown operation state is derived from the ledger independently of review labels.
Temporary unavailable Core context can clear only after verified ownership;
financial uncertainty cannot be cleared by that recovery.

Validate sandbox mode, ID/association, amount and PHP currency. Failed attempts
on an active checkout do not expire it. Redirects prove nothing. Expiry-write
errors require retrieval; an unverified result cannot manufacture failure.
Paid/refunded facts do not regress on stale pending observations. Refund pending
and processing are not success; failed and succeeded are distinct states.

Late first payment after cancellation/expiry is recorded as paid with review
required. It never revives an appointment, grants access or automatically refunds.
Provider refund reason is always `others`; local cancellation reason codes are
not sent to PayMongo.

## Events And Future Participants

Changed/completed facts carry only IDs, source versions, billing lineage,
association version, status/review markers and paid timestamp. Completion is
emitted only on the first verified paid transition. One content-free audit intent
per transition/review follows the central delivery path. No checkout URL, raw
provider response, billing details, tokens or cancellation text enters events/logs.
Unchanged provider observations update polling metadata without incrementing the
financial revision or creating another transition/audit intent.

Payment consumption checks committed Integrations outbox evidence and current
Core association, then commits inbox/projection only. It does not confirm an
appointment, create lifecycle logs, grant access or emit competing audit events.
Historical projections can share a payment ID without losing association fencing.

Private expiry/refund/invoice contracts require committed Appointment intent and
owner-log evidence. Full doctor refunds and patient cancellation at least 24 hours
before the scheduled start use committed cancellation time. Completion creates
idempotent invoice metadata from verified paid state and owner completion time.
No lifecycle producer invokes these contracts yet. Reassociation returns an
explicit gated 503 until the Appointment saga implements its participant protocol.
Invoice PDF/storage/screens remain deferred.

## Verification Boundary

Focused tests use the actual router/module/provider adapter and injected SQL or
transport fixtures, covering rollback, duplicates, stale versions, leases,
unknown receipts, refunds, amount/mode binding and no lifecycle effects.
The isolated suite adds real PostgreSQL checkout concurrency/rollback, RabbitMQ
projection deduplication and actual mTLS assertion checks. Those cases are **not
executed** while runtime validation is deferred. Actual PayMongo sandbox evidence,
Node 22 CI, migration/role grants, ingress and resource acceptance remain gates.

References:
- [PayMongo idempotency](https://docs.paymongo.com/reference/idempotent-requests)
- [PayMongo refunds](https://docs.paymongo.com/reference/refund-resource)
- [RabbitMQ confirms and acknowledgements](https://www.rabbitmq.com/docs/confirms)
