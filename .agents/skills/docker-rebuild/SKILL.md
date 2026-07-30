---
description: Steps to rebuild VITAL_Services through the root compose stack.
---

# docker-rebuild skill

Run from `D:\repos\Capstone_BGH`.

```powershell
docker compose --env-file .env.compose up -d --build --force-recreate vital-services-api vital-services-db
docker compose --env-file .env.compose logs -f vital-services-api
```

For a clean image rebuild:

```powershell
docker compose --env-file .env.compose build --no-cache vital-services-api
docker compose --env-file .env.compose up -d --force-recreate vital-services-api
```
