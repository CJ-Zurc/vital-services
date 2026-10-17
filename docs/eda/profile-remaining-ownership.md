# Bounded Profile Completion Checkpoint

Follow-on: [public registration provenance](registration-provenance.md) now adds
the independently verified pre-OTP handoff. The authenticated bootstrap below
remains separate. This addition does not imply activation/runtime acceptance.

Disabled-by-default code, not completed extraction/cutover. No entrypoint,
global mode policy, Appointment, Messaging/SSE, schema/migration, CI or deployment
changes. Only the authorized `Profile Completion` root catalog section was added.
Existing dirty checkpoints are retained. Docker is
unavailable; no provider operations or listening services were started.

## Schedule Availability Interface

`modules/profile/profile-schedule.ts` exports `ProfileAvailability`,
`ScheduleAvailabilityInput`, `ScheduleAvailabilityResult`,
`ScheduleAvailabilityUpgrade`, and `upgradeScheduleAvailability`:

```ts
await upgradeScheduleAvailability(tx, actor, { doctorId, consultationType, resource });
// {doctorId, availabilityType: 'virtual' | 'in_person' | 'both', changed}
```

Appointment must call inside its existing signed, replay-journaled command and
calendar transaction, after authorizing the schedule and validating slot/QR
prerequisites. Resource is own Auth UUID on create or authorized schedule UUID
on update. Profile does not own schedule reads/writes or transaction commits.
Caller failures must escape and roll back the entire transaction.

Requires doctor role, `appointments.schedule.write` and exact resource;
independently locks and verifies matching current Core user/doctor membership.
Unconfigured availability fails closed. Compatible availability is a no-op;
unsupported consultation type (including a `both` slot) upgrades to `both`.
It never downgrades availability or changes fees, specialty, rating or roles.
An update increments Profile version and journals the existing Profile fact,
audit intent, Auth-stale sync intent and sync-request outbox event. No new event
type or EHR mirror. Caller journal provides command replay.

Appointment now calls this interface for schedule creation and updates, inside
the existing command/calendar transaction after interval/overlap checks. Focused
integrated tests exercise replay and rollback of both owners' changes. It does
not activate target flags or establish real database lock acceptance.

## Registration And Consent

`POST /internal/v1/profile/registration/bootstrap` requires a current delegated
patient actor, `profile.registration`, exact own Auth UUID resource, signed
command metadata, strict body `{consent_accepted:true}`. No submitted target,
credentials, names, email, authority, receipt or Prisma options are accepted.

`bootstrapRegistration` uses the existing serializable command transaction and
bounded retry. It creates only the caller's patient marker and registration
ConsentRecord; new onboarding/EHR record availability remain false. Existing
non-patient role or retained doctor/admin marker conflicts, never demotes or
deletes. Corrupt patient linkage is rejected. Accepted registration consent is
retained without changing time; latest declined consent requires review, not
automatic reacceptance. Appointment-associated consent is not registration.

New marker/consent changes increment version and write existing materialization,
audit/Auth-stale effects atomically with the command result. Exact signed replay
returns its stored result; a fresh matching request does not duplicate consent
or effects. Any effect failure rolls back marker, consent, version and command.

This is explicit authenticated consent/access bootstrap, NOT anonymous Auth
registration. Auth owns credentials, identity creation, verification and roles.
Never automatically call this consent command from login/session materialization.
Core does not infer consent from login, an Auth UUID or a browser identity.

Legacy `/api/auth/register` mutates Auth then directly creates Web marker/consent
before OTP verification. Its target branch remains blocked: that response is
neither a verified session nor a durable Auth registration receipt. Preserving
the pre-verification local-ID response needs a reviewed Auth-to-Profile durable
handoff, or an approved post-verification product flow. No synthetic receipt or
service-role bypass was added. Public-registration parity is NOT complete.

## Assets And Configuration

Doctor/patient picture routes proxy Auth-owned pictures via Gateway. Preserve
those contracts; Core does not copy Auth images or credentials. Legacy QR upload
writes public local-disk images and stores DoctorQr.filePath; it must not become
the replacement backend storage implementation.

Records already has real immutable S3 quarantine/final storage, byte/hash checks,
validation/scanning and durable processing. These are Records-purpose/owner
bound, not Profile receipts. Arbitrary Records UUIDs/keys/URLs are not proof.
In particular, `RecordsFileAsset.patientId` is a required patient relation;
using it for doctor-owned QR would fabricate patient ownership. Sharing its
processing primitives does not remove the need for a proper Profile owner model.

Before migrating uploads, coordinate durable ProfileAsset/operation metadata
(owner, purpose, state, immutable key/hash, MIME/size, scan result, retry/recovery
binding) and ready-asset linkage to Profile/DoctorQr. Reuse secured primitives
with reviewed namespace/IAM, authorization and lifecycle. Missing storage/scanner
must fail closed. `DoctorQr.filePath` alone cannot prove ready/scanned bytes.
No schemas/migrations, fake storage/receipts, local-disk replacement or fake
ready-QR flag were added. Asset migration is deferred pending parent agreement.

SystemContent is a dormant model; no live Web content/config route was found.
Do not expose arbitrary config/secrets as Profile settings or invent a DTO.
Existing doctor settings remain the strict Profile patch/workflow allowlists.

## Verification And Catalog Handoff

Exact new backend Node test functions in `test/eda-profile.test.ts`:

- `profile registration: bootstrap and consent commit once with signed replay`
- `profile registration: authorization and strict consent input precede database access`
- `profile registration: existing doctor and admin markers cannot be replaced`
- `profile registration: declined consent is not silently overwritten`
- `profile registration: outbox failure rolls back marker consent and command`

Exact new functions in `test/eda-profile-schedule.test.ts`:

- `profile schedule: opposite and hybrid slot types upgrade availability with durable effects`
- `profile schedule: compatible availability produces no writes or effects`
- `profile schedule: role scope resource and current membership fail closed`
- `profile schedule: effect failure escapes to the enclosing appointment transaction`

Commands that do not open ports:

```sh
node --import tsx --test --test-name-pattern="profile registration:" test/eda-profile.test.ts
node --import tsx --test test/eda-profile-schedule.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

Nine new backend cases, 15 additional non-HTTP Profile regressions, ten existing
Profile synchronization cases, and backend TypeScript passed. Together with
three Web cases, this is 37 focused passing cases. These are transaction
fixtures, not real PostgreSQL SSI/locks, RabbitMQ, mTLS or storage acceptance.
Backend ESLint currently ignores TypeScript; not counted as verification.
All nine names plus three Web cases are registered under `Profile Completion`
in the root `docs/backlogs/UHSE_Automated_Unit_Tests.md` per parent authorization.
Parent must add integrated schedule/registration fault tests before activation. Companion Web
doc lists its three new cases. No live or whole-migration acceptance claim.
