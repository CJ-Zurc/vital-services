> **2026-10-28 superseding scope:** Specialty recommendation endpoints are retired (410). The 19-specialty TRACE lookup remains for manual selection. Booking is doctor/slot first, with NLP confirmation in final review. Appointment identity and record access require the separate six-digit-code policy, independently of AI flags. Deploy paired Web/Services contracts and provision dedicated access keys before cutover. See [the current implementation brief](vital-ai-implementation.md).

# VITAL Services deployment

Root `compose.yaml` owns the API, worker, scanner and infrastructure lifecycle.
The staging-only `compose.staging.yaml` overlay uses exact image digests stored
in `VITAL_EDA_SERVICES_IMAGE` and `VITAL_EDA_TOOLS_IMAGE` in the root
`.env.compose` file. API and worker share the runtime image; migration and
provision commands use the separate tools image.

For staging pushes and promotion pull requests targeting staging, the
workflow resolves the exact VITAL Web revision from the matching branch (the
pull request base branch, or the pushed branch) before reviewing route contracts.
Manual runs and main/master branch checks use the supplied `web_sha` or the
reviewed `VITAL_EDA_COMPATIBLE_WEB_SHA` repository variable. On a push to this
repository's `staging` branch, the workflow also runs unit and isolated
PostgreSQL/RabbitMQ checks, publishes both images to GHCR, then deploys those
immutable digests over SSH. The deploy holds
`/tmp/bgh-staging-deploy.lock`, updates only the Services image pins, and runs
`python3 scripts/ecosystem.py vital-start --staging --skip-build`. That lifecycle
starts infrastructure and scanner, provisions scoped resources, applies Core
and Integrations migrations, grants runtime access, and starts the API and
worker. It does not deploy Web.

The workflow records both source revisions, image digests, local image IDs and
previous pins under `.artifacts/releases/vital-ghcr/` for recovery. Candidate
publication and disposable runtime-acceptance workflows remain separate manual
operations and do not deploy staging. Production branches do not trigger this
staging deployment.

See the root [monthly VM runbook](../../docs/deployment/single-azure-vm.md) for
provisioning, environment setup and recovery.

## Sprint 6 coordinated migration

The two `202610200001` migrations must run through the existing tools-image migration service before updated API/worker containers start. This release removes doctor `title` and adds S2/signature/document and invoice snapshot storage; compatible Web must follow. Existing doctors return to onboarding. Routine rebuilds do not reset databases. See [Capstone documents](capstone-documents.md).


## S6 appointment migration

The tools image runs committed Core migration `202610210001_s6_appointment_revisions` through the existing locked deployment runner before API/worker startup. Migration failure remains fatal. Apply normally to existing databases; do not reset them. This revision adds no deployment action or environment variables. See [feature contract](eda/sprint6-appointment-revisions.md).

## CI verification tiers

Development PRs and pushes run fast lint or syntax checks only. Full regression
suites run on promotion PRs, production pushes, manual dispatch, and direct or
unverified staging pushes. A staging merge push skips the duplicate regression
only after the workflow verifies the merged PR's full regression and aggregate
check.
Staging deployment verifies paired Web contracts and PostgreSQL/RabbitMQ
checks, then deploys the build-produced runtime and tools digests and verifies
the running image IDs. Previous pins are recorded before mutation and restored
if deployment fails; restoring images does not reverse database migrations.
Keep the original verification check required before promotion; workflow YAML
does not configure branch protection. See the workspace
[CI verification tiers](../../docs/ci-verification.md) for the event matrix.

Production pushes and manual dispatch always run full verification. If a staging
merge cannot be matched to passing PR checks, it also runs full regression.
Services skips its duplicate isolated database/broker integration only after
that PR check is verified; paired route review still runs on the staging push to
resolve the exact Web revision. Both checks remain required on promotion PRs.

## VITAL intelligence prototype

[Intelligent intake and analytics](intelligence.md) documents the new Core-owned AI tables, private Python/Node job runtimes, scoped APIs, encryption keys, feature flags, clinical-review gates and root Compose overlay. Existing runtime behavior stays unchanged with AI disabled. No legacy data is imported.
