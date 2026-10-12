# Revised EDA Implementation Status

Updated: 2026-10-12. Status: foundation in progress, not cutover-ready.

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
- Profile reads/materialization/update foundation with strict field/scope checks;
  writes default disabled. Verified EHR/TRACE onboarding receipts are not wired.
- Central audit/notification delivery ledger scaffolding and safe retry codes.
- Production and test payment app factories consolidated. Sandbox-only provider
  credentials and ambiguous-outcome non-retry behavior are enforced.

## Not Yet Accepted

Appointment extraction, approval prepare/commit, durable reschedule saga,
payment ownership/reconciliation, Profile Auth-stale/doctor-mirror delivery,
Records/file/storage extraction, Meet quota/provider parity, encrypted Messaging
and SSE extraction remain required. Schemas and worker scaffolds are not proof
that these workflows have migrated. Do not remove old Web persistence yet.

The payment consumer foundation is inactive. It still needs lifecycle/access
grant parity and cross-database race acceptance. Prepared saga tables do not
constitute a working saga. Profile event handling currently prepares central
audit delivery, not the full existing synchronization behavior.

Gateway/Web trust, platform ingestion, EHR idempotency, isolated Compose and
Web mTLS transport are being implemented in coordinated patches; their own
reports/tests must be reviewed before enabling any target traffic. Route/DTO
and authorization matrices must be manually completed from the inventory.

## Verification

Both Prisma clients generate; baseline SQL was produced without DB access.
Current full backend suite: 42 passed, zero failed, one explicitly skipped live
PostgreSQL/RabbitMQ test. Backend build/typecheck and ESLint passed. Web transport
has 11 passing injected-network tests and a passing strict standalone typecheck.
EHR current-baseline recovery tests: 28 passed; existing integration/roles/schema
regressions: 38 passed. Node locally is 24; CI/Docker target 22 must also pass.

Notification agent verification: 48 scoped-ingestion/migration tests passed and
PostgreSQL DDL generation passed. Audit agent verification: 132 full mocked
service tests passed. Their reports document fixture boundaries and outstanding
live-database evidence. These are not claimed as full ecosystem acceptance.
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

## Activation Gate

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
