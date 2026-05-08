# Architecture

## Stack

- Node.js 20 (alpine in Docker)
- Express 5 (CommonJS)
- `jsonwebtoken` for JWT verification
- `axios` for outbound HTTP (Auth control-plane calls)
- PostgreSQL 16 sidecar (`vital-services-db`)
- RabbitMQ for audit publishing (shared with the rest of the BGH stack)

## Layout

```
src/
├── index.js                       Express bootstrap, middleware order, healthz
├── middleware/
│   ├── correlationId.js           Reads/generates X-Correlation-ID
│   └── trustedGateway.js          Validates X-Gateway-Secret, extracts X-User-*
└── routes/
    ├── internal.js                /internal/* — Auth-facing role aggregation
    └── vital.js                   /vital/* — appointment + telemedicine flows
```

## Middleware order

1. `express.json()` — body parsing
2. `correlationId` — every request gets an ID, echoed on the response
3. `trustedGateway` (mounted on `/internal` and `/vital`) — rejects untrusted callers
4. Route handlers
5. Error handler — logs with correlation ID, returns sanitized 500

The `/healthz` endpoint is mounted **before** `trustedGateway` so the Docker healthcheck and orchestrator probes can reach it.

## Persistence

- One Postgres database (`vital_services_db`) shared across both VITAL domains.
- The frontend (`VITAL_WEB`) uses Prisma against the same database where it needs read access for SSR; backend writes flow through the API.

## Outbound dependencies

| Dep | Purpose | Direct or via Gateway? |
|---|---|---|
| `UHSE_AUTH /internal/*` | Identity enrichment, token validation | **Direct** (`AUTH_INTERNAL_BASE_URL`) |
| RabbitMQ `audit.events` | Publish business audit envelopes | Direct (broker) |
| `vital-services-db` | Persistence | Direct |

VITAL_Services never calls the Gateway as a client.
