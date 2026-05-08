# VITAL_Services Documentation

VITAL_Services is the consolidated VITAL backend for the BGH Unified Health Service Ecosystem. It hosts both appointment and telemedicine flows behind a single Express 5 API and replaces the prior `VITAL-APPOINTMENT` + `VITAL-TELEMEDICINE` repos.

## Contents

- [architecture.md](./architecture.md) — service layout, route map, runtime shape
- [api_reference.md](./api_reference.md) — endpoint inventory
- [integration_guide.md](./integration_guide.md) — Gateway / Auth / Audit contract (start here for cross-service work)
- [security.md](./security.md) — trust model, JWT verification, header order
- [configuration.md](./configuration.md) — env keys
- [deployment.md](./deployment.md) — Docker build and root compose wiring
- [flows.md](./flows.md) — request and event flows
- [testing.md](./testing.md) — test strategy

## Quick facts

- **Stack:** Node.js 20, Express 5, Postgres 16
- **Port:** `8009`
- **System slug:** `vital`
- **Browser path:** `/vital/*` via the Gateway
- **Auth-facing:** `GET /internal/users/{user_id}/roles`
- **Sidecar DB:** `vital-services-db` on port `5435`
