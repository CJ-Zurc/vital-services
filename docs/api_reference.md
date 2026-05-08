# API Reference

> **Status:** scaffold. Concrete appointment and telemedicine endpoints will be added as the consolidated VITAL feature set lands. Routes listed here are the integration-critical ones the rest of the ecosystem depends on.

## Public health

### `GET /healthz`

- No auth.
- Returns `200 { "status": "ok", "service": "vital-services" }`.
- Used by Docker healthcheck and orchestrator probes.

## Internal (Auth-facing)

All `/internal/*` routes require `X-Gateway-Secret` (or, when called by Auth, the configured internal service key).

### `GET /internal/users/{user_id}/roles`

- Caller: `UHSE_AUTH` during system role aggregation for the `vital` slug.
- Response: `{ "system": "vital", "user_id": "<id>", "roles": [<role>...] }`
- Stub returns an empty roles array until role records exist.

## Vital business (Gateway-facing)

All `/vital/*` routes require `X-Gateway-Secret`. The Gateway maps browser-facing `/vital/*` paths onto these.

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
