# Revised EDA Implementation Status

Updated: 2026-10-17. Status: default-off domain checkpoints plus composed reads,
SSE and coordinated release tooling; not cutover-ready. Historical phase evidence
is dated below. Current completion evidence is in the root implementation report.

## Development Checkpoint Organization

The candidate groups business owners under `src/eda/modules/appointment`,
`payment`, `profile`, `records`, `video`, `messaging`, `portal-integrations`,
`platform-delivery` and `composition`. These are modules in the same API/shared
worker deployment, not new microservices or databases. Core and Integrations
schemas and additive migration histories remain under `prisma/`.

Profile owns doctor/patient configuration, onboarding, registration and consent;
Records owns VITAL clinical documents and snapshots. Composition calls typed
owners rather than embedding Profile SQL. HTTP receipt transport is infrastructure;
EHR case recovery belongs to the Appointment adapter boundary. Old `modules/core`
and `modules/integrations` paths and forwarding shims are removed. Layout tests
check relative NodeNext imports and exact Linux filename casing.
Builds also clear only the verified repository `dist` directory before compiling,
refusing a linked output directory, so retired compiled paths cannot linger.

Records patient-directory and episode-history reads now use private snapshot-
fenced pages (default ten, maximum fifty). Web exhausts them within its existing
30-second/16-MiB budget, validates the final snapshot and rejects incomplete
responses. This removes silent 200/100-row truncation without changing browser
arrays. Explicit clinical snapshot and stream safety limits remain errors, not
silent truncation. See `records-ownership.md` for the private contract.

The disposable schema-fragment bootstrap tool is retired. Maintained Core and
Integrations schemas/migrations remain authoritative; no migration was applied.
One-time baseline recording/generation scripts are retired; accepted schemas,
additive migrations and immutable baseline evidence remain in Git. Source
verification is not infrastructure acceptance.

`docs/eda/route-current.json` is generated on demand by `npm run eda:inventory`
and ignored rather than committing a large reproducible test/report artifact. Each
method has an explicit owner/authentication/DTO/dependency review with source
fingerprints. Unknown routes, altered evidence or rejected dispatch policy
require review rather than inheriting acceptance. The paired source check is
`node --import tsx --test test/contracts/route-contracts.test.ts`; it requires
the compatible `vital-web` sibling checkout. Standalone `npm test` intentionally
does not depend on that second repository. The Linux paired-source CI job uses
an explicit full Web commit SHA and cannot infer compatibility from a mutable
development branch. Static review never substitutes for live route/UI acceptance.

EHR baseline correction: fetching remote refs revealed the initial worktree was
118 commits behind. The authoritative implementation worktree is now
`../eda-worktrees/UHSE_EHR-current` on `eda/vital-transition-current`, starting
at `d6795dc`. The older EHR worktree is a superseded checkpoint. Its test results
do not prove current-baseline compatibility. Original EHR local Compose changes
remain untouched. The revised patch retains assigned-doctor and expired-patient
guards, enriched DTOs, current migration ancestry and global reference uniqueness.

Authority: `C:/Users/User/Downloads/EDA_TRANSITION_PLAN_REVISED.md` plus the
approved implementation sequence in the task. The older separate-microservice
plan is not the target. Commits, pushes, PRs, staging deployments and shared
database resets remain user-owned and have not been performed.

## Implemented Foundation

- Development-based extraction inventory: 105 Web route files and 37 source
  Prisma models. Route authentication flags are scan hints, not audited policies.
- Fresh Core/Integrations schemas, separate migration configs and baseline SQL;
  cross-database relations removed. No migrations applied to shared databases.
- Outbox/inbox in both databases, command replay records, aggregate versions,
  saga/participant/slot-reservation scaffolding and payment/video projections.
- Node.js 22 target, TypeScript compilation, two Prisma clients, one API and one
  worker entrypoint. Current legacy `npm start` is unchanged.
- Strict content-minimal event catalog, own-module producer checks, payment
  aggregate/version binding and bounded message size.
- Mandatory persistent publication, publisher confirms, returned-message checks,
  recoverable SQL claims, consumer inbox/effects before ACK, delayed retries,
  bounded DLQs and graceful consumer shutdown.
- BFF actor verification requires process mTLS plus RSA-signed, audience-scoped
  action/resource delegation, canonical request hash and UUID operation ID,
  with at most 60 seconds lifetime and five seconds clock skew.
