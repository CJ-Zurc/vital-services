# Configuration

VITAL_Services reads its config from environment variables. In the root compose stack the file is `.env.vital_services` (template at `.env.vital_services.example`).

## Runtime

| Key | Default | Notes |
|---|---|---|
| `PORT` | `8009` | Container exposes this; root compose maps to host. |
| `NODE_ENV` | `development` | Use `production` in deployed stacks. |

## Trust model

| Key | Notes |
|---|---|
| `GATEWAY_SECRET` | Must equal `BGH_API_GATEWAY` `GATEWAY_SECRET`. |
| `INTERNAL_API_KEY` | Shared workspace-wide internal key. |
| `INTERNAL_SERVICE_NAME` | `vital-services`. Used in outbound auth headers. |
| `GATEWAY_TRUST_ENABLED` | Set to `false` only in local debug; default `true`. |

## JWT

| Key | Notes |
|---|---|
| `JWT_SECRET` | Must equal `UHSE_AUTH` `JWT_SECRET`. |
| `JWT_ALGORITHM` | `HS256` matches Auth. |

## Auth direct calls

| Key | Notes |
|---|---|
| `AUTH_INTERNAL_BASE_URL` | `http://auth-api:8000` inside compose. |
| `AUTH_SYSTEM_SLUG` | `vital`. |
| `AUTH_SYSTEM_CLIENT_ID` | Matches `SYSTEM_VITAL_CLIENT_ID` in `.env.uhse_auth`. |
| `AUTH_SYSTEM_CLIENT_SECRET` | Matches `SYSTEM_VITAL_CLIENT_SECRET` in `.env.uhse_auth`. |
| `AUTH_INTERNAL_SERVICE_KEY` | Matches the `vital-services` entry in Auth's `INTERNAL_SERVICE_KEYS` JSON. |

## Postgres

| Key | Notes |
|---|---|
| `POSTGRES_HOST` | `vital-services-db` inside compose. |
| `POSTGRES_PORT` | `5432` (internal); host maps to `5435`. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Sidecar credentials. |
| `DATABASE_URL` | Convenience URL combining the above. |

## RabbitMQ / Audit

| Key | Notes |
|---|---|
| `RABBITMQ_URL` | `amqp://guest:guest@bgh-rabbitmq:5672/`. |
| `AUDIT_EXCHANGE` | `audit.events`. |
| `AUDIT_TIMEZONE` | `Asia/Manila`. |

## Observability

| Key | Notes |
|---|---|
| `LOKI_ENDPOINT` | `http://bgh-loki:3100/loki/api/v1/push`. |
| `PROMETHEUS_ENDPOINT` | `http://bgh-prometheus:9090/api/v1/write`. |
