# Target PayMongo Provider

This adapter is an isolated EDA component, not a staging activation. Legacy
`src/paymongo.js`, payment operations and entrypoints are unchanged. The Payment
module owns authorization, quotes, durable operations, leases, reconciliation,
review and events; this adapter has no database access or background retries.

## Interface And Transport

`src/eda/modules/payment/payment-provider.ts` exports `PaymentProvider`,
`CheckoutObservation`, `RefundObservation`, `ProviderError` and
`createPaymongoProvider({secret, fetcher?, baseUrl?})`.

| Method | Fixed v1 endpoint | Idempotency header |
| --- | --- | --- |
| `createCheckout(input)` | POST `/checkout_sessions` | Persisted `input.operationId` |
| `retrieveCheckout(id)` | GET `/checkout_sessions/{id}` | None |
| `expireCheckout(id)` | POST `/checkout_sessions/{id}/expire` | None |
| `createRefund(input)` | POST `/refunds` | Persisted `input.operationId` |
| `retrieveRefund(id)` | GET `/refunds/{id}` | None |

The origin is pinned to `https://api.paymongo.com/v1`. `baseUrl`, if supplied,
must equal that exact constant; mock transport uses `fetcher`, never another
network destination. Runtime configuration and browser requests must not select
a fetch implementation. Redirects are rejected before forwarding credentials.
Only `sk_test_` alphanumeric secrets are accepted, using Basic authentication.

Every call has one 15-second deadline covering both response headers and body.
JSON is read through the shared streaming receipt reader, bounded at 65,536
bytes. Oversized, missing and malformed bodies fail closed. No adapter operation
logs tokens, URLs, clinical text, raw responses or upstream error details.

Creation inputs reject unknown fields. Amounts are integer centavos, positive and
at most 2,147,483,647; refunds additionally require at least 100. Only PHP is
accepted. Decimal fee conversion and provider/payment-method minimum checks
belong to the owner, not floating-point conversion inside this adapter.
Checkout/refund operation IDs must be distinct, persisted before the request,
and reused verbatim as creation keys. The adapter does not persist those keys.

Return URLs must be built by the owner from its configured application origin,
never from browser-supplied origins. The adapter rejects credentials, fragments,
whitespace, backslashes and non-HTTPS URLs, except explicit HTTP loopback hosts
for local development. It does not claim that syntactic validation establishes
the application origin allowlist. Hosted checkout URLs require HTTPS and the
exact `checkout.paymongo.com` host without credentials or an explicit port.

The v1 checkout payload contains only generic line-item text, amount, permitted
payment methods, return URLs and appointment/billing-lineage identifiers. Email
receipts are explicitly disabled. Refund creation sends `reason: "others"`
without notes or clinical/cancellation text; the original VITAL reason stays in
the owning ledger.

## Observations And Failure Rules

Checkout observations include resource IDs, validated hosted URL, total amount,
PHP currency, test mode, appointment/lineage metadata, active/expired state and
financial status. Total amount comes from validated line-item amounts multiplied
by quantities; nested intent/payment amounts, currencies and modes must agree.
Retrieval/expiry responses must match the requested resource ID. Creation also
requires the exact authorized amount and appointment/lineage metadata.

An active checkout remains `pending` after a failed attempt. An expired checkout
without a paid payment is `failed`. A verified paid payment wins over expiry,
but requires a positive provider `paid_at` Unix timestamp; the adapter never
fabricates payment time from the local clock, creation time or intent success.
Duplicate payment entries in the checkout/intent arrays must agree. Multiple
distinct paid payments, or a succeeded intent without paid-payment evidence,
are ambiguous and rejected. Every known payment-intent ID in both payment
arrays must match the resolved checkout intent, regardless of paid/pending/failed
status. Without a checkout-level intent ID, the first known payment association
resolves it and all other known associations must agree; missing IDs remain
unknown, not fabricated. Contradictory associations are rejected as ambiguous,
including historical unpaid attempts with a different intent. Unpaid attempts
are not exposed as refundable IDs.
Refund observations preserve `pending`, `processing`, `succeeded` and `failed`;
creation additionally verifies payment association and amount.

`ProviderError` exposes only `code`, `definite` and optional
`retryAfterSeconds`. Local input/configuration failures are definite. Upstream
rejections are definite only for HTTP 400/401/403/404/422 with a nonempty error
array consisting entirely of supported validation/auth/not-found codes:
`parameter_invalid`, `parameter_data_type_invalid`, `parameter_format_invalid`,
`parameter_required`, `parameter_below_minimum`, `parameter_above_maximum`,
`authentication_invalid`, `api_key_invalid`, `authentication_failed`,
`resource_not_found`, `organization_not_allowed`.
Other HTTP responses, unsupported/mixed errors, transport failures, timeouts
and malformed successes are ambiguous. Error details and original causes are
not exposed. Numeric and HTTP-date `Retry-After` values propagate to the owner.

There are no automatic retries, including writes with stable keys. The owner
must retain unknown outcomes and retrieve known IDs or require review, not
automatically recreate resources. Expiry errors propagate; they never become
invented successful expiry and do not prove that a checkout is unpaid.

## Provider Evidence And Verification

The API stays on v1 intentionally, without a provider-version upgrade.
Resource validation follows the [checkout resource](https://docs.paymongo.com/reference/checkout-session-resource)
and [refund resource](https://docs.paymongo.com/reference/refund-resource).
Creation keys have a documented 24-hour retention window; this is not durable
business deduplication or permission to repeat unknown writes.
See [PayMongo idempotency](https://docs.paymongo.com/reference/idempotent-requests).

Provider documentation has an endpoint-display discrepancy: the
[refund retrieval reference](https://docs.paymongo.com/reference/retrieve-a-refund)
currently displays unversioned `/refunds/{id}`, while the existing integration
and approved target contract use v1. The adapter retains `/v1/refunds/{id}`;
actual sandbox retrieval evidence is required before activation. It does not
silently try alternate endpoints after an error. Checkout creation, expiry,
metadata echo and refund status evidence also remain live acceptance gates.

`test/eda-payment-provider.test.ts` invokes the actual adapter with an injected
mock fetch, covering transport shape, sandbox and URL validation, amount/ID
fences, creation keys, financial mapping, refund progression, expiry errors,
timeouts, streaming size limits, redaction and retry classification. These tests
do not demonstrate actual PayMongo account capabilities or provider behavior.

Run `node --import tsx --test test/eda-payment-provider.test.ts`. No real provider,
database, broker, port changes or deployment is necessary for this suite.