- Profile self reads/materialization/emergency contacts and doctor fees/onboarding,
  independently authorized admin provisioning/specialty and membership queries.
- Core-owned workflow preparation/status/commit binds actor, target, kind, input
  hash, separate command IDs and expected Profile revision. Minimal verified
  EHR/TRACE/Auth receipts commit with Profile state, command result and outbox.
- One owned synchronization path: committed Core intents, minimal RabbitMQ facts,
  Integrations inbox/delivery records and the existing worker's recoverable leases.
  Scoped Auth-stale and version-fenced EHR doctor-mirror receipts converge latest
  required revisions to pending/failed/synced. One audit-intent path per mutation.
- Web Profile/session/role adapters, strict v1 DTOs and source-session-bounded
  assertions are implemented behind default-off target gates. Missing target
  dependencies fail closed; unmigrated operations cannot fall back to Web Prisma.
- Initial migration SQL restored from pre-Profile Services commit
  `3bbc8f6196e1e426a7f24d26dd4792f12678afb4`, followed by additive Profile migrations.
  Offline schema generation now supplies explicit Prisma configs and verifies
  output existence; a regression checks every owned table is created once.
- Central audit/notification delivery ledger scaffolding and safe retry codes.
- Production and test payment app factories consolidated. Sandbox-only provider
  credentials and ambiguous-outcome non-retry behavior are enforced.
- Payment owns Integrations ledger/operations, reconciliation and invoice metadata;
  Core Appointment owns first-authorized frozen quotes and preparation/owner intents.
  Additive migrations introduce unique lineages/provider IDs, execution/retrieval
  leases, review state and historically reusable payment projections.
- Private v1 Payment patient APIs and internal-only independently authorized admin
  review use existing mTLS/assertion trust. Web POST/PATCH adapters reject financial
  browser authority and preserve session cookies; target mode never writes legacy
  payment persistence. All Payment flags remain false by default.
- The existing worker reconciles known IDs every 60 seconds with bounded batches,
  concurrency two, shared refresh leases and backoff. Unknown writes never repeat.
  Paid/refunded facts remain monotonic; late payments require review, no revival.
- Payment consumers now commit inbox/projection only, with committed outbox and
  association checks. Automatic appointment confirmation, lifecycle logs and
  duplicate audit emission are removed from the target consumer. One content-free
  Payment audit-intent path maps seven reviewed central actions.

## Not Yet Accepted

Live Appointment calendar/workflow/saga behavior, Payment provider/database
acceptance, Profile Auth-stale/doctor-mirror convergence and Records storage/
snapshot acceptance remain required. The Meet backend checkpoint now exists;
live quota/provider parity is not accepted. Encrypted Messaging and SSE ownership
are subsequent code phases. Do not remove old Web
persistence or enable incomplete target traffic yet.

Payment's projection-only consumer and Appointment's separate lifecycle consumer
remain distinct. The real Payment association participant and Records Core hooks
now exist, with the Video participant available only when separately configured.
Unaccepted Video/composed-view operations remain gated. Private financial effects
require committed owner evidence, and invoice PDF/storage/screens remain deferred.
Local coordinator/lease/transaction fixtures do not prove real database races,
broker handover or network trust. Profile delivery is implemented but not
accepted live.

Gateway/Web trust, platform ingestion, EHR idempotency, isolated Compose and
Web mTLS transport have code checkpoints; their own reports/tests and live
acceptance remain required before enabling traffic. The Profile route/DTO and
authorization overlays have phase manifests; inventory scan hints alone are not
proof of completed route review or browser compatibility.

## Historical Profile/Payment Verification

Both Prisma clients generate; baseline SQL was produced without DB access.
Current full backend suite: 138 passed, zero failed, one explicitly skipped live
PostgreSQL/RabbitMQ suite. The final focused Payment rerun passed all 30 cases.
Backend build/typecheck, Payment/live-test fixture typecheck and ESLint passed.
The opt-in suite adds three real Payment DB/broker/mTLS scenarios, not executed.
Web full
suite: 208 passed, two database-dependent skips; 54 scoped Payment/Profile/transport
cases passed. Current Next.js Webpack production build and normal project
typecheck passed. The default Turbopack attempt stalled and was stopped; default
engine/Node 22 CI acceptance remains pending. A temporary narrow typecheck
omitted existing ambient declarations and was removed; normal project
typechecking passed outside the sandbox. Web EDA lint has no errors and one existing
unused disabled-transport parameter warning. Current Payment Web verification
evidence is recorded in its phase report; do not substitute older results.
Fresh build validation also required separating the existing embedded records
view from its Next.js page entrypoint. Business/records ownership remains unchanged.
EHR Profile operations: 63 passed; existing case/integration/roles/schema
regressions: 66 passed. Auth scoped Profile tests: 73 passed; existing lookup,
role, SSO and configuration regressions: 22 passed. Changed Auth/new EHR Profile
files pass Ruff. These are SQLite/mocked transport/Redis fixtures, not live
owner transaction or Redis Lua evidence. Node locally is 24; CI/Docker target
22 must also pass.

