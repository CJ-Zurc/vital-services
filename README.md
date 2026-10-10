# VITAL Services

Node.js/Express service for PayMongo checkout/status/expiration/refund operations
and the VITAL_WEB appointment auto-completion bridge. Payment mutations use a
shared PostgreSQL operation ledger to prevent duplicate provider calls.

Root Compose runs `vital-services-api` on `8009` and `vital-services-db` on
host `5435`. `VITAL_WEB` owns the Prisma schema and the appointment/telemedicine
operational workflows. This service's Gateway `/appointments` and `/telemedicine`
handlers are currently empty scaffolds, not the operational appointment API.

For local Node development, copy `.env.example` to `.env`, configure the shared
database/provider/directional credentials, then run `npm ci` and `npm run dev`.
For standalone or root containers, follow [deployment](docs/deployment.md).

Start with [docs/README.md](docs/README.md). The current routes are in
[API reference](docs/api_reference.md); verification uses `npm test`
(`node --test`) and `npm run lint`. No Python test runner applies here.
