# Messaging Retention And Legal Holds

This is a disabled-by-default backend checkpoint, not release acceptance or
approval to delete records. Appointment business rules and message bodies are
not administered through the hold interface. No shared database was reset,
migrated, scanned or purged during implementation.

## Exported Integration Contracts

`createMessagingRetention(pool, environment, clock = Date.now).tick(signal?)`
returns `{ enabled, mode, scanned, eligible, purged, completed, aborted, busy }`.
The clock returns Unix milliseconds. Counts describe only this tick; no patient
IDs, object references or message content appear in worker reporting.

One tick processes at most 100 conversations sequentially, yielding after a
ten-second budget before starting another conversation. An in-flight transaction
still has its database lock/statement deadlines. The shared worker
may call it periodically: the persisted schedule admits a new scan only 24 hours
after the previous scan finishes. An unfinished scan continues from its
committed cursor on the next tick. A scan records an upper ID fence so new
conversations do not extend it indefinitely; missed new IDs are covered by the
next daily scan. A singleton row seeded by migration holds progress and a
60-second, owner-fenced lease. Every per-conversation transaction renews the
lease with progress. A stale worker cannot commit progress or clear a new
worker's lease. Graceful shutdown stops before the next conversation; abort
observed before progress commit rolls back that conversation.

Both `VITAL_EDA_MESSAGING_ENABLED=true` and
`VITAL_EDA_MESSAGING_RETENTION_SCAN_ENABLED=true` are required to scan. Otherwise
`tick` is a no-op, including when encryption configuration is absent. Scanning
also requires a valid Messaging keyring. Dry-run is the default. Actual deletion
requires all three of:

- `VITAL_EDA_MESSAGING_RETENTION_ENABLED=true` (explicit deletion activation).
- `MESSAGE_RETENTION_APPROVED=true` (explicit policy approval).
- `MESSAGE_RETENTION_POLICY_APPROVAL_ID` referencing recorded policy approval,
  using a nonempty bounded identifier, at most 96 characters.

These settings remain off/unset at checkpoint exit. An approval identifier is
not itself evidence of legal approval; deployment owners must verify its
underlying policy record, backup expiry and key-retention obligations before
activation. Disabling only deletion retains safe dry-run scanning.

`createMessageHolds(pool, environment = process.env)` exports:

```ts
list(actor, {
  limit?: number, // 1-50, default 50
  appointmentId?: string,
  conversationId?: string,
  holdState?: "all" | "held" | "unheld",
  before?: { createdAt: string, id: string }
})
place(actor, conversationId, { operationId, requestHash }, {
  expectedVersion, reasonCode, reference
})
release(actor, conversationId, { operationId, requestHash }, { expectedVersion })
```

List requires `messaging.admin.list` bound to `actor.authId`; place/release require
`messaging.hold.place`/`messaging.hold.release` bound to the conversation UUID.
The router must continue enforcing process mTLS, validated short-lived actor
assertions, canonical transport hashes and default-off module/admin flags.
These modules do not implement a second authentication boundary.

All calls independently require an actor role of `admin` and a current Core
`vital_admins` membership joined to `vital_users` on local user ID and matching
Auth UUID. Independent membership is authoritative even when a different role
was materialized most recently on `vital_users`. SuperAdmin assertions do not bypass
this requirement. Transactional share locks protect membership during the call.
Admin metadata never grants conversation-body access.

List returns `{ conversations, nextCursor }`. Each item is exactly
`{ id, appointmentId, patientId, doctorId, status, scheduledAt, createdAt,
lastMessageAt, legalHoldAt, reasonCode, reference, version }`. Dates are ISO
strings; nullable metadata is `null`. Patient/doctor IDs are Core local IDs, not
Auth UUIDs. Exact filters intersect. Stable pagination orders by creation time
and ID descending; the cursor denotes the last returned item. Reference data is
decrypted only for the authorized admin response, not audit or logging.

