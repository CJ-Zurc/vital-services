# Isolated EDA Development and Integration Infrastructure

This is an inactive, opt-in dev/test layout, not a staging override or deployment.
Never merge `compose.eda.yml` with the root, standalone legacy or staging Compose
files. It has six long-running runtimes: Web, API, worker, PostgreSQL, RabbitMQ and
MinIO. No shared database, Docker socket, host bind for source, fixed container
name, external BGH network, shared volume, automatic migration or reset is used.
All `VITAL_EDA_*` feature flags default OFF. Selecting the `eda` Compose profile
alone does not enable the API/worker; their launcher fails closed while disabled.

## Build and Runtime Boundaries

- Web builds the existing `../vital-web/Dockerfile` in that external context.
- API and worker share `Dockerfile.eda`, the same Node 22 runtime image, and
  independently selected entrypoints. `npm ci`, generation and TypeScript
  compilation happen from source at build time; no host `dist` is copied.
- Normal API/worker mounts contain only their own scoped runtime passwords.
  Migrator/provisioner passwords are mounted only by `compose.tools.yml` for
  short-lived administrative runs. Never `up` the tools override.
- All six processes run nonroot with bounded memory, CPU and PIDs, dropped
  capabilities and no-new-privileges. Node API/worker additionally have read-only
  root filesystems and bounded tmpfs. MinIO's derivative image owns `/data` as
  UID 1000 so a newly created named volume is usable without a root runtime.
- Tags are explicit but not immutable digests; resolve and pin reviewed digests
  before promotion. This layout is not a production-hardening attestation.

## Networking and Provider Egress

The project-scoped `private` network is `internal: true`. PostgreSQL, RabbitMQ,
MinIO and API publish **no host ports**; broker management binds only to broker
loopback, and MinIO console binds only to storage loopback. The only ingress is
Web on `127.0.0.1:3101`, configurable through `EDA_WEB_PORT`.

Web also has an ordinary ingress bridge, which provides outbound networking.
API/worker have no provider egress by default. The optional
`docker/eda/compose.egress.yml` attaches only API/worker to a separate outbound
bridge with explicit gateway priority. This does **not** restrict destinations;
use an operator-controlled proxy/firewall allowlist before enabling provider
workflows. Never use that override in the isolated integration job. Compose
2.33.1+ is required for `gw_priority`.

Web deliberately receives a non-routable legacy `DATABASE_URL` and no storage
admin password. Its legacy DB-owned pages are not usable here. Parent-owned BFF
client certificates, signing and Core route wiring must be completed separately;
this file does not claim a functional extracted Web workflow or cutover. Do not
restore the legacy/shared Web database just to make those pages load. MinIO is
private infrastructure only until its owner provisions a least-privilege bucket
identity; its admin credential is never given to Web/API/worker.

## Secrets and TLS

Set `EDA_SECRETS_DIR` to an operator-owned absolute directory **outside the
repository**. The default missing path is a placeholder, not usable credentials.
Keep it absent. Compose's file-backed secrets are read-only mounts, not a secret
vault; host ACLs and container-readable file permissions must be set appropriately.
Do not place real secrets under `docker/eda`: these files are tracked and this
task intentionally does not change repository ignore rules.

Required external files are declared in the `secrets` section of
`compose.eda.yml`. Password files hold nonempty distinct generated passwords.
`broker-definitions.json` must contain salted RabbitMQ SHA-256 password hashes
matching `rabbit-runtime-password` and `rabbit-provision-password`, not literal
passwords. Start with `definitions.example.json` for dev or
`definitions.test.example.json` for tests; replace **all** hash placeholders
outside the repository. Use RabbitMQ's supported password hashing utility on
isolated tooling, not an existing shared broker. There is no guest/admin login.

Certificate requirements:

- PostgreSQL server certificate: SAN `DNS:postgres`, serverAuth, signed by
  `db-ca.pem`. Its private key is copied by the nonroot postgres account into
  tmpfs with mode 0600. Network HBA requires TLS and SCRAM; plaintext is rejected.
- Broker certificate: SAN `DNS:rabbitmq`, serverAuth, signed by `broker-ca.pem`.
  Only AMQPS 5671 is enabled. Runtime/provisioner authenticate by distinct
  credentials after CA/hostname verification. Broker client certificates are
  optional; service API mutual TLS is independent.
- API certificate: SAN `DNS:api`, serverAuth; `service-ca.pem` trusts the
  separately parent-provisioned Web client certificate (clientAuth, identity
  expected by the API). `bff-public.pem` is a separate signing public key.
- Database and broker clients require CA verification; do not use insecure TLS
  options or `NODE_TLS_REJECT_UNAUTHORIZED=0`.

The Docker build copies only explicit launcher/source/schema/test files, never
the secret directory, examples containing credentials, or existing `.env` files.

