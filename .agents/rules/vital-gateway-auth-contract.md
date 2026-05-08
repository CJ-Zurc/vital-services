---
trigger: always_on
description: Required Gateway and Auth integration rules for VITAL_Services, including trusted headers, correlation propagation, direct Auth internal calls, and audit publishing.
---

# VITAL_Services: Gateway and Auth Integration Rules

Apply these rules whenever work touches request trust, downstream authorization, outbound Auth calls, or any change that could affect session claims for the `vital` system slug.

## 1. Gateway is the browser-facing boundary

- Browser traffic must reach this service through `BGH_API_GATEWAY`, not directly.
- The Gateway maps `/vital/*` to this service.
- Never add browser-facing flows that expect direct calls to VITAL_Services in production.

## 2. Trust starts with `X-Gateway-Secret`

- Never trust any `X-User-*` header until `X-Gateway-Secret` has been validated.
- The trust check lives in `src/middleware/trustedGateway.js`. Reuse it; do not reimplement validation per-route.
- The expected secret is read from `GATEWAY_SECRET` (must equal Gateway's `GATEWAY_SECRET`).
- Reject untrusted callers with `403 forbidden_untrusted_caller`.

## 3. Trusted headers

After validation, consume only:

- `X-User-Id`
- `X-User-Email`
- `X-User-Roles` (comma-separated)
- `X-System-Context`

Do not parse or trust other `X-User-*` headers without coordination with `BGH_API_GATEWAY`.

## 4. Correlation IDs

- Every request must have an `X-Correlation-ID`.
- `src/middleware/correlationId.js` reads or generates one and echoes it on the response.
- Propagate the same ID on every outbound HTTP/RabbitMQ call so it appears in Loki, audit events, and Auth logs.

## 5. Direct calls to UHSE_AUTH

- Backend-to-Auth enrichment, token validation, role lookups, and `/internal/*` work go to `AUTH_INTERNAL_BASE_URL` directly.
- Never route Auth control-plane traffic back through `BGH_API_GATEWAY`.
- Pass `INTERNAL_API_KEY` (or the dedicated `AUTH_INTERNAL_SERVICE_KEY` if Auth requires per-caller keys) on these calls.

## 6. Auth-facing role aggregation

- `GET /internal/users/{user_id}/roles` is the contract Auth calls during system role aggregation for the `vital` slug.
- The response shape must be `{ "system": "vital", "user_id": "...", "roles": [...] }`.
- This endpoint must be guarded by the same trusted-gateway check OR by the internal service key — confirm with `UHSE_AUTH/.agents/rules/` before changing the guard.

## 7. Audit publishing

- Business events (appointment created, telemedicine session started, etc.) must be published to `RABBITMQ_URL` on the `AUDIT_EXCHANGE` (`audit.events`).
- Event envelope and routing keys must follow `Documents/Audit_Logs_Integration_Guide_v2.md`. Do not invent new envelope shapes.

## 8. Session staleness

- Trust the claims handed in via `X-User-*` for the duration of one request. Do not cache them past request scope.
- For long-lived workflows, re-resolve identity through Auth `/internal/*` rather than re-using stale claims.