Mutation results contain only
`{ conversationId, version, holdId, legalHoldAt }`. Command results retain that
minimal receipt, never references or bodies. Identical retries return that
receipt after rechecking current authority. Changed action, resource, input or
transport hash conflicts. Input fields are strictly allowlisted; expected
versions are required for new mutations.

## Retention Rules And Persistence

The ten-year calculation preserves the legacy rule; it does not assert a legal
retention requirement. Only `completed`, `cancelled` or `rescheduled`
appointments qualify. Closure is `completedAt` for completed appointments and
`updatedAt` otherwise. Missing completion timestamps prevent expiry. The latest
of closure, the patient's latest completed visit with **any doctor**, and the
last message is advanced ten UTC calendar years using `setUTCFullYear`, including
its existing leap-day behavior. A legal hold always prevents expiry.

The implementation reads Appointment state through its owner lock/read
interface. Locks follow doctor calendar, appointment row, conversation row.
The shared helper uses READ COMMITTED so statements after advisory-lock waits
observe newly committed owner state. It retries SQL `40001`/`40P01` at most three
times. Completion and purge share a patient-level retention fence; purge reads
fresh latest-visit evidence after acquiring it, including visits with another
doctor. Hold/purge and send exclusion use the conversation/calendar locks.
Bounded lock/statement timeouts prevent indefinite waits. Actual concurrency
remains a real PostgreSQL acceptance gate, not proven by fake SQL tests.

Additive migration `202610150002_messaging_ownership` introduces:

- Conversation `purgedAt` and a creation/ID index. Source versions live in the
  per-Appointment fence, not an incomparable conversation-wide counter.
- `message_legal_holds`: minimal placement/release history and encrypted
  references; a partial unique index enforces one active hold per conversation.
- `message_purges`: one minimal receipt per conversation with expiry/purge times,
  removed-message count and resulting version.
- `message_retention_scans`: singleton scheduling, recoverable cursor and lease.
- `messaging_eligibility_sources`: per-Appointment source-version fencing for the
  main lifecycle consumer. Versions of unrelated Appointment aggregates must not
  be compared. References are scalar and the consumer must validate owner facts.

Purge deletes `appointment_messages`, clears both conversation read timestamps
and increments its version. It retains the conversation tombstone, appointment,
hold history, command references and central audit evidence. A database check
prevents a tombstone having read receipts or an active hold. Main message
send/replay/read handlers must honor `purgedAt`; they must not create replacement
messages from retained command references. There is no physical conversation
delete or appointment mutation.

Holds prevent deletion only. They do not reopen messaging, extend clinical
access or change retention dates. Release restores ordinary retention checks;
it does not immediately purge. Already purged conversations reject new holds
with `410 MESSAGE_CONVERSATION_PURGED`. Missing or conflicting versions return
`409`. Legacy `legalHoldAt` remains authoritative even when no new history exists;
release then fails with `MESSAGE_HOLD_HISTORY_REQUIRED` rather than guessing or
using the unused legacy plaintext `legalHoldReason` field.

Reason codes are `legal_request`, `investigation`, `records_review`. References
are 1-96 characters matching `[A-Za-z0-9][A-Za-z0-9._/-]*`: identifiers only, not
clinical prose. AES-256-GCM references use the shared versioned Messaging keyring
with AAD bound to `messaging-hold:<conversationId>:<holdId>`. Old keys must remain
available for retained hold history. Missing keys and ciphertext substitution
fail closed.

## Main Worker, Privileges And Audit Wiring

Keep a single shared worker; do not add a retention process or competing retry
mechanism. Its abort signal should reach `tick`. Keep scan/deletion flags off in
runtime examples until authorized activation. Initial-only bootstrap generation
must retain conversation additions/relations; do not rerun it over maintained
schema files or rewrite previous migrations.

API roles need SELECT/INSERT/UPDATE on hold history, the existing command/outbox
tables and conversations. Worker roles need SELECT on Appointment/Profile tables,
SELECT/UPDATE on conversations and scan progress, DELETE on messages, and INSERT
on purge receipts/outbox. The source-version consumer needs SELECT/INSERT/UPDATE
on `messaging_eligibility_sources`. Restrict table operations by process where
the existing provisioning supports it. No runtime DDL or cross-database access
is needed. Migration seeds the singleton; runtime cannot manufacture one when
the migration is missing.

