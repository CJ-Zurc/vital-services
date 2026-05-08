---
trigger: always_on
description: Local Docker rebuild and run conventions for VITAL_Services.
---

# Docker Rebuild Rules

VITAL_Services runs through the **root** compose at `D:\repos\Capstone_BGH\compose.yaml`. There is no per-service compose file in this repo today.

## Targeted rebuild

From `D:\repos\Capstone_BGH`:

```powershell
docker compose --env-file .env.compose up -d --build --force-recreate vital-services-api vital-services-db
docker compose --env-file .env.compose logs -f vital-services-api
```

## After modifying

- `package.json` / `package-lock.json` → rebuild with `--build` (Docker layer cache invalidates).
- `src/**/*.js` → rebuild with `--build` (no hot reload in the production image).
- `.env.vital_services` (root) → no rebuild needed; restart the container.
- `Dockerfile` or `.dockerignore` → rebuild with `--build --no-cache` if you want to be sure layer caches are dropped.

## Healthcheck

The container's healthcheck hits `GET /healthz` on port `8009`. If startup loops without becoming healthy:

1. `docker compose --env-file .env.compose logs vital-services-api`
2. Check that `vital-services-db` reports healthy first (`pg_isready`).
3. Verify `GATEWAY_SECRET` / `INTERNAL_API_KEY` are set in `.env.vital_services`.

## Do not

- Do not `docker compose down -v` casually — it drops `vital_services_postgres_data`.
- Do not invent a per-repo `compose.yaml` here; the root compose owns the wiring.
