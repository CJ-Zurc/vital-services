# Payment Ownership And Core Billing Contract

## Reviewed route manifest (before extraction)

| Method/path | Current auth/input/output | Target owner and dependency |
|---|---|---|
| POST `/api/patient/appointments/{appointmentId}/payment` | Gateway-verified BFF session; patient only; no browser amount/provider ID; `success,data.payment`; 403 role, 404 missing approved appointment, 500 provider failure | Web adapter to Payment `/internal/v1/payments/appointments/{appointmentId}/checkout`; signed actor bound to appointment and `payments.checkout`; Core billing preparation |
| PATCH same browser path | Same session and patient ownership; no browser financial authority; `success,message,data.payment`; preserves refreshed cookies/session headers | Web adapter to `/reconcile`, scope `payments.reconcile`; same authoritative context; never confirms appointments |
| GET `/internal/v1/payments/appointments/{appointmentId}` | New private versioned DTO; process mTLS and signed short-lived actor, `payments.read` | Payment ledger plus current Core billing context |
| POST private `/checkout`, `/reconcile` | Mutation command ID/hash; mTLS; appointment-bound actor; explicit pending/unknown outcome | Payment owns provider operation/ledger; Core owns eligibility/frozen quote |
| POST `/payments/paymongo/checkouts`, GET `/payments/paymongo/checkouts/{id}`, POST `/{id}/expire`, POST `/payments/paymongo/refunds` | Existing legacy service-key provider API; Web currently persists ledger and lifecycle effects | Legacy only while target flags are off; not an EDA bypass or second writer |
| Private admin review list/link/refund | New internal-only contract; independent current Core admin membership, payment-bound scope and versioned command | Payment review; no browser admin screen or forced paid status |

The existing browser handlers accept no payment body. Checkout eligibility is
`approved`, `pending_payment_verification`, or `confirmed`, with a future scheduled
start. Reconciliation remains available to the owning patient after cancellation
so a late financial fact can be reviewed. Return redirects are not evidence.
The parent Payment/Web implementation owns final versioned response decoding,
transport body limits, 15-second provider deadlines, BFF timeout budget and
review route spelling; no public route is introduced by this Core boundary.

## Mixed workflow inventory

- `lib/payments.ts` prepares/retrieves checkout, expires unpaid checkout and
  requests cancellation refunds; its current paid retrieval confirms appointments
  and recalculates record access. Those lifecycle effects are prohibited in EDA.
- Approval and follow-up preparation call checkout creation; cancellation invokes
  expiry/refund; rescheduling transfers an existing payment association; completion
  creates invoice metadata. These callers remain gated until Appointment extraction.
- Appointment lists/detail, paid-window record authorization and Analytics exports
  compose payment data. They cannot query the Integrations database from Web or
  infer appointment confirmation from a pending payment/projection.
- Invoice documents/storage and PDF composition remain deferred to their owning
  phase. Invoice metadata alone belongs to Payment.

Reviewed mixed browser routes include doctor request approval, doctor follow-up,
patient/doctor appointment cancellation, patient accept-reschedule, and
`/api/appointments/{appointmentId}/complete`. The existing internal auto-complete
job also creates invoice metadata. `/vital/integrations/v1/appointments` exports
compose payment fields under their existing integration authorization contract.
Their writers/read compositions stay with the existing disabled-target boundary
until the owning phase; no checkout success is a substitute for those contracts.

## Core authority

`createBillingAuthority(corePool)` exposes `authorize(actor, appointmentId)`,
`prepare(actor, appointmentId, {operationId, requestHash})`, `current(appointmentId)`,
`verifyIntent(intentId)`, `assertAdmin(actor)` and `committedIntent(intentId)`.
The outer process verifies the actor assertion; this boundary independently
requires a patient role, matching appointment resource, a payment scope and
matching Core patient/VitalUser Auth identity. `prepare` specifically requires
`payments.checkout`. Admin review rechecks the Core admin marker, not a browser
role claim or Auth database query.

`BillingContext` carries appointment/lineage/version/association (initial 1),
patient/doctor Auth UUIDs, consultation type, safe integer amount in centavos,
PHP currency, status/payable/reviewRequired, scheduled Date and optional intent ID.
No names, clinical data, credentials, provider URLs or lifecycle mutations occur.

The first payable preparation atomically freezes one quote per billing lineage.
Fee reads use the Profile-owned doctor row in the same Core transaction. Exact
decimal conversion rejects missing/zero/negative, fractional centavos, exponent
notation and unsafe integers; it never rounds a floating-point fee.
Commands are unique per actor/operation ID and conflict on resource/kind/hash.
Replay requires a fresh authorized request and matching current source versions;
it can renew the 60-second expiry without changing the intent ID or frozen quote.
This is not permission to repeat an already-started or unknown provider operation;
the Payment operation ledger independently enforces that execution boundary.
Checkout intents expire after 60 seconds. `verifyIntent` immediately before a
provider attempt rereads ownership, status, appointment/association versions,
consultation type and the frozen quote. It cannot eliminate a subsequent
cross-database race; a later paid fact is independently classified using current
Core state and never revives a cancelled appointment.
New authorization also blocks open reschedule proposals, unresolved saga states
and active slot reservations. Proposed replacement appointments cannot start a
new checkout in this phase; actual saga reassociation is still gated. Quotes are
capped at 2,147,483,647 centavos to match the provider adapter's integer limit;
larger Profile fees remain readable but cannot become a payable quote.

Future committed kinds `expire`, `refund`, `reassociate`, `complete` cannot be
created through `prepare`. They require a committed owner intent, matching
current versions and a matching Appointment status-log receipt; reassociation
also requires an already-pivoted Core saga. Missing/uncommitted evidence fails
closed. Refund eligibility is evaluated using committed cancellation time:
doctor cancellation is fully refundable; patient cancellation requires at least
24 hours before the scheduled start. No caller-supplied `eligible` flag is used.

## Schema and checkpoint

Additive Core history introduces quote/intent tables and association fencing;
Integrations history adds payment snapshots, operation execution/lease fields,
reconciliation/review state and invoice snapshots. Cross-database identifiers
remain scalar; in-database relations remain constrained. Payment provider IDs are
nullable unique keys for this one-aggregate/full-refund-only contract. Payment
projections retain appointment primary keys and an indexed, non-unique payment
ID so historical reschedule associations are possible. New payment writers must
always populate the nullable transitional centavo snapshots.
Operations include a scalar `authorizationIntentId` linking to Core's committed
preparation and the original actor UUID. Invoices add nullable unique
`completedIntentId` alongside their existing unique payment ID, fencing repeated
completion requests. Operation `requestBody` is reserved for minimal non-personal
provider inputs; it cannot contain patient billing names/contact details.

Neither initial nor Profile migration history is rewritten. No migration is run
against a database at this checkpoint. Mocked Core tests are not evidence of real
PostgreSQL row-lock/concurrency behavior; real database/broker/mTLS and PayMongo
sandbox acceptance remain unexecuted gates. All target flags remain off.
The new non-null lineage migration intentionally requires an empty target payment
ledger: it must fail on populated pre-transition rows rather than fabricate a
Core lineage. Fresh VITAL fixtures are a later isolated reset/cutover task, never
an instruction to reset Auth/EHR/shared data.
