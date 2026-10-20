# VITAL Services deployment

Root `compose.yaml` owns the API, worker, scanner and infrastructure lifecycle.
The staging-only `compose.staging.yaml` overlay uses exact image digests stored
in `VITAL_EDA_SERVICES_IMAGE` and `VITAL_EDA_TOOLS_IMAGE` in the root
`.env.compose` file. API and worker share the runtime image; migration and
provision commands use the separate tools image.

For development/staging pushes and pull requests targeting those branches, the
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
