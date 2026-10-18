# VITAL deployment

Use root `compose.yaml` for the default EDA ecosystem. `compose.staging.yaml` is
an image-only overlay with exact pins and no build contexts. See the root
[VM runbook](../../docs/deployment/single-azure-vm.md) for monthly provisioning.

Services: `vital-db`, `vital-storage`, `vital-eda-scanner`, `vital-eda-api`,
`vital-eda-worker`, `vital-web`. Explicit tools: `vital-eda-migrate` and
`vital-eda-provision`. The backend `Dockerfile` has separate runtime/tools
targets; API and worker use the same runtime content. Web starts `server.js` and
never migrates a database.

`ecosystem.py vital-start` starts infrastructure, provisions roles/storage/broker,
migrates, grants runtime DML and starts API/worker. Start Gateway before Web.
`ecosystem.py seed` resolves configured Auth identities through owner commands,
TRACE departments and EHR IDs before VITAL baseline reconciliation. It never runs
large population/training. Repeat runs must preserve IDs and not duplicate rows.

Manual builds run sequentially on staging under the deploy lock, with resource
checks and source/archive/image records. Keep approved images until live health,
seed consistency and workflow checks pass. Resets and cleanup are separate,
explicitly confirmed operations. No local stack is required for source tests.