Notification agent verification: 48 scoped-ingestion/migration tests passed and
PostgreSQL DDL generation passed. Current Audit verification: 325 full mocked
service tests passed, including 276 scoped-ingestion cases; changed-file lint
passed. Their reports document fixture boundaries and outstanding
live-database evidence. These are not claimed as full ecosystem acceptance.
Payment-phase focused Audit ingestion/legacy contracts: 468 passed through the
isolated parent runner; seven resource-bound mappings use mocked persistence.
Gateway full mocked-service regression: 171 passed. New streaming/route test
files passed Ruff; a pre-existing nested conditional in the touched client file
remains a full-lint finding. Query preservation, final hop-header stripping and
shared-cookie-jar isolation were corrected and tested. Live ingress/browser/SSE
and source-version/role-scope acceptance still remain pending.

Offline Compose rendering and Git Bash script syntax checks passed. No images
were built locally. Dedicated CI now explicitly runs the isolated integration
bootstrap; the normal unit job explicitly skips that live suite rather than
silently claiming transport evidence.

Docker's Linux engine is unavailable and the user approved continuing without
container tests for now. Real PostgreSQL/RabbitMQ, migrations/role grants,
quorum-queue behavior, fault injection, end-to-end ingress/SSE, provider sandbox
evidence and the 8-GB resource observation remain pending. Mock tests do not
replace these checks. No external provider actions were performed.

## Appointment Checkpoint (2026-10-13)

Implemented additive Appointment/calendar/workflow/saga persistence and private
APIs, guarded Web adapters, committed financial intents, the real Payment
prepare/abort/finalize participant, a separate paid-confirmation inbox and
outbox-driven saga wake-up consumer in the existing worker. Core owns lifecycle,
reservations and counters; Integrations owns financial/provider identity and
freezes. No cross-database FK or temporary legacy writer bridge was added.

Philippine overnight calendar checks cover committed occupancy, reservations and
date blocks under one doctor lock. Expired proposals release their uniqueness
fence using existing rejected status. Completion rechecks proposals/current paid
evidence; repeated acknowledgements cannot extend deadlines. Schedule removal
or timing/type edits use the full doctor cancellation contract. Publishing-only
edits do not cancel bookings. Late financial observations remain review-first.

Approval/follow-up use durable external-start and scoped read-only EHR receipt
recovery; no blind repeat of clinical creation. Committed replay uses the stored
command result without another EHR lookup. Payment checkout runs after approval
with an explicit warning for failed/unknown preparation. Provider-origin identity,
quote and historical financial evidence remain unchanged on reassociation.

At the Appointment-only checkpoint, Records/Video participants were absent;
the subsequent Records checkpoint below adds the real Records owner. Flags remain
off, and missing participants are never placeholders. Required lifecycle effects
and composed browser views return
503 before their replacements are ready. Messaging/SSE/full composed views and
Profile schedule-availability upgrades remain explicit dependencies. Keep Web
Prisma and legacy flag-off branches until full replacement parity and cutover.

Current backend suite: 172 passed, one isolated integration skip. The actual
coordinator was tested at seven Core rollback boundaries, pre-pivot abort and
post-pivot recovery. New worker inbox/command tests and real Payment association
tests pass. These are transaction/transport fixtures, not real PG locking proof.
Current Web suite: 216 passed, two DB-dependent skips. Audit focused ingestion:
473 passed; changed Audit files pass Ruff. Full backend build and existing lint
configuration passed. The existing backend ESLint config covers JS/MJS, not TS;
TypeScript is checked by the strict build, not claimed as ESLint coverage.
Current production Webpack build and normal Web TypeScript check passed. Scoped
Web lint has no errors and one existing disabled-transport parameter warning.

