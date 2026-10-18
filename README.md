# VITAL Services

VITAL's Node 22 modular EDA backend owns operational business workflows. Core and
Integrations are separate PostgreSQL databases. API and worker share the runtime
image; migration/provision/baseline commands use a separate tools image. Web is
the browser/BFF and has no operational database.

The root default Compose topology is the supported ecosystem runtime. Follow
[deployment](docs/deployment.md), [architecture](docs/architecture.md),
[configuration](docs/configuration.md), [integration](docs/integration_guide.md)
and [testing](docs/testing.md). Use the root lifecycle for migrations and baseline
seeding; do not query another service's database. Keep secrets outside source.
