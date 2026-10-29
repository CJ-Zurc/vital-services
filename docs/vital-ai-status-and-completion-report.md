# VITAL AI and Appointment Privacy — Implementation Status

Updated: 2026-10-29.

## Current scope

The current implementation replaces specialty recommendations with NLP normalization, patient-confirmed deterministic summaries and the existing symptom analytics/clustering. Manual selection retains TRACE's 19 specialties. No clinical routing rules, LLM, vector database or new training are required.

The working tree includes the Core migration, random booking references, dedicated code cryptography, acceptance-bound issuance, patient retrieval/reissue/withdrawal, doctor redemption, privacy-aware appointment projections, messaging restrictions, Records authorization, episode-only historical projections, authenticated doctor file delivery, final-review normalization and patient/doctor access controls. Durable operational summaries and EHR brief approval are separate from derived analytics retention.

Source changes are not environment activation. No keys have been generated into real env files, no migration/backfill has been applied to a real database, and no service has been deployed or pushed in this work.

## Source cleanup

Temporary verification logs are stored outside the repositories under the workspace output folder. Removed unused specialty-routing runtime code, graph/candidate helpers and routing-only tests. Retained catalog validation, normalization, privacy, analytics and opt-in integration tests. Python caches are excluded from Git and Docker build contexts.

## Verification

Before source cleanup, the full Services run passed 491 tests with four environment-dependent skips; Web passed all 313 tests. Builds, TypeScript, schema validation, affected lint and BFF ownership checks passed. After removing obsolete routing tests and runtime helpers, all 13 affected Services tests and TypeScript passed; Python discovery passed eight with seven dependency/model skips. See [verification report](intelligence-verification.md) for commands, scope and limitations. Code-level checks do not establish end-to-end deployment behavior, clinical accuracy or anonymity. PostgreSQL concurrency/migration execution, real offline-model/resource acceptance and browser accessibility/print acceptance need runtime evidence before rollout.

## Operational completion

- Provision distinct versioned AES and HMAC keys to the appropriate runtimes; retain decryption key versions.
- Obtain hospital review of versioned consent wording, retention, historical evidence and privacy policy.
- Apply the Core migration through tools in an isolated environment; verify least-privilege grants.
- Deploy paired Web/Services and the normalization-only Python response contract.
- Perform the maintenance backfill with writers stopped and no active consultations.
- Exercise payment plus code enforcement, concurrent redemption/reissue/cancellation, expiry, rescheduling and withdrawal against real PostgreSQL.
- Validate mobile, large text, keyboard/screen-reader behavior, printing and stale client-data clearing.
- Verify model/runtime resource limits and independent analytics. Preserve existing activation boundaries; do not backfill analytics.
- Enable only after acceptance. Landing-page tutorial remains deferred.

The complete implementation contract and runbook are in [the implementation brief](vital-ai-implementation.md).

## Audit integration addition

VITAL universal audit publishing, security outcomes, admin history and bounded CSV export are documented in [audit integration](audit-integration.md). This does not activate anomaly detection or change production retention.
