# Core Profile Extraction (Inactive Staging)

This is the first Core-owned profile module, not a production cutover. Existing
Web profile/onboarding routes and Auth-facing role aggregation remain active and
unchanged. Do not mount this router in the current runtime or switch Web callers
until the parent completes extraction, command replay, integrations, deployment,
and end-to-end validation. No configuration or default route enables it here.

## Ownership and Contracts

- Core retains the original VitalUser, VitalPatient, VitalDoctor, VitalAdmin,
  HospitalAffiliation, and DoctorQr fields. Schema generation is parent-owned.
- Imports use `src/eda/generated/core/client.ts`, `contracts/actor.ts`, the
  `CorePrismaClient` type in `infrastructure/databases.ts`, and
  `infrastructure/outbox.ts`. The instantiated Core dependency is always passed.
- `VitalUser.authId` is the canonical Auth UUID. `VitalUser.id` and marker
  `userId` are local Core IDs. These are never interchangeable.
- Only the validated `res.locals.actor` supplies identity and canonical role.
  The router does not read identity headers, tokens, credentials, or body roles.
  Service actors cannot bootstrap profiles. SuperAdmin is not a bypass.
- No Web/Next imports, shared Web database queries, or outbound Auth/EHR/TRACE
  endpoints are introduced. Auth identity and EHR composition remain in Web.

## Staged API

`createProfileRouter(core, { commandGuard? })` returns an Express 5 Router.
The one-argument form permits reads but every mutation returns 503.
`createProfileModule(core, commandGuard?)` has the same default-off write policy.
There is no singleton import; tests inject a structural stub.

| Method | Relative Path | Rules and Response |
| --- | --- | --- |
| GET | `/me` | Own patient/doctor/admin actor, `profile.read` scope, exact own Auth UUID resource; `{success,data: VitalUser with local markers}`. Missing profile returns `data:null`; no implicit write. |
| POST | `/materialize` | Empty object only, `profile.materialize` scope, exact own Auth UUID resource. Verified own canonical role creates/repairs the local marker. Existing markers are retained; unchanged bootstrap emits no event. |
| GET | `/roles/:authId` | Only service role, `profile.roles.read` scope, and resource exactly equal to the requested Auth UUID. Returns the existing-compatible `success/system/user_id/roles/data` envelope; role order is admin, doctor, patient. |
| GET/PATCH | `/patient/me` | Patient only, `profile.read`/`profile.write` scope respectively, exact own Auth UUID resource. `{success,data:{vitalPatient}}`; PATCH adds the existing success message. |
| GET/PATCH | `/doctor/me` | Doctor only, `profile.read`/`profile.write` scope respectively, exact own Auth UUID resource. `{success,data:{vitalDoctor}}`; PATCH adds the existing success message. |

Read DTOs explicitly select the original local scalar fields. No Auth profile,
EHR summary, booking profile, session headers, tokens, or credentials are invented.
Hospital affiliations and DoctorQr remain in Core but their mutation workflows
are not part of this slice. Absent role markers read as null; PATCH returns 404.
Missing validated actors return 401, role/resource violations 403, invalid input
400, already-completed onboarding/role mismatches 409, inactive writes 503.
Unexpected errors are sanitized to 500 without database details.

## Field Allowlists

Patient PATCH accepts `emergencyContactName` (1-160 trimmed characters),
`emergencyContactRelationship` (1-80), and `emergencyContactPhone`. Contact edits
validate the merged stored/new contact as a complete trio, matching Web booking
validation. Only `09XXXXXXXXX` or `+639XXXXXXXXX` mobile numbers are accepted;
spaces, parentheses, and hyphens are removed and numbers normalize to +63.

Patient onboarding requires `isOnboardingComplete:true` plus an `onboarding`
object. This object retains the existing snake-case validation names:
`consent_accepted:true`, `date_of_birth`, `sex`, `contact_number`,
`address_island_group`, `address_province_region`, `address_province`,
`address_city_municipality`, `address_barangay`, `address_street`,
`address_postal_code`, `address_country`, `philhealth_identification_number`;
optional `address_barangay_psgc`, `blood_type`, and `religion`.
Past valid dates, male/female sex, phone formats, minimum five-character street,
180-character street maximum, postal/PhilHealth formats, and the NCR province
exception match the existing validation with additional bounded lengths.
Already-completed onboarding returns 409. These inputs are not persisted as
Core profile columns. Auth identity, optional clinical BMI/allergy writes, live
PSGC validation, and EHR self-create/update remain integration-owned.

