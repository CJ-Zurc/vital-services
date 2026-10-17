# Patient Self-Registration Handoff

Default-off code checkpoint. The existing form and pre-OTP flow are unchanged:
Gateway/Auth identity creation -> Auth provenance resolution -> Core patient
marker and accepted registration consent -> existing OTP page. No session or
clinical authority is granted by creating the marker.

## Reviewed Route Manifest

| Method/path | Authority | DTO/result | Dependencies / gate |
| --- | --- | --- | --- |
| POST Web `/api/auth/register` | Public, same-origin JSON; Gateway registration throttling | Existing request and 201 `{success,message,data:{vitalUserId,authId,email,isVerified}}` | Global EDA default off; private adapters required |
| POST Core `/internal/v1/profile/registration/receipt` | Process mTLS, signed service actor, exact target Auth UUID, sole `profile.registration.receipt` scope | `{consent_accepted:true,registrationId}` -> existing Profile v1 user envelope | Profile writes default off; live Auth resolution required |
| POST Auth `/internal/vital/registrations/resolve` | Dedicated Web/backend credentials; no generic fallback | Web `{email}`; backend `{auth_id,registration_id}` -> purpose-bound v1 metadata | Additive Auth migration first; empty keys fail closed |

Web keeps the existing Gateway-only identity creation. After successful creation
or a duplicate-email 409 it resolves Auth provenance. Duplicate recovery permits
only an unverified identity; fresh successful sandbox registration may be verified.
Unknown Auth outcomes require a subsequent lookup/retry, never a guessed marker.

Auth creates a nullable unique reference only for new VITAL password
self-registrations in the identity transaction. It does not backfill history or
infer purpose from an unverified VITAL system slug. Doctor/admin provisioning
and Google account creation do not issue references. See Auth's
`docs/features/vital_registration.md` for status checks and route-key restrictions.

This design uses **online reference verification**, not a reusable bearer/signed
receipt. The Core authority adapter checks current Auth state on every attempt,
including command replays, outside retryable transactions. Response purpose,
version, subject and reference must all match. No outage/unknown result means
approval. Private Auth URLs prohibit redirects/embedded credentials and require
HTTPS in production; 10-second deadlines and bounded bodies apply.

Web sends a service actor, not a fabricated patient session. Existing asymmetric
process assertions bind method/path/body, Auth UUID, scope and deterministic
operation ID with a maximum 60-second lifetime. A stable operation derived from
the Auth reference recovers Core failure after external success. Core refuses
non-patient roles and retained doctor/admin markers before journal replay.
Marker, consent, command result, version and existing outbox effects are atomic.
The authenticated consent bootstrap route remains patient-only and separate.

Only reference metadata/hash and patient DTOs may enter the journal; no password,
OTP, user token, names or email enter Core commands/events. The reference alone
cannot authenticate or authorize any API. Existing materialization audit intent
is reused once; the pre-OTP service delegation does not attest user login.

## Configuration And Release Gate

- Web: `AUTH_INTERNAL_URL`, distinct `VITAL_WEB_AUTH_REGISTRATION_KEY`, existing
  signed mTLS transport settings.
- API: `VITAL_AUTH_INTERNAL_URL`, distinct `VITAL_SERVICES_AUTH_REGISTRATION_KEY`.
- Auth: both matching dedicated keys; migration `a8b9c0d1e2f3` before image.
- Keys default empty; no actual secret/active flag has been changed.

Core writes remain independently gated by `VITAL_EDA_PROFILE_WRITES_ENABLED`.
Existing public Gateway BFF registration allowlisting is reused; no Gateway
business-logic changes. EDA errors never invoke legacy Web persistence. Flags-off
legacy remains retained for pinned staging, not a target fallback.

Local fixtures do not establish PostgreSQL uniqueness/concurrency, real mTLS,
ingress, Google, OTP/email delivery or release acceptance. No local Docker is
possible. Execute isolated remote/CI migration and complete ingress handoff tests
before coordinated activation; never reset Auth to exercise VITAL fixtures.

## Verification Evidence

2026-10-15: backend full suite 345 passed / two skipped; Web full suite 304 passed
/ two skipped; focused Auth registration and existing scoped-key contracts 151
passed with isolated SQLite/mocked outbound dependencies. Backend build, Web
normal production build (127 generation entries), nonincremental typecheck,
Auth Ruff and scoped Web ESLint passed. The final no-store response adjustment
also passed the focused four Web handoff tests. Host execution was required for
sandbox-blocked Windows asyncio/loopback fixtures. Host Node 24/Python 3.13 is
not Node 22/Linux/PostgreSQL acceptance. Exact tests are registered in the root
automated-test catalog; real migration/ingress/mTLS/OTP evidence remains pending.
