# Configuration

Root Compose supplies `.env.vital_services`; standalone Compose and native
Node runs use `.env`. The implemented readers are `src/config.js`,
`src/middleware/trustedGateway.js`, and `src/logger.js`.

| Key | Implemented use |
|---|---|
| `PORT` | API port; fallback `8009` |
| `NODE_ENV` | `production` enables required configuration validation |
| `DATABASE_URL` | Shared VITAL PostgreSQL database and payment-operation ledger |
| `PAYMONGO_SECRET` | Provider credential; accepts `PAYMONGO_SECRET_KEY` alias |
| `VITAL_WEB_URL` | Job callback base; root `http://vital-web:3001` |
| `VITAL_WEB_TO_SERVICES_INTERNAL_SERVICE_KEY` | Preferred inbound payment/job credential for caller `vital-web` |
| `VITAL_SERVICES_TO_WEB_INTERNAL_SERVICE_KEY` | Outbound credential for caller `vital-services` |
| `VITAL_INTERNAL_SERVICE_KEY` | Legacy internal credential fallback |
| `INTERNAL_API_KEY` | Legacy shared-key authentication |
| `JWT_SECRET` | Legacy internal-key fallback; not a browser JWT verification flow |
| `GATEWAY_SECRET` | Validates Gateway-forwarded scaffolds |
| `GATEWAY_TRUST_ENABLED` | Defaults to enabled; local debug bypass only |
| `LOG_LEVEL`, `HTTP_LOGGING_ENABLED` | Logger helper settings; current bootstrap also emits request lines |

Production requires explicit provider secret, database URL, both directional
keys, and `VITAL_WEB_URL`. Gateway secret is required when forwarding Gateway
requests. Keep credential directions distinct.

Compose `POSTGRES_*` settings configure containers. The application pool uses
`DATABASE_URL`; it does not build that URL from `POSTGRES_*` settings.

Older Auth client, RabbitMQ audit, Loki, and Prometheus environment tables
described desired integrations that are not read by the current service.
Do not infer those features from a retained template key. Adding them requires
implementation and contract verification.