The parent guard must verify address hierarchy and successful EHR onboarding
before calling `execute({patientRecord:{ehrPatientId,ehrRecordOrigin}})`. Without this
trusted result, completion fails closed with 503. Only `preexisting` or
`created_by_vital` origins are accepted. Clients cannot set record IDs, origins,
record availability, or completion to false. The trusted integration result sets
the original patient record fields and completion together in Core.

Doctor PATCH accepts original camel-case `title`, `specialty`, `prcLicense`,
`availabilityType` (virtual/in_person/both), `virtualFee`, `inPersonFee`, `bio`,
and `education`. Nullable text is bounded at 80/160/80/5000/3000 characters,
respectively. Fees accept null, finite nonnegative numbers, or complete decimal
strings, with at most two fractional digits and a Decimal(10,2) maximum.
Authority-bearing `role`, rating, department IDs, relations, timestamps, and
Prisma arguments are rejected. Specialty remains locked after completion when
an existing specialty is set, matching the Web profile rule.

Doctor completion requires `isDoctorOnboardingComplete:true`,
`terms_accepted:true`, and nonempty title, specialty, PRC license, bio, and valid
availability, using merged stored/new fields. The parent guard must supply a
TRACE-verified `specialty` through `execute({specialty})`; absent confirmation fails closed with 503.
Core assigns `termsAgreedAt` and `changedAt`; neither is client-controlled.

All objects are strict Zod allowlists. Unknown fields, Auth/EHR identity patches,
arbitrary nested Prisma writes, empty patches, and cross-actor IDs are rejected.

## Commands and Source Events

The optional `ProfileCommandGuard` is an injection contract for the parent, not
a completed command/replay implementation. It receives the Core transaction,
`{actor,operation,input?,metadata?}` with parsed allowlisted input, and an
`execute(verification?)` callback returning the domain result. Operations are
`materialize`, `patient.update`, `patient.onboarding`, `doctor.update`, and
`doctor.onboarding`. The module itself enforces the named scopes and exact
resource. The guard must enforce durable command claims and trusted integration
confirmations, call `execute` at most once for a fresh command (or return a stored
replay result), persist the returned result on the SAME supplied transaction, and
return it. It must throw on denial or failed finalization so profile/event/command
changes roll back together. A permissive execute-only guard is only a test fixture,
never production wiring. The parent must finish durable replay before enabling writes.

Mutation methods accept optional `ProfileCommandMetadata` as their final argument:
`{operationId: UUID, requestHash: lowercase SHA-256 hex}`. The router forwards this
from trusted `res.locals.command`, never headers or body. Parent middleware must
verify signed UUID jti and method/path/body hash binding before populating it;
the command wrapper must require this metadata when writes are enabled.

Guards execute inside retryable serializable Core transactions. They must not
perform external network mutations in that transaction or treat a retry as a
new external operation. Use parent-managed, already-confirmed integration facts.
The module retries Prisma serialization/bootstrap uniqueness races up to three
attempts; other failures propagate and roll back.

Every committed changed mutation atomically increments `VitalUser.version`
from its schema default 0 and calls the parent's `appendOutbox` on that same
transaction with:

```text
eventType: vital.profile.changed
producer: profile
aggregateId: local VitalUser.id
aggregateVersion: incremented VitalUser.version
correlationId: validated actor.correlationId
data: {authId, role, operation, actorAuthId}
```

Event operations use the parent's allowlist: `materialized`, `profile_updated`,
or `onboarded`. The parent helper generates the event UUID. Profile changes and
revision increments roll back if source-event persistence fails. Events contain
no emergency contacts, clinical data, credentials, or tokens.

## Parent Registration and Mounting

Test registration entry: `test/eda-profile.test.ts` (Node test runner).
The parent's `test/eda-*.test.ts` glob already includes it. Focused command after
parent dependencies and generated clients are available:

```powershell
node --import tsx --test test/eda-profile.test.ts
```

Proposed staging mount only, after trusted actor middleware and a bounded JSON
parser: `app.use('/profile', validatedActorMiddleware, createProfileRouter(core))`.
This exposes `/profile/me`, `/profile/materialize`, `/profile/roles/:authId`,
`/profile/patient/me`, and `/profile/doctor/me`; mutations still remain off.
Enabling later requires the parent-owned command guard and confirmed integrations.
Gateway/browser aliases and Auth role-provider cutover are separate parent work;
do not change the current Web `/internal/users/:user_id/roles` route yet.

Tests cover actor isolation, missing actors, default-off writes, verified role
bootstrap, local ID distinction, ordered role lookup, strict allowlists, contact
validation, bounded fees, onboarding prerequisites, specialty locking, command
denial, event revisions, and transactional rollback. Mocks do not replace a real
Postgres serializable-concurrency or deployment/cutover test.
