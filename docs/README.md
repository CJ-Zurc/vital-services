# VITAL_Services Documentation

The default-off [completion/Profile asset checkpoint](eda/completion-profile-assets.md)
documents composed reads, registration consent, scanned QR ownership and explicit
remaining cleanup gates. The lead developer's canonical environment inventory
is in root `docs/deployment/vital-eda-environment-handoff.md`.

The default-off [Messaging checkpoint](eda/messaging-ownership.md) owns encrypted
chat, read receipts and authoritative Appointment-chain access. See
[retention and legal holds](eda/messaging-retention.md). The default-off
[SSE implementation](eda/sse-ownership.md) now delegates authorized streams to
backend owners. These are code checkpoints, not coordinated release acceptance.

VITAL_Services is the consolidated VITAL backend for the BGH Unified Health
Service Ecosystem. The revised candidate targets Node 22 and Express 5, with
feature-owned modules in `src/eda/modules/`, a single API and a shared worker.
Core and Integrations are separate operational databases in one PostgreSQL
instance. Web is the frontend/BFF candidate, not an operational database owner.
See [architecture.md](architecture.md) for the feature tree.

The revised EDA migration is being implemented behind disabled-by-default
entrypoints. This is not a completed extraction or staging release. See
[EDA implementation status](eda/implementation-status.md),
[schema ownership](eda/schema-ownership.json) and
[route baseline](eda/route-baseline.json). Existing `npm start` remains the
legacy runtime until coordinated acceptance and cutover.
The default-off Records checkpoint is described in
[Records ownership](eda/records-ownership.md) and
[artifact processing](eda/records-artifacts.md). It does not activate storage,
scanning or shared Appointment workflows.
The separate default-off [Video checkpoint](eda/video-ownership.md) moves Meet
credentials/provider calls and resource coordination into the backend. It does
not change UHSE_AUTH Google login or VITAL screens. See
[provider controls](eda/video-provider.md) and [association contracts](eda/video-association.md).

## Contents

- [architecture.md](./architecture.md) — service layout, route map, runtime shape
- [api_reference.md](./api_reference.md) — endpoint inventory
- [integration_guide.md](./integration_guide.md) — Gateway / Auth / Audit contract (start here for cross-service work)
- [security.md](./security.md) — trust model, JWT verification, header order
- [configuration.md](./configuration.md) — env keys
- [deployment.md](./deployment.md) — Docker build and root compose wiring
- [flows.md](./flows.md) — request and event flows
- [testing.md](./testing.md) — test strategy

## Legacy Runtime Reference

The following facts describe the pinned pre-cutover runtime, not the EDA candidate.

- **Stack:** Node.js 20, Express 5, Postgres 16
- **Port:** `8009`
- **System slug:** `vital`
- **Browser path:** `/vital/*` via the Gateway
- **Auth-facing role provider:** `VITAL_WEB`
- **Sidecar DB:** `vital-services-db` on port `5435`
