# Integration guide

## Current ownership

VITAL_WEB owns appointments, schedules, patient/doctor data, clinical documents,
and the Prisma schema. VITAL_Services owns PayMongo operations and the internal
appointment-job bridge. Both use the shared VITAL PostgreSQL database in root
Compose. Gateway-facing `/appointments` and `/telemedicine` are scaffolds.

## Request boundaries

- Browsers call VITAL_WEB BFF routes or Gateway; they do not call port `8009`.
- Gateway strips `/vital` and forwards ordinary service paths here. Its
  `/vital/integrations/v1/*` branch forwards to VITAL_WEB instead.
- `src/middleware/trustedGateway.js` checks `X-Gateway-Secret` before reading
  `X-User-Id`, `X-User-Email`, `X-User-System`, `X-User-Systems`,
  `X-User-System-Roles`, and the admin/SuperAdmin flags.
- Payment/job callers use `X-Internal-Service: vital-web` and the
  `VITAL_WEB_TO_SERVICES_INTERNAL_SERVICE_KEY`; legacy compatibility is
  documented in [security](security.md).
- Job callbacks use `X-Internal-Service: vital-services` with
  `VITAL_SERVICES_TO_WEB_INTERNAL_SERVICE_KEY` and preserve `X-Correlation-ID`.
- Auth calls VITAL_WEB directly for `/internal/users/{user_id}/roles`.
  This service must not duplicate that role source.

## Implemented and planned

Current payment mutation claims/replay are in `src/payment-operations.js`;
routes and payloads are in [api_reference.md](api_reference.md).
There is no implemented RabbitMQ audit publisher or Auth enrichment client in
`src/`. Those are future integrations, not current side effects. When added,
Auth control-plane calls must use direct `/internal/*` and audit publishing must
follow the active [audit contract](../../Documents/Audit_Logs_Integration_Guide_v3.md).

The PayMongo webhook returns a reservation response only. It does not verify
provider signatures or process payments. Payment status currently comes from
checkout retrieval. Do not represent that placeholder as a completed webhook.