Added isolated real PG calendar contention, broker confirmation/forward recovery
and actual mTLS Appointment scenarios. They are NOT EXECUTED; the user retained
runtime-validation deferral. Real migrations, leases/concurrency/crash testing,
provider sandbox evidence, full UI/DTO/ingress/SSE, Node 22 CI, resource observation
and rollback rehearsal are coordinated-release gates. No shared reset, provider
action, port change, commit/push/PR or deployment occurred.

See `appointment-lifecycle.md` and `vital-web/docs/eda-appointment-phase.md` for
the actual readiness/route/receipt/authorization catalog and cleanup boundaries.

## Records Checkpoint (2026-10-14)

Records now owns encrypted episode snapshots, local evidence freezes, medical
document issuance, file quarantine and access-link authorization. Additive Core
history is retained; no migration was applied. Real Records lifecycle effects
replace the missing participant when configured. Video remains unavailable, so
Video-dependent operations still fail closed. Legacy Web persistence remains
only for flag-off compatibility and unextracted owners.

Canonical issuance and artifact work are committed before rendering/storage.
The shared worker uses a database-fenced global capacity-one lease, bounded
validation, exact-byte ClamAV evidence and immutable final object identities.
Missing scanner/configuration never means clean. No scanner daemon is installed.
Snapshot provenance uses dedicated short-lived EHR receipts and RFC 8785 hashes;
receipt tokens, clinical bodies and capabilities are excluded from durable events.

Backend regression evidence: 241 passed, one opt-in live-suite skip. Build,
source/test TypeScript and existing JS/MJS lint passed. Auth scoped contracts:
139 passed. Audit ingestion contracts: 485 passed; changed files passed Ruff.
Representative PDF visual evidence is recorded in `records-artifacts.md`.
These are local checkpoint results, not PostgreSQL concurrency or live transport
acceptance. Web/Gateway/EHR verification is tracked in their owned phase reports.

Web's full suite passed 240 tests, with two existing live-database skips; 24
Records-specific cases passed. Production build and normal project TypeScript
passed, including a nonincremental host recheck; sandbox-only dependency-export
diagnostics were not reproduced. Scoped Web lint had no warnings. Gateway passed
203 mocked-service regressions and changed-file Ruff/diff checks. See the Web
Records verification report for commands, scopes and pending live evidence.

EHR Records/native clinical idempotency checks passed 56 cases, with 156 existing
integration/Profile/case/role/schema/recovery regressions (212 total). Ruff,
diff checks and actual Node/Python hash vectors passed. Full-patient snapshot
evidence requires specific open outpatient authority and current Auth eligibility;
closed-case assignment never grants live history. Tests are SQLite/mocked Auth,
not live PostgreSQL or Gateway acceptance.

Test files are serialized by default after a concurrent local run hit the PDF
worker startup deadline under host contention. The final serialized full suite
passed; parser/scanner runtime deadlines were not increased. This is a test-runner
resource bound, not proof of production capacity or permission to bypass limits.

Six additional isolated Records scenarios cover real database, broker, mTLS,
optional MinIO and native scanner boundaries. They are NOT EXECUTED. Runtime
flags remain off. Existing dependency advisories, Node 22/Linux validation,
storage IAM/encryption, scanner/font capacity, full ingress/UI parity, ecosystem
resource headroom and rollback rehearsal remain activation gates. No shared
reset, provider action, deployment, port change, commit, push or PR occurred.

See `records-ownership.md` and `records-artifacts.md` for ownership, route,
authorization, security and artifact contracts.

## Video Checkpoint (2026-10-14)

The additive Core/Integrations Video histories preserve earlier migrations.
Core persists the meeting selection hash and preparation/finalization receipt;
Integrations owns OAuth state, encrypted credentials, provider operations,
stable-lineage quotas, generated resources and association holds. Neither DB
contains cross-database foreign keys. Historical consultation data stays on its
originating appointment; replacement consultations use scalar Video pointers.

The private API requires the existing process mTLS and resource-bound actor
assertions. The same worker recovers committed finalizations and stale attempts.
Unknown writes are not repeated. Read-only known-resource recovery requires
current doctor authority and a known provider identifier; missing IDs remain
uncertain. Backend enforcement adds two provider starts per doctor/purpose
lineage while retaining five/doctor and fifty/application per minute. Refresh
and reconnect never reset that quota. OAuth secrets no longer persist VITAL
session tokens; command results and events contain no credentials or links.

