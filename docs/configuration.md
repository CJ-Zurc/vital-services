# Configuration

Default-off completion flags include `VITAL_EDA_SSE_ENABLED=false` in backend
and Web. API/worker optional heartbeat files must be exactly
`VITAL_EDA_API_HEALTH_FILE=/tmp/vital-api-health.json` and
`VITAL_EDA_WORKER_HEALTH_FILE=/tmp/vital-worker-health.json`. Progress is checked
locally without exposing a new port or credentials. Their actual image/runtime
acceptance remains pending; see `docs/eda/sse-ownership.md`.

## Messaging Checkpoint

All target opt-ins default to false in `.env.eda.example`:
`VITAL_EDA_MESSAGING_ENABLED`, `VITAL_EDA_MESSAGE_HOLDS_ENABLED`,
`VITAL_EDA_MESSAGING_RETENTION_SCAN_ENABLED`, and
`VITAL_EDA_MESSAGING_RETENTION_ENABLED`. Messaging requires the global EDA and
Appointment owners. Hold/scan/purge flags without Messaging are rejected.
Runtime uses server-only `MESSAGE_ENCRYPTION_KEYS` (JSON version-to-base64
32-byte keys) and `MESSAGE_ACTIVE_KEY_VERSION`; preserve older keys. Purge also
requires `MESSAGE_RETENTION_APPROVED=true` and a bounded
`MESSAGE_RETENTION_POLICY_APPROVAL_ID`. Missing approval selects dry-run, never
deletion. Never use NEXT_PUBLIC variables for keys or approval credentials.
See [Messaging ownership](eda/messaging-ownership.md) for the private contract.

## Disabled Records Checkpoint

`VITAL_EDA_RECORDS_ENABLED=false` and `VITAL_EDA_RECORDS_ARTIFACTS_ENABLED=false`
remain the defaults. The former requires a dedicated AES-256-GCM keyring file,
EHR RS256 public-key map, scoped Auth profile-read credential and scoped private
S3-compatible storage configuration; see `.env.eda.example`. No existing Web or
MinIO root credential is inherited. The processor additionally requires mounted
Unicode fonts and a restricted ClamAV Unix socket plus its read-only daemon
configuration. Neither daemon nor socket is provisioned by the application.
Missing, stale or unverifiable scanning remains quarantined/blocked.

Keyring JSON is `{activeKeyId, keys: {keyId: base64-32-byte-key}}`; retain old
versions for protected evidence recovery. EHR verifier JSON is a key-ID-to-PEM
map with at most three RSA keys (2048 bits minimum). Receipts expire within 60
seconds. Current and previous keys require coordinated owner-controlled rotation.
Never include private keys, receipt tokens or clinical content in logs/events.
Signed downloads last 300 seconds and remain bearer capabilities until expiry.

Runtime identities cannot create buckets. Quarantine/final prefixes, TLS/network
trust, object at-rest encryption and deny-overwrite/delete final-object policy
require separate infrastructure verification before activation.

Root Compose supplies `.env.vital_services`; standalone Compose and native
Node runs use `.env`. The implemented readers are `src/config.js`,
`src/middleware/trustedGateway.js`, and `src/logger.js`.

| Key | Implemented use |
|---|---|
| `PORT` | API port; fallback `8009` |
| `NODE_ENV` | `production` enables required configuration validation |
| `DATABASE_URL` | Shared VITAL PostgreSQL database and payment-operation ledger |
| `PAYMONGO_SECRET` | Sandbox `sk_test_*` only; accepts `PAYMONGO_SECRET_KEY` alias; live/public credentials are rejected |
| `VITAL_WEB_URL` | Job callback base; root `http://vital-web:3001` |
| `VITAL_WEB_TO_SERVICES_INTERNAL_SERVICE_KEY` | Preferred inbound payment/job credential for caller `vital-web` |
| `VITAL_SERVICES_TO_WEB_INTERNAL_SERVICE_KEY` | Outbound credential for caller `vital-services` |
| `VITAL_INTERNAL_SERVICE_KEY` | Legacy internal credential fallback |
| `INTERNAL_API_KEY` | Legacy shared-key authentication |
| `JWT_SECRET` | Legacy internal-key fallback; not a browser JWT verification flow |
| `GATEWAY_SECRET` | Validates Gateway-forwarded scaffolds |
| `GATEWAY_TRUST_ENABLED` | Defaults to enabled; local debug bypass only |
| `LOG_LEVEL`, `HTTP_LOGGING_ENABLED` | Structured redacted request logger settings |

Production requires explicit provider secret, database URL, both directional
keys, and `VITAL_WEB_URL`. Gateway secret is required when forwarding Gateway
requests. Keep credential directions distinct.

Compose `POSTGRES_*` settings configure containers. The application pool uses
`DATABASE_URL`; it does not build that URL from `POSTGRES_*` settings.

Older Auth client, RabbitMQ audit, Loki, and Prometheus environment tables
described desired integrations that are not read by the current service.
Do not infer those features from a retained template key. Adding them requires
implementation and contract verification.

EDA configuration is separate in `.env.eda.example`. No existing `.env` was
rewritten. All activation flags default off. Runtime database URLs identify
different non-superuser roles for `vital_core` and `vital_integrations`; migration
URLs are separate and must not be supplied to API/worker containers. Startup
checks reject DDL rights, superuser capabilities and other-database CONNECT.
PostgreSQL TLS is required in production and URL SSL overrides are rejected.
API requires a process certificate/CA plus the BFF's RSA public key and key ID;
worker requires a dedicated AMQPS vhost URL and CA. Delivery remains disabled
until central ingestion credentials and verified HTTPS are configured.
# Default-Off Registration Handoff

`VITAL_SERVICES_AUTH_REGISTRATION_KEY` defaults empty and is used only by the API
for online Auth provenance resolution. Use the matching distinct Auth key and
`VITAL_AUTH_INTERNAL_URL`; production requires private HTTPS. See
[contract and prerequisites](eda/registration-provenance.md).

## Coordinated VM Configuration

The canonical lead-developer variable inventory is
`Capstone_BGH/docs/deployment/vital-eda-environment-handoff.md`. Root target
templates separate `.env.vital_eda_api`, `.env.vital_eda_worker` and one-shot
`.env.vital_eda_tools`; the legacy `.env.vital_services` is not a shared target
credential file. The standalone `.env.eda.example` retains explicit URLs, while
the reviewed root launcher derives role-specific URLs from mounted secrets.
All target flags remain off. No actual environment or secret was changed.
