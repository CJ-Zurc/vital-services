# API Reference

> **Status:** scaffold. Concrete appointment and telemedicine endpoints will be added as the consolidated VITAL feature set lands. Routes listed here are the integration-critical ones the rest of the ecosystem depends on.

## Public health

### `GET /health`

- No auth.
- Returns `200 { "status": "ok", "service": "vital-services" }`.
- Used by Docker healthcheck and orchestrator probes.

## Auth-facing role aggregation

`GET /internal/users/{user_id}/roles` is owned by `VITAL_WEB`, whose Prisma
records are the source of VITAL role markers. VITAL_Services does not expose
that endpoint.

## Vital business (Gateway-facing)

All browser-facing `/vital/*` routes require `X-Gateway-Secret`. The Gateway
removes the `/vital` prefix, so the downstream paths below are mounted as
`/healthz`, `/appointments`, and `/telemedicine`.

### `GET /vital/healthz`

Smoke test through the trust-gateway path.

### `GET /vital/appointments`  (placeholder)

Will return paginated appointment records once the appointment domain ships.

### `GET /vital/telemedicine`  (placeholder)

Will return telemedicine sessions/providers once the telemedicine domain ships.

## Headers

Every response includes the request's `X-Correlation-ID`.

## Errors

| Status | Code | Meaning |
|---|---|---|
| 403 | `forbidden_untrusted_caller` | Missing or invalid `X-Gateway-Secret` |
| 500 | `gateway_secret_not_configured` | Service started without `GATEWAY_SECRET` |
| 500 | `internal_error` | Unhandled exception (correlation ID returned) |
