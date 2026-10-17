# Core Profile Workflows (Disabled by Default)

The bounded [remaining ownership checkpoint](eda/profile-remaining-ownership.md)
adds authenticated registration consent bootstrap and a transaction-local
schedule upgrade interface. Parent wiring, public Auth registration and secured
asset metadata remain separate coordination gates.

This slice is not a production cutover. The legacy Web writer and Auth role
provider remain unchanged until the parent accepts and enables extraction.
Neither this module nor its router enables writes by default. The existing
signed mTLS BFF delegation middleware must run before this router; receipts are
trusted only because its assertion binds the HTTP action, resource and whole
request body. Do not mount this router on a headers-only or browser boundary.

## Ownership

Core owns VitalUser and the patient, doctor and admin markers. Auth UUIDs
(`authId`) are not local Core user IDs (`userId`). Identity, credentials,
address hierarchy validation and external Auth/EHR/TRACE operations remain
BFF/provider-owned. No network calls execute inside Core transactions.

`createProfileModule(core, commandGuard?)` and
`createProfileRouter(core, {commandGuard?, syncStatuses?})` are injected factories.
The one-argument forms allow reads but mutations fail with 503.
`createProfileCommandGuard()` requires signed command metadata from
`res.locals.command`: UUID `operationId` and lowercase SHA-256 `requestHash`.
The signed transport hash and independently computed canonical command
action/role/target/input hash bind replay. Reusing a command ID for another
action, role, resource, body or signed request returns 409. Results and domain
effects commit in the same serializable transaction, with bounded retries for
Prisma serialization/uniqueness races.

## API and Delegation

Paths below are relative to `/profile`; the parent currently mounts the API
under `/internal/v1/profile`. Responses use `{success:true,data}`.

| Method | Path | Scope | Exact Resource |
| --- | --- | --- | --- |
| GET | /me, /patient/me, /doctor/me | profile.read | own Auth UUID |
| POST | /materialize | profile.materialize | own Auth UUID |
| PATCH | /patient/me, /doctor/me | profile.write | own Auth UUID |
| GET | /roles/:authId | profile.roles.read | requested Auth UUID |
| GET | /admin/doctors, /admin/membership | profile.admin.read | admin's own Auth UUID |
| POST | /workflows | profile.write for self, profile.admin.write for admin | subject Auth UUID |
| GET | /workflows/:id | same write scope as prepare | subject Auth UUID |
| POST | /workflows/:id/commit | same write scope as prepare | subject Auth UUID |
| POST/PATCH | /admin/doctors | profile.admin.write | target Auth UUID |

Self patient/doctor APIs require the corresponding canonical role; /me and
/materialize accept patient, doctor or admin, never service. /roles requires
service role. Admin APIs and workflows require BOTH delegated admin role/scope
AND an independent VitalAdmin marker whose related VitalUser has the same Auth
UUID and local user ID. A VitalUser.role value alone, or SuperAdmin, is no bypass.
All markers remain preserved during verified materialization or provisioning.

GET /admin/doctors returns `{items:[doctor scalars + syncStatus],total}`.
GET /admin/membership returns
`{memberships:{patient:string[],doctor:string[],admin:string[]},counts:{patients,doctors,admins,accounts}}`.
Membership arrays contain Auth UUIDs; accounts is patients + doctors for legacy
dashboard parity, not a deduplicated identity count. The parent may inject
`syncStatuses(authIds):Promise<Map<authId,'pending'|'failed'|'synced'>>`.
Absent/missing/failed status lookup reports pending, never assumes synced.
The callback runs after Core transactions; this module does not read Integrations.

## Workflow Contract

Prepare: POST /profile/workflows

```json
{"workflowId":"UUID","kind":"patient.onboarding","targetAuthId":"optional UUID","input":{}}
```

Kinds: patient.onboarding, doctor.onboarding, doctor.provision, doctor.specialty,
doctor.update. Self workflows default targetAuthId to the actor's Auth UUID and
reject another identity. Admin provision/specialty require targetAuthId explicitly.
Provisioning rejects credentials, email, names and authority fields: the BFF must
first create or resolve identity through Auth and later attest the verified
target Auth UUID in the receipt. Core cannot create an Auth identity.
Before the Auth creation/recovery call, the BFF must preflight GET
/profile/admin/membership with profile.admin.read and the admin's own Auth UUID
resource. This independently checks the current Core marker before any external
identity mutation; signed current-session delegation is still required.

Prepare returns
`{workflowId,kind,targetAuthId,inputHash,expectedVersion,state:'prepared'|'committed'}`.
The hash is exactly `requestHash('PROFILE', kind, input)` from
infrastructure/security, also called canonicalHash by the BFF. Hash the original
allowlisted JSON input; canonical key ordering makes object order irrelevant.
expectedVersion is the current VitalUser.version, or -1 for a not-yet-materialized
provision target. Prepare checks merged onboarding prerequisites before the BFF
does external work. Retrying prepare with the same binding returns its state.

Status: GET /profile/workflows/:id returns the same minimal status, never input
or receipt. Only the original actor/role and exact target resource may read it.

Commit: POST /profile/workflows/:id/commit

```json
{"input":{},"receipt":{"operationId":"workflow UUID","inputHash":"canonical hash"}}
```

Patient receipt must contain exactly:
`{ehrPatientId,ehrRecordOrigin:'preexisting'|'created_by_vital',operationId,inputHash}`.
Doctor/onboarding/provision/specialty/update receipt must contain exactly:
`{department:{id,name},authId?,operationId,inputHash}`.
authId is mandatory for doctor.provision and must equal targetAuthId; when present
in other doctor receipts it must also match. The verified department name must
equal the submitted, normalized specialty. Authority-bearing department IDs
are accepted only from the receipt, not the input.