## PostgreSQL Ownership and Grants

One PostgreSQL instance holds two application databases: `vital_core` and
`vital_integrations`; standard PostgreSQL maintenance databases remain present.
The six identities are `vital_{core,integrations}_{api,worker,migrator}`.
`eda_bootstrap` is the container-local bootstrap administrator, never a runtime
identity. Local peer mapping permits only OS `postgres` as this administrator;
network passwords are SCRAM over TLS.

Initialization revokes ALL PUBLIC privileges (including CONNECT/TEMP) on both
application databases and PUBLIC schema access. PUBLIC access to `postgres` and
`template1` is also revoked. Each runtime receives CONNECT only to its own
database. Runtime identities are NOSUPERUSER, NOCREATEDB, NOCREATEROLE,
NOREPLICATION and NOBYPASSRLS; they have no role memberships, DB/schema CREATE,
object ownership, TRUNCATE or migration-table privileges.

Only each migrator owns its database/schema. After parent-owned migrations,
`grants.sh` explicitly grants schema USAGE, table SELECT/INSERT/UPDATE/DELETE
(excluding `_prisma_migrations`) and sequence USAGE/SELECT to that database's
API and worker roles. No default runtime grant automatically exposes new tables;
rerun grants after migrations. Parent `verifyPrivileges()` should then accept
the runtime roles: own DB CREATE=false, other DB CONNECT=false, public schema
CREATE=false, all elevated role flags=false. Table-level DML is deliberately
broad within each owned DB in this dev skeleton; narrow it with the owner before
production deployment.

## Dedicated Broker Permissions

The dev broker imports only vhost `vital`. `vital_runtime` cannot configure
topology and can write only the six module exchanges plus `vital.retry` and
`vital.dead`, and read only the four named consumer queues.
`vital_provision` can configure/bind only the `vital.` namespace, has no management
tag and is not mounted on running workers. The parent's provision entrypoint
creates bounded durable/quorum topology, including 16 MiB maximum queue bytes.
Delayed queues return through the private `vital.resume` direct exchange;
runtime publishers cannot write it. Provisioning does not require broad
`amq.default` permissions. A single-node quorum has persistent delivery
semantics, not host-failure high availability. Before promotion, rehearse retry
and DLQ delivery against the actual declared topology, not just mock publishers.
Neither identity has access to other vhosts. Test definitions instead contain
only `vital_test` with UUID fixture resources under `vital.test.`; never import
test definitions into a dev/shared broker or grant test permissions on `vital`.

## Controlled Local Setup

