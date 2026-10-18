# VITAL configuration

The root files are `.env.vital_infra`, `.env.vital_eda_api`,
`.env.vital_eda_worker`, `.env.vital_eda_web` and `.env.vital_eda_tools`.
`.env.compose` supplies host paths, image pins and published-port interpolation.
Matching examples define the supported keys. Never combine runtime env files or
put backend/database/provider secrets in Web.

Run `configure-vital.py` to create missing private material and synchronize
directional keys without overwriting existing cryptographic keys. Private files
live outside the checkout, are readable only by intended runtime identities and
are checked by `vital-env-preflight.mjs --check-files` before startup.

Web/API use mTLS plus signed assertions. Named Docker services may use explicitly
allowlisted internal HTTP in staging; external origins remain HTTPS. Databases,
broker and storage use separate scoped credentials. Preserve correlation IDs.

Staging keeps payments, automatic Google Meet creation, external email/SMS and
retention deletion disabled. Preserve configured Google client credentials in the
backend owner without enabling provider activity. Auth Google login is separate.
Use service-owned feature flags consistently across Web/API/worker. Never disable
OTP or enable shared sandbox bypasses for normal staging.
