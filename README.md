# VITAL Services

VITAL Services currently hosts the PayMongo checkout, status, refund, and appointment-job bridge used by `vital-web`.

## Docker

Start `vital-web` first so it creates the shared `vital-network`.

```powershell
Copy-Item .env.docker.example .env.docker
docker compose --env-file .env.docker up -d --build
```

The PayMongo service is available at `http://localhost:4001/health`. Future meetings, notifications, and scheduler services can be added as separate containers in this Compose project when their provider contracts are implemented.