Outbox emission uses `appendSqlOutbox` and the existing strict
`vital.audit.requested` schema. Central action mappings must accept:
`vital.message.hold_placed`, `vital.message.hold_released`, `vital.message.purged`.
Only conversation ID/version, authenticated actor UUID (null for maintenance),
correlation and resource type enter audit delivery. No reference, reason text,
message body or ciphertext enters events/journals/logs. No lifecycle source fact
is republished and no legacy `MessageAuditEvent` writer is used.

## Verification Evidence And Remaining Gates

`test/eda-messaging-retention.test.ts` exercises actual exported modules with a
transactional fake SQL fixture. Eighteen focused tests passed; one opt-in isolated
PostgreSQL schema/privilege test was skipped. Fixtures do not prove database
locking, serialization, migration execution or broker delivery. No live purge
was performed.

Scoped strict TypeScript checking passed for both modules and the test file;
Core Prisma DMMF validation passed without code generation or database access.
The existing ESLint configuration does not match TypeScript files, so its
ignored-file warnings are not lint coverage or a claimed TypeScript lint pass.

The test catalog entry should use:

```sh
node --import tsx --test --test-concurrency=1 test/eda-messaging-retention.test.ts
```

Coverage: legacy UTC expiry/latest visit; encrypted references and replay
reauthorization; command/version/active-hold conflicts; admin isolation and
SuperAdmin denial; release history; stable metadata pagination; outbox rollback;
flags/keys fail closed; bounded daily dry-run and approval requirements; holds
and cross-doctor recent visits; tombstone purge/reprocessing; purge rollback;
expired lease recovery; shutdown/live-lease denial; owner lock ordering; bounded
serialization/deadlock retries.

The opt-in test additionally requires `EDA_TEST_ENABLED=true`,
`EDA_TEST_MESSAGING_ENABLED=true`, `EDA_TEST_ISOLATED=yes`, verified TLS and the
restricted `vital_core_worker` identity on `postgres:5432/vital_core_test`. It
checks schema constraints and runtime privileges without writing data. It does
not authorize shared or development database targets.

Before activation, isolated real PostgreSQL tests must demonstrate concurrent
hold/purge/send, cross-doctor completion/latest-visit races, expired leases,
crashes before/after progress and outbox commits, and duplicate/reordered source
versions. Actual broker/inbox, API mTLS/delegation, policy evidence, backups/key
rotation and shared resource usage remain coordinated release gates. Main owns
runtime/router/worker and root catalog/report updates; SSE remains a later phase.

## Exact Test Names For The Root Catalog

- Messaging retention preserves ten-year UTC closure/latest-visit/message calculation
- Messaging holds encrypt references, journal only IDs, and reauthorize identical retries
- Messaging holds reject changed command hash, stale versions, and competing active holds
- Messaging holds require exact scopes/current Core admin and deny SuperAdmin bypass
- Messaging hold release is versioned/idempotent and preserves minimal encrypted history
- Messaging hold list has bounded stable tie pagination and exact metadata filters
- Messaging hold outbox failure rolls back mutation, history, and command result
- Messaging retention flags off and missing keys never touch the database
- Messaging retention defaults to daily bounded dry-run and requires every purge approval
- Messaging retention retains held/recent-visit conversations across any doctor
- Messaging retention purges ciphertext/receipts only and fences tombstone reprocessing
- Messaging retention purge/outbox failure rolls back ciphertext and durable cursor
- Messaging retention resumes an expired lease without replaying scanned progress
- Messaging retention honors shutdown and an existing live scanner lease
- Messaging hold/purge lock order uses calendar then appointment then conversation
- Messaging transactions retry serialization/deadlock without duplicate effects
- Messaging retention yields its time budget without skipping durable progress
- Messaging isolated retention schema enforces active holds, tombstones and restricted worker privilege (not executed)
