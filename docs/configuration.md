> **2026-10-28 superseding scope:** Specialty recommendation endpoints are retired (410). The 19-specialty TRACE lookup remains for manual selection. Booking is doctor/slot first, with NLP confirmation in final review. Appointment identity and record access require the separate six-digit-code policy, independently of AI flags. Deploy paired Web/Services contracts and provision dedicated access keys before cutover. See [the current implementation brief](vital-ai-implementation.md).

# VITAL configuration

The AI booking catalog is packaged at `assets/ai/department-catalog.json`, relative to the Services working directory (`/app` in containers). An environment-specific replacement can pin reviewed TRACE UUIDs at that same path; pins must still match active TRACE records and accepted aliases. No live UUIDs are shipped. See [department mapping](department-mapping.md).

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

## VITAL intelligence prototype

[Intelligent intake and analytics](intelligence.md) documents the new Core-owned AI tables, private Python/Node job runtimes, scoped APIs, encryption keys, feature flags, root Compose overlay and independently enforced appointment privacy. Specialty recommendations are retired. No legacy data is imported.

See the [production configuration reference](configuration-reference.md) for every service example variable, feature dependencies and the activation sequence.


See [portal rollout configuration](portal-consistency.md#admin-dashboard-and-rollout) for paired symptom analytics flags and disabled face verification.
