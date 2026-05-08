---
trigger: always_on
description: Structural and documentation rules for the VITAL_Services backend. Lists doc organization and the parity table that connects code areas to their docs.
---

# VITAL_Services: Context Documents

`VITAL_Services` is the consolidated VITAL backend (Node.js / Express 5). It replaces the prior `VITAL-APPOINTMENT` and `VITAL-TELEMEDICINE` services and owns:

- VITAL appointment-domain backend flows
- VITAL telemedicine-domain backend flows
- The current `/vital/public*` and `/vital/staff*` path target shape
- The Auth-facing `GET /internal/users/{user_id}/roles` endpoint that contributes to UHSE_AUTH role aggregation

## Required reading before edits

1. `README.md` (when present)
2. `docs/README.md`
3. `docs/integration_guide.md` — contract with Gateway/Auth/Audit
4. `docs/architecture.md` — Express layout and route map
5. `.agents/rules/*` (all)
6. `.agents/skills/*` (when present)

For cross-service work also consult:

- `../.agents/rules/root-workspace-context.md`
- `../.agents/rules/root-repo-routing.md`
- `../Documents/VITAL_Integration_Guide_v1.md`
- `../Documents/Auth_Backend_Integration_Guide_v4.md`
- `../Documents/Audit_Logs_Integration_Guide_v2.md`

## Code-to-doc parity

| Code area | Doc that must stay in sync |
|---|---|
| `src/routes/internal.js` | `docs/api_reference.md`, `docs/integration_guide.md` |
| `src/routes/vital.js` | `docs/api_reference.md`, `docs/flows.md` |
| `src/middleware/trustedGateway.js` | `docs/security.md`, `docs/integration_guide.md` |
| `src/middleware/correlationId.js` | `docs/integration_guide.md` |
| `Dockerfile`, root compose entry | `docs/deployment.md` |
| Env keys (`.env.example`) | `docs/configuration.md` |

If you add a new route, middleware, or env key, update its parity doc in the same change.

## Boundaries

- `VITAL_Services` is **not** browser-facing. The browser must reach VITAL through the Gateway only.
- `VITAL_Services` may call `UHSE_AUTH` directly via `/internal/*` for control-plane needs (token validation, identity enrichment) using `AUTH_INTERNAL_BASE_URL` — never via the Gateway.
- `VITAL_Services` publishes audit events to RabbitMQ (`audit.events` exchange) — see `BGH_AUDIT_LOGS` integration guide.
