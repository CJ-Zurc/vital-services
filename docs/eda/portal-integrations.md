# Portal And Staff Integration Checkpoint

Updated 2026-10-16. VITAL-only, disabled with the existing completion flag. No
foreign database access, new privileged marker, EHR record creation or UI change.
This checkpoint is not integration/runtime acceptance.

## Parent Wiring

`portalIntegrationsRuntime` is wired to the API entrypoint and mounted at
`/internal/v1/portal-integrations` after process-mTLS/assertion verification.
The completion flag controls this owner. Staff Appointment composition also
requires the real Appointment, Payment and Video owners. Missing dependencies
remain unavailable rather than selecting a legacy implementation.

Construct the module when `VITAL_EDA_COMPLETION_ENABLED` and the global target
flag are enabled:

```ts
const portal = portalIntegrationsRuntime(databases, environment);
```

Use the existing scoped Auth profile-read credentials, not a new credential or
an Auth database connection. Runtime enrichment verifies exact batch membership
and UUIDs under a bounded deadline. Missing entries retain null names/email;
malformed or substituted receipts fail closed. Profile scans use
200-row batches, retain only the requested page, and fail rather than silently
truncate when their between-batch deadline is exhausted. Sorting/filtering is
the legacy changedAt/userId or userId order, including Auth names before paging.
As with legacy list reads, concurrent edits during a multi-batch Profile scan
are not a snapshot-consistency guarantee.

## Signed Delegation

Web must sign an additional `portalDelegation` claim:

```ts
{ subject, system, systems, roles, isAdmin, isSuperAdmin, expiresAt }
```

All fields come from the already secret-validated Gateway actor and its trusted
`X-User-Token-Expires-At`, never a browser JSON body. The ordinary actor uses
the same subject, role `service`, `isSuperAdmin: false`, exactly one scope
`portal.integration.<route replacing / with .>`, and resource `portal:<route>`.
For example: `portal.integration.patient.appointments` and
`portal:patient/appointments`.

After existing mTLS, RS256/audience, subject, action, path and request-hash
verification, call `portalIntegrationDelegation(token, actor, method, originalUrl)`
only for this namespace. Set its returned source in `res.locals.portalDelegation`.
The module independently allowlists method, query keys, route, source roles,
source subject, system membership, scope, resource and source expiry. Assertion
expiry cannot exceed source expiry. A complete standalone verifier is also
exported as `verifyPortalIntegrationAssertion` for middleware that does not
already perform the common assertion checks. Merely decoding a token is not
verification; do not call the extraction helper on unverified tokens.

Staff reads allow effective EHR nurses/doctors/admins or a trusted SuperAdmin.
They do not require or manufacture local VITAL membership. `med-tech` and
`rad-tech` alone remain denied. Portal history allows UHSE guest, EHR patient or
VITAL patient with VITAL system access; VITAL guest is bootstrap-only.

## Contract Manifest

All private responses are `{success:true, contractVersion:1, data}`. Web restores
the unchanged public response envelope. Existing public methods remain:

| Public integration path | Private suffix | Behavior |
|---|---|---|
| GET `/integrations/v1/doctors` | `/doctors` | Legacy fields, fees, hospitals, syncStatus; search/specialty/onboarding; page=1/pageSize=50 capped100. |
| GET `/integrations/v1/patients` | `/patients` | Legacy profile/linkage fields and counts; search/ehrLinked/onboarding; same pagination. |
| GET `/integrations/v1/appointments` | `/appointments` | Requires real staff composition; status/patientId/doctorId/dateFrom/dateTo; exact total before paging. |
| GET `/integrations/v1/patient/appointments` | `/patient/appointments` | Caller UUID only; pageSize20; complete unfiltered status totals, filtered page and earliest active future appointment. |
| POST `/integrations/v1/patient/bootstrap` | `/patient/bootstrap` | Empty private input; signed command; create/recover only the caller's patient marker. |
| POST `/integrations/v1/doctors` | `/doctors/workflows`, `/{id}/commit` | Stable command ID; foreign-manager prepare/commit; verified Auth UUID and TRACE department. |

Patient history is selected in repeatable-read Core transactions and excludes
complaint, payment, meeting links, notes and clinical bodies. `subjectAuthId` is
internal response binding, removed by Web. No local marker means the genuine
legacy `patientReady:false`, empty page, zero totals and null next appointment.
Record counts use the target `records_documents` authority by kind, not retired
plaintext prescription/certificate rows. Appointment totals use owning Core
rows; no cross-database join or stale financial projection grants access.

`createPortalStaffAppointmentReader(core, compose)` implements count, filters,
PHT inclusive date bounds and stable legacy sorting/page selection. It passes
only selected IDs, versions and association references to a required owner
composer, then checks returned IDs/order and rechecks Core versions. The
composer must supply the complete legacy appointment DTO through real
Appointment/Payment/Video owners, including source/reschedule/log fields and
current financial/media fencing. An ordinary local admin/patient API is not a
substitute. Missing composition remains an explicit
`APPOINTMENT_INTEGRATION_STAFF_READ_UNAVAILABLE`, never a partial DTO.