First check `docker version`, `docker compose version`, and inspect the selected
project's scope with `docker compose -p vital-eda-dev -f compose.eda.yml --profile
eda config`. Confirm existing project containers/volumes and the localhost port
are unrelated to staging. Do not start Docker Desktop or containers without
operator authorization. There are no deploy/push/reset steps here.

After secrets/certificates are ready and the engine is available, use only the
following dedicated-project commands from `vital-services`:

```powershell
docker compose -p vital-eda-dev -f compose.eda.yml --profile eda build api worker web minio
docker compose -p vital-eda-dev -f compose.eda.yml --profile eda up -d postgres rabbitmq minio
docker compose -p vital-eda-dev -f compose.eda.yml -f docker/eda/compose.tools.yml --profile eda build api
docker compose -p vital-eda-dev -f compose.eda.yml -f docker/eda/compose.tools.yml --profile eda run --rm --no-deps api migrate
docker compose -p vital-eda-dev -f compose.eda.yml --profile eda exec postgres sh /etc/eda/postgres/grants.sh
$env:VITAL_EDA_PROVISION_BROKER = 'true'
docker compose -p vital-eda-dev -f compose.eda.yml -f docker/eda/compose.tools.yml --profile eda run --rm --no-deps api provision
Remove-Item Env:VITAL_EDA_PROVISION_BROKER
$env:VITAL_EDA_ENABLED = 'true'
docker compose -p vital-eda-dev -f compose.eda.yml --profile eda up -d api worker web
```

Writes, consumers and external delivery remain OFF unless independently enabled.
The Web port is not a substitute for production Gateway trust. The worker's
dispatch loop can publish pending outbox rows once runtime opt-in is enabled,
even while consumers/delivery remain disabled; use only this isolated project.

## Isolated Integration Job

The CI-ready bootstrap command (Linux/Git Bash with Docker Compose 2.33.1+,
OpenSSL and Node available) is:

```bash
bash docker/eda/run-integration.sh
```

It checks engine availability, takes a local bootstrap lock, refuses ANY existing
`vital-eda-test` labelled or known named resources, generates disposable
passwords/certificates and broker hashes in a mode-0700 temp directory, builds
only the tools API image, and starts **only PostgreSQL and RabbitMQ**. It creates
fresh project-scoped volumes, applies migrations/grants, explicitly enables the
real integration tests, and removes only the newly created project/volumes and
its temporary secret files on exit. Existing resources are never reused,
started, reset or deleted. A failure exits nonzero, including missing Docker or
configuration. It echoes harmless configuration names, never secret values.
Images/build cache remain; no prune or broad rebuild is performed. Do not run
concurrent copies of this fixed-project job on the same Docker engine. Prefer
an ephemeral CI runner; interrupted leftover resources cause the next run to
refuse, not silently reset. The script does not launch Docker Desktop locally.

Never call `createDatabases()` in these tests: it intentionally requires runtime
names. The test uses raw `pg` pools and the parent's real inbox/outbox/publisher
helpers. The test job needs a fresh **separate** project `vital-eda-test`, its own
volumes and external secret directory, test-only broker definitions and actual
parent migration SQL. `compose.test.yml` selects `_test` names and the tools
image. Do not run its `api` service as a long-lived server. Serialize the job;
the harness requires empty inbox/outbox tables and removes only its UUID rows
and broker resources, never resets schemas or purges existing queues.

```powershell
$env:EDA_SECRETS_DIR = 'C:/operator-owned/vital-eda-test-secrets'
$env:EDA_DATABASE_SUFFIX = '_test'
$env:EDA_TEST_ENABLED = 'true'
$env:EDA_TEST_ISOLATED = 'yes'
docker compose -p vital-eda-test -f compose.eda.yml -f docker/eda/compose.tools.yml -f docker/eda/compose.test.yml --profile eda config
docker compose -p vital-eda-test -f compose.eda.yml -f docker/eda/compose.tools.yml -f docker/eda/compose.test.yml --profile eda build api
docker compose -p vital-eda-test -f compose.eda.yml -f docker/eda/compose.tools.yml -f docker/eda/compose.test.yml --profile eda up -d postgres rabbitmq
docker compose -p vital-eda-test -f compose.eda.yml -f docker/eda/compose.tools.yml -f docker/eda/compose.test.yml --profile eda run --rm --no-deps api migrate
docker compose -p vital-eda-test -f compose.eda.yml -f docker/eda/compose.tools.yml -f docker/eda/compose.test.yml --profile eda exec postgres sh /etc/eda/postgres/grants.sh
docker compose -p vital-eda-test -f compose.eda.yml -f docker/eda/compose.tools.yml -f docker/eda/compose.test.yml --profile eda run --rm --no-deps api test
```

The launcher supplies only `EDA_TEST_*` connection variables to the test. The
harness requires exact private hosts `postgres`/`rabbitmq`, worker DB identities,
`vital_core_test`/`vital_integrations_test`, distinct provision/runtime broker
identities, AMQPS vhost `vital_test`, both CA files and
`EDA_TEST_ISOLATED=yes`. URL SSL/query overrides and all runtime/shared names
are rejected **before any connection**. There is no fallback to `DATABASE_URL`
or `VITAL_*`. Connection errors, absent migrations, missing settings and TLS
failures fail the enabled run. Do not describe this job as passing unless the
live tests actually execute.

Local ordinary `node --import tsx --test test/eda-integration.test.ts` runs the
configuration guard and visibly skips the opt-in suite. In CI, explicitly set
`EDA_TEST_ENABLED=false` for ordinary non-integration jobs, or `true` plus all
isolated configuration for the integration job; an unset flag in CI fails.
No package scripts or root catalog are modified by this task.

Exact registration names in `test/eda-integration.test.ts`:

- `EDA integration configuration rejects missing opt-in, shared databases and broker targets`
- `EDA isolated PostgreSQL and RabbitMQ integration`
- `EDA PostgreSQL runtime roles cannot DDL or connect across databases`
- `EDA PostgreSQL inbox rolls back atomically and deduplicates committed effects`
- `EDA PostgreSQL outbox recovers expired leases and fences stale owners`
- `EDA RabbitMQ confirmed mandatory publish rejects unroutable messages`
- `EDA unroutable outbox publication remains retryable instead of published`
- `EDA RabbitMQ runtime identity cannot provision topology`

## Reference Decisions

Network isolation/gateway behavior follows the [Compose network reference](https://docs.docker.com/reference/compose-file/networks/)
and [service network attributes](https://docs.docker.com/reference/compose-file/services/#gw_priority).
Privilege boundaries follow PostgreSQL's [privilege rules](https://www.postgresql.org/docs/16/ddl-priv.html)
and [schema guidance](https://www.postgresql.org/docs/16/ddl-schemas.html).
Broker bootstrapping follows [RabbitMQ definitions import](https://www.rabbitmq.com/docs/definitions).
