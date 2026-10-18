# VITAL runtime operations

Root Compose owns API, worker, scanner and scoped infrastructure. From the workspace root:

```sh
python scripts/ecosystem.py vital-start
docker compose --env-file .env.compose logs --tail 100 vital-eda-api vital-eda-worker
```

This lifecycle provisions infrastructure, runs migrations using separate tools
credentials, grants runtime DML, provisions the broker and starts bounded runtimes.
For source verification run `npm test` and `npm run build` inside VITAL_Services.
Do not start a local stack when the user forbids it. Staging uses the root manual
deployment runbook and the deployment lock; never rebuild implicitly via startup.
