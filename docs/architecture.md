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
├── index.js                       Express bootstrap, middleware order, health
├── middleware/
│   ├── correlationId.js           Reads/generates X-Correlation-ID
│   ├── internal-auth.js           Validates service-to-service credentials
│   └── trustedGateway.js          Validates X-Gateway-Secret, extracts X-User-*
└── routes/
    └── vital.js                   Gateway-forwarded appointment + telemedicine flows
```

## Middleware order

1. `express.json()` — body parsing
2. `correlationId` — every request gets an ID, echoed on the response
3. `trustedGateway` (mounted on `/healthz`, `/appointments`, and
   `/telemedicine`) — rejects untrusted Gateway callers
4. Route handlers
5. Error handler — logs with correlation ID, returns sanitized 500

The `/health` endpoint is mounted before protected internal routes so Docker
healthchecks and orchestrator probes can reach it without credentials.

The Gateway strips the `/vital` prefix before proxying. For example,
`/vital/appointments` arrives here as `/appointments`.

## Persistence

- One Postgres database (`vital_services_db`) shared across both VITAL domains.
- `VITAL_WEB` owns its Prisma schema and local VITAL role markers. Its database
  is separate from the VITAL_Services sidecar.

## Outbound dependencies

| Dep | Purpose | Direct or via Gateway? |
|---|---|---|
| `UHSE_AUTH /internal/*` | Identity enrichment, token validation | **Direct** (`AUTH_INTERNAL_BASE_URL`) |
| RabbitMQ `audit.events` | Publish business audit envelopes | Direct (broker) |
| `vital-services-db` | Persistence | Direct |

VITAL_Services never calls the Gateway as a client.
