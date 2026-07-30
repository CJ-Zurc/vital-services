# Testing

VITAL_Services uses `node:test`. Payment-operation tests cover duplicate concurrency and ambiguous provider failures.

Testing conventions:

- `node:test` or `vitest` — pick one and stick with it.
- A real Postgres for integration tests (matches workspace convention; do not mock the DB for integration paths).
- HTTP-level tests through `supertest` exercising the trust-gateway middleware.

## Smoke test (until a suite exists)

From `D:\repos\Capstone_BGH`:

```powershell
docker compose --env-file .env.compose up -d --build vital-services-db vital-services-api
curl http://localhost:8009/health
```

Expected: `{"success":true,"data":{"service":"vital-services"}}`.