## Bootstrap Reliability

`createPortalProfileBootstrap` is Profile-owned. It uses the same Profile command
guard and `recordProfileEffects`, not a second retry or audit mechanism. Current
signed patient/guest eligibility is checked on every call. Serializable
transactions reject any existing non-patient canonical role, doctor marker,
admin marker or mismatched local/Auth identity before command replay. At most
three attempts retry Prisma serialization/uniqueness conflicts.

The selected role is hardcoded patient; source role/admin fields cannot select a
privileged marker. The mutation atomically writes the patient marker, command
result, version, Profile fact, audit intent and Auth-stale sync intent. There are
no external operations inside that transaction and no inferred registration
consent. Replays verify hash/authority and return current onboarding state.
With Profile writes disabled, an already matching marker can be reported, but
new creation returns `PROFILE_PORTAL_BOOTSTRAP_WRITES_DISABLED`.

Doctor provisioning uses `portal.doctor.provision` in the existing Profile ledger,
not the local-admin workflow. Signed EHR-admin/platform-SuperAdmin authority is
checked again within retried transactions. Auth resolution requires an active,
nondeleted, nonbanned UUID; awaiting OTP does not prevent authorized marker
creation or grant authentication. No Auth identities/credentials or hospital or
VITAL-admin privileges are created by this operation.

Web verifies TRACE before sending a typed receipt bound to workflow, actor,
target, input hash and expected Profile version. Prepare/commit use distinct
stable command IDs. Core atomically commits the marker, receipt, command result,
Profile effects and mirror/stale/audit intents. Synchronization status comes from
the existing delivery owner, not a fabricated success.

## Verification

The backend tests cover signed authority/tampering, isolation,
230-row totals, target Records counts, PHT filters, exact page selection,
Profile bootstrap rollback/replay/conflicts/current-role checks and Auth UUID
binding. Backend source typecheck passes. Tests use owner/Prisma/HTTP fixtures;
real PostgreSQL, Gateway, Auth, mTLS network and broker checks remain unexecuted.
Staff composition and provisioning have wired real owner implementations and
local fixtures. Actual Auth/TRACE/EHR/Gateway/mTLS/database verification is still
unexecuted and cannot be inferred from these checks.

### Reliability Regression Coverage

The following focused files execute production modules from
`modules/portal-integrations/`, not a substitute workflow implementation:

- `test/eda-portal-provision-reliability.test.ts` uses the real foreign-manager
  provision owner, Profile command guard and Profile effect writer. A dedicated
  Prisma fixture snapshots and restores all Core writes on failure, serializes
  concurrent commands and asserts Serializable isolation. Duplicate prepare and
  commit commands leave one workflow, two completed journal entries, one marker
  version, four outbox events and two sync intents. Replay returns current doctor
  fields and delivery status rather than a stored DTO. Hash/receipt/actor/target
  substitution, stale Profile revision, reused workflow/prepare operation IDs,
  revoked foreign-manager authority and inactive identity fail closed. Authority
  is also revoked between entry authorization and transaction execution.
- The same file injects failures in outbox, sync intent, workflow receipt, journal
  and final transaction commit after a caller-supplied external receipt. Each
  failure leaves the prepared workflow intact with no marker or partial effects;
  retrying the same signed commit succeeds once. P2034/P2002 retry fixtures assert
  no repeated identity lookup inside the retried transaction. The external receipt
  represents an already verified caller result; these tests do not call TRACE or
  establish external receipt/provider acceptance.
- `test/eda-portal-staff-reliability.test.ts` runs the actual staff reader/composer,
  Payment SQL store reader and Video portal projection. Dedicated SQL fixtures
  assert RepeatableRead page selection, traverse 51 logs and 51 reschedule
  proposals, preserve owner DTOs and exclude relations with another patient or
  doctor. Core revision/participant/lineage/association changes, every Payment
  association binding, prepared/retired/older/reassociated Video resources and
  post-composition Core changes are fenced. Missing resources fail instead of
  returning partial data; revoked/expired and mid-flight source authority is
  denied. Financial/provider credentials are not copied into the staff DTO.

Run only the portal-focused regressions:

```sh
node --import tsx --test --test-concurrency=1 test/eda-portal-integrations.test.ts test/eda-portal-provision-authority.test.ts test/eda-portal-provision-reliability.test.ts test/eda-portal-staff-reliability.test.ts
```

These are deterministic local behavior checks. The fixtures do not prove real
PostgreSQL serialization/unique-constraint scheduling, SQL planner behavior,
network authorization, Auth/TRACE/Payment/Video provider availability or delivery
recovery. No live database, provider, Docker operation, deployment or full build
is part of this coverage. Coordinated acceptance remains outstanding.