Receipt operationId is the stable workflowId, not the signed request ID.
Prepare and commit require distinct signed command IDs, each different from
workflowId. Reusing the prepare command ID for commit returns 409. A fresh commit
checks actor/role, target, kind, exact input hash, receipt binding, expectedVersion
and prepared state. It commits once; exact signed command replay returns its
stored result without new effects. A different commit ID after completion, a
changed profile version or any receipt/hash/operation mismatch returns 409.
Authorization violations remain 403, invalid input 400, absent profile/workflow
404. Failure rolls back receipt/state, command and all Profile effects.

Commit data is `{workflowId,kind,targetAuthId,inputHash,expectedVersion,state:'committed',data:profileScalars}`.
Doctor results include syncStatus at the router boundary.
POST /admin/doctors and PATCH /admin/doctors are convenience commit aliases:
body `{workflowId,input,receipt}`, for doctor.provision and doctor.specialty
respectively. They require an already prepared matching workflow and return
`{doctor:profileScalars+syncStatus}`. They do not accept arbitrary identities
or bypass receipt/version verification. Each alias has its own command action.

ProfileWorkflow stores only binding identifiers, hash, expectedVersion,
prepare/commit IDs, minimal receipt and state/timestamps. No submitted onboarding
input, clinical information or bearer tokens are stored there or in command
results. Command rows store only hashes and safe Core response scalars.

## Field Allowlists

Patient direct PATCH accepts emergencyContactName (1-160 trimmed characters),
emergencyContactRelationship (1-80) and emergencyContactPhone. The merged contact
must be a complete trio. Philippine mobile formats 09XXXXXXXXX/+639XXXXXXXXX
normalize to +63 after spaces, parentheses and hyphens are removed.

Patient onboarding workflow input uses the existing patientPatchSchema completion
shape: isOnboardingComplete:true plus onboarding containing consent_accepted:true,
date_of_birth, sex, contact_number, address_island_group,
address_province_region, address_province, address_city_municipality,
address_barangay, address_street, address_postal_code, address_country and
philhealth_identification_number; optional address_barangay_psgc, blood_type,
religion and emergency-contact fields. Valid past dates, phone/postal/PhilHealth
formats and the NCR province exception remain enforced. The BFF validates real
address hierarchy and completes EHR work. Core atomically writes EHR record
link/origin/availability/completion at commit. ConsentRecord persistence remains
outside this Profile phase.
Direct PATCH cannot complete onboarding even through a permissive command guard.

Doctor input preserves doctorPatch camel-case title, specialty, prcLicense,
availabilityType (virtual/in_person/both), virtualFee, inPersonFee, bio, education,
isDoctorOnboardingComplete, plus the existing terms_accepted flag. Fees are finite,
nonnegative Decimal(10,2), at most two fractional digits. Completion requires
isDoctorOnboardingComplete:true, terms_accepted:true and merged nonempty title,
specialty, PRC license, bio and availability. Workflow input must supply specialty
explicitly so the receipt binds its verified department. Provision and doctor.update
accept doctorPatch fields without completion/terms; doctor.specialty accepts only
specialty. All doctor workflow kinds require a nonempty specialty.

Direct doctor PATCH cannot set specialty or onboarding completion. Pre-completion
specialty edits use doctor.update workflows; after completion specialty changes
remain admin-only. Core sets changedAt and termsAgreedAt. Body role/rating/department
IDs, Auth/EHR fields, arbitrary Prisma arguments, credentials and unknown fields
are rejected by strict allowlists.

## Atomic Effects and Schema

Each changed mutation increments VitalUser.version then calls the parent-owned
recordProfileEffects(tx, actor, actualSubjectUser, exactOperation, metadata).
Operations: materialize, patient.update, patient.onboarding, doctor.update,
doctor.onboarding, doctor.provision, doctor.specialty. Subject authId/role are
always the user's, not the admin actor's. The helper appends one source fact,
one audit intent and Core sync intents on the same transaction. Provision,
doctor onboarding and every verified specialty edit pass doctorMirror:true plus
departmentExternalId/departmentName; other changes still request Auth-stale.

ProfileSyncIntent records immutable request IDs/hashes, sourceVersion and minimal
provider bodies; uniqueness is (profileId,sourceVersion,destination), with a
unique requestId and an (authId,sourceVersion) index. The parent owns delivery and
its latest-required-intent status projection. No delivery network call occurs here.

The additive Core migration creates profile_workflows and profile_sync_intents
without touching existing baseline SQL. Maintained Core schema and Core bootstrap
fragment both include these models. No migrations are applied by this change.

## Verification and Remaining Gates

Focused local command: `node --import tsx --test test/eda-profile.test.ts`.
Typecheck after coordinated Core-only client generation:
`node_modules/.bin/tsc -p tsconfig.json --noEmit`.

Tests cover strict actor/scope/resource checks, independent admin DB membership,
default-off writes, local/Auth ID distinction, canonical hashes, distinct step
IDs, durable replay, receipt forgery, one-time/version binding, transient inputs,
Auth-attested provisioning, verified departments, admin revocation, audit/
sync effects, honest pending status and transaction rollback. Structural mocks
do not replace PostgreSQL serializable-concurrency or signed mTLS/provider E2E
acceptance. Parent app/callback wiring, broker/delivery acceptance and Web writer
cutover remain separate work. No commits, deployment, DB reset or container
verification are performed here.
