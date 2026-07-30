# Architecture

## Stack

- Node.js 20 (Alpine in Docker)
- Express 5 (CommonJS)
- PostgreSQL 16 sidecar (`vital-services-db`)
- RabbitMQ for audit publishing
- PayMongo for checkout and refund provider operations

## Layout

```text
src/
|-- index.js                 Express bootstrap, payment routes, and health
|-- config.js                Runtime configuration and production validation
|-- db.js                    Shared VITAL PostgreSQL connection pool
|-- payment-operations.js    Durable payment operation claiming and replay
|-- middleware/
|   |-- correlationId.js     Reads or generates X-Correlation-ID
|   |-- internal-auth.js     Validates directional service credentials
|   `-- trustedGateway.js    Validates X-Gateway-Secret and X-User-* headers
`-- routes/
    `-- vital.js             Gateway-forwarded appointment and telemedicine flows
```

## Middleware Order

1. `express.json()` parses request bodies.
2. `correlationId` reads or creates one correlation ID and echoes it.
3. Gateway routes validate `X-Gateway-Secret` before trusting `X-User-*`.
4. Payment routes validate the `vital-web` directional credential.
5. The error handler logs with the correlation ID and sanitizes responses.

The `/health` endpoint is available to Docker health checks without credentials.
The Gateway strips the `/vital` prefix before proxying public VITAL routes.

## Persistence

- `vital_services_db` is shared by VITAL_WEB and VITAL_Services.
- VITAL_WEB owns the Prisma schema, local role markers, appointments, and the
  `payment_operations` ledger.
- VITAL_Services atomically claims and reconciles payment operations in that
  ledger before calling PayMongo.
- A completed, failed, pending, or unknown operation is replayed by key instead
  of issuing another provider request.

## Outbound Dependencies

| Dependency | Purpose | Path |
|---|---|---|
| `UHSE_AUTH /internal/*` | Documented backend identity enrichment | Direct |
| `VITAL_WEB /api/internal/*` | Appointment background jobs | Direct |
| RabbitMQ `audit.events` | Business audit envelopes | Direct |
| `vital-services-db` | Shared VITAL persistence and payment ledger | Direct |

VITAL_Services does not route backend enrichment back through the Gateway.
