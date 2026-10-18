# EDA infrastructure

Default root Compose includes `vital-db`, `vital-storage`, `vital-eda-scanner`,
`vital-eda-api`, `vital-eda-worker` and `vital-web`. Root RabbitMQ hosts the dedicated
VITAL vhost. The tools profile contains migration and broker provisioning jobs.
Use `scripts/ecosystem.py vital-start`; configure private files first.

The service-owned `compose.eda.yml` and `docker/eda/compose.*.yml` exist only for
isolated integration tests. Never merge them into the ecosystem topology.
See [deployment](deployment.md) for actual startup and staging provisioning.
