# Deployment

VITAL_Services is wired into the BGH workspace via the **root** compose at `D:\repos\Capstone_BGH\compose.yaml`. There is no per-service compose file in this repo.

## Image build

The repo Dockerfile is multi-stage Node 20-alpine:

1. `deps` — installs production node_modules from `package-lock.json`.
2. `runner` — copies `node_modules` and `src/`, exposes `8009`, runs `node src/index.js`.

A container healthcheck hits `GET /healthz` on `8009`.

## Root compose entries

The root compose defines:

- `vital-services-db` — Postgres 16, port `${VITAL_SERVICES_DB_PORT:-5435}:5432`, volume `vital_services_postgres_data`.
- `vital-services-api` — built from `./VITAL_Services`, port `${VITAL_SERVICES_API_PORT:-8009}:8009`, depends_on `vital-services-db: service_healthy` + `bgh-rabbitmq: service_started`.

## Running

From `D:\repos\Capstone_BGH`:

```powershell
# bootstrap envs (one-time)
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-root-env.ps1

# phased full stack (recommended)
powershell -ExecutionPolicy Bypass -File .\scripts\start-bgh-ecosystem.ps1

# or targeted
docker compose --env-file .env.compose up -d --build --force-recreate vital-services-api vital-services-db
```

## Logs

```powershell
docker compose --env-file .env.compose logs -f vital-services-api
docker compose --env-file .env.compose logs -f vital-services-db
```

## Smoke test

After startup:

```powershell
# from the host
curl http://localhost:8009/healthz
# expected: {"status":"ok","service":"vital-services"}

# trust check
curl -H "X-Gateway-Secret: $(Select-String -Path .env.vital_services -Pattern '^GATEWAY_SECRET' | %{ ($_ -split '=',2)[1] })" http://localhost:8009/internal/users/test/roles
# expected: {"system":"vital","user_id":"test","roles":[]}
```
