# Testing

VITAL_Services is currently a scaffold; no test suite is checked in yet.

When tests are added, use:

- `node:test` or `vitest` — pick one and stick with it.
- A real Postgres for integration tests (matches workspace convention; do not mock the DB for integration paths).
- HTTP-level tests through `supertest` exercising the trust-gateway middleware.

## Smoke test (until a suite exists)

From `D:\repos\Capstone_BGH`:

```powershell
docker compose --env-file .env.compose up -d --build vital-services-db vital-services-api
curl http://localhost:8009/healthz
```

Expected: `{"status":"ok","service":"vital-services"}`.