Approval/follow-up prepare the real Video selection before EHR transport. Core
commits a durable finalization request; browser success/checkout wait for Video.
Reschedule prepares, pivots then finalizes without generating another room.
Only durable abandonment/compensation can release prepared resources. Manual
fallback retains syntax validation, not a Google ownership claim.

`VITAL_EDA_VIDEO_ENABLED`, `VITAL_EDA_VIDEO_MAINTENANCE_ENABLED` and
`VITAL_VIDEO_GOOGLE_ENABLED` default off. Web target routes are thin adapters;
flag-off legacy handlers remain. UI files and UHSE_AUTH login are untouched in
this phase. No new containers, provider actions, migrations, resets, deployments
or commits were performed. Verification evidence is recorded in the root report;
this is not release acceptance. Next: Messaging retention/legal holds, then SSE
and composed-response parity, then coordinated runtime acceptance.

Final checkpoint verification: backend 288 passed / 1 isolated suite skipped;
both clients/source build, strict changed-test TypeScript and existing JS/MJS
lint passed. Web 262 passed / 2 DB skips; 22 focused Video tests, production
build (124 pages), normal nonincremental host TypeScript and scoped ESLint passed.
Audit ingestion 498 passed plus changed-file Ruff. All 119 Web UI source files
match the pre-phase hash. Three real isolated Video scenarios are implemented
but NOT EXECUTED; provider transport is a fixture. See the root report for
commands, sandbox/launcher restrictions and remaining acceptance gates.

## Messaging Ownership Checkpoint (2026-10-15)

Default-off Core Messaging now owns encrypted conversations/messages, participant
history, read receipts, sender throttling, Appointment-chain access and hold/
retention processing. API and worker share the existing process topology.
See [ownership/manifest](messaging-ownership.md) and
[retention controls](messaging-retention.md).

Web target handlers are signed mTLS adapters with versioned DTOs. Approved UI
changes are limited to retry/draft/scroll/read reliability and metadata-only
admin hold management. Capability flags are server-only request-time values;
legacy mode preserves its existing SSE, while target mode uses polling until
the real SSE owner is extracted. Browser policy has no server transport imports.

Messages and hold references use versioned AES-GCM protection. Command journals
hold IDs/references only; audit/broker payloads never contain bodies, ciphertext,
case references or credentials. Independent Core admin markers are authoritative.
Fresh reads after calendar-lock waits gate sends during lifecycle/saga changes;
completion and purge share a patient fence across doctors. Retention remains
dry-run until explicit activation plus recorded policy approval. New migration
history is additive; it has not been applied to shared infrastructure.

Code/fixture verification is recorded in the root implementation report. Real
PostgreSQL/RabbitMQ/mTLS concurrency, migration/scanner/provider/ingress evidence,
Node 22/Linux, resource headroom and rollback remain release gates. No commits,
deployments, shared resets or actual retention deletion occurred.

Final regression evidence: 317 backend tests passed / 2 runtime skips; source
build/typecheck, strict Messaging tests/helper TypeScript and existing JS/MJS
lint passed. Web 285 passed / 2 DB skips; production build, normal typecheck,
scoped lint and 7 isolated browser scenarios passed. Audit 507 and Gateway 48
focused regressions passed with changed-file Ruff. Local Node is 24.12.0; do not
infer Node 22/Linux or real infrastructure acceptance from these checks.

### Remaining Activation Requirements

All domain replacements must pass parity before one coordinated release.
Web must build/run without Prisma and database/provider/storage secrets only
after its last operational route/job has migrated. Shared Auth/EHR/Analytics
contracts, central delivery evidence, certificate/key rotation, direct-origin
bypass prevention, no duplicate effects, resource headroom and isolated rollback
rehearsal are mandatory. Keep webhooks and new email/SMS sends disabled.

The revised architecture has six persistent containers, not six domains:
Web/BFF, API, worker, dedicated RabbitMQ, one PostgreSQL and MinIO. API/worker
must use the same immutable image digest. Their activation must not be attached
to the current single-service auto-deploy until the coordinated release gate
and one-authoritative-writer controls are ready.

## Reliability References

- [RabbitMQ acknowledgements and confirms](https://www.rabbitmq.com/docs/confirms)
- [RabbitMQ quorum queues](https://www.rabbitmq.com/docs/quorum-queues)
- [PayMongo API keys](https://docs.paymongo.com/do/docs/account-settings-api-keys)

These define transport/provider behavior; VITAL transaction, authorization and
idempotency correctness remains application responsibility.
