# Security

## Trust order

For every Gateway-forwarded request to `/healthz`, `/appointments`, or
`/telemedicine`:

1. **Reject** if `X-Gateway-Secret` does not equal `GATEWAY_SECRET`. Return `403 forbidden_untrusted_caller`.
2. **Then** read `X-User-Id`, `X-User-Email`, `X-User-System`, `X-User-Systems`, `X-User-System-Roles`, `X-User-Is-Admin`, and `X-User-Is-Super-Admin`.
3. **Then** authorize the action.

Never read `X-User-*` before the secret check passes.

## JWT verification

The service has `jsonwebtoken` available, but in normal operation it relies on the Gateway's verification + trusted-header projection. JWT verification inside VITAL_Services is only needed for:

- direct WebSocket handshakes (telemedicine signalling), if added later
- internal service-to-service tokens

If/when added, use `JWT_SECRET` and `JWT_ALGORITHM` from env. Match Auth's settings exactly.

## Secrets

| Key | Where it must match |
|---|---|
| `GATEWAY_SECRET` | `.env.bgh_api_gateway` `GATEWAY_SECRET` |
| `INTERNAL_API_KEY` | `.env.bgh_api_gateway` `INTERNAL_API_KEY`, `.env.uhse_auth` `INTERNAL_API_KEY` |
| `JWT_SECRET` | `.env.uhse_auth` `JWT_SECRET` |
| `AUTH_INTERNAL_SERVICE_KEY` | A matching entry in `.env.uhse_auth` `INTERNAL_SERVICE_KEYS` |
| `VITAL_WEB_TO_SERVICES_INTERNAL_SERVICE_KEY` | Matches VITAL_WEB's outbound payment credential |
| `VITAL_SERVICES_TO_WEB_INTERNAL_SERVICE_KEY` | Matches VITAL_WEB's inbound job credential |

PayMongo mutations require deterministic operation keys. Ambiguous network failures are persisted as `unknown` and must be reconciled rather than automatically retried.

Rotate by changing all sides at once (Gateway, Auth, VITAL_Services) and restarting the affected containers.

## What to log, what NOT to log

- Log `correlation_id`, route, status, user id (UUID, not email), and timing.
- Do **not** log JWTs, raw `Authorization` headers, or `X-Gateway-Secret`.
- Do **not** log full request bodies for any flow that touches PII or appointment medical context.

## Rate limiting

Rate limiting for `/vital/*` lives in the Gateway (`RATE_LIMIT_VITAL_IP`). Do not duplicate IP-based limits here — coordinate with Gateway-level controls instead.
