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

Staging keeps provider payments, external email/SMS and retention deletion disabled
unless separately enabled for an approved flow. Google Meet uses manually pasted
links; no dedicated Meet client credentials are required. Auth Google login is separate.
Use service-owned feature flags consistently across Web/API/worker. Never disable
OTP or enable shared sandbox bypasses for normal staging.

## VITAL intelligence prototype

[Intelligent intake and analytics](intelligence.md) documents the new Core-owned AI tables, private Python/Node job runtimes, scoped APIs, encryption keys, feature flags, root Compose overlay and independently enforced appointment privacy. Specialty recommendations are retired. No legacy data is imported.

See the [production configuration reference](configuration-reference.md) for every service example variable, feature dependencies and the activation sequence.


See [portal rollout configuration](portal-consistency.md#admin-dashboard-and-rollout) for paired symptom analytics flags and disabled face verification.


Manual Google Meet links replace the retired connection/generation feature. See [manual meeting workflow](manual-meet-links.md).

## Native TRACE disputes

See [the implemented contract and rollout ledger](integrations/trace/patient-feedback/VITAL_TRACE_Implementation_Changes_and_Verification.md). All native cross-system delivery uses Gateway; callbacks enter after JSON parsing and the existing Web mTLS/signed assertion boundary. `VITAL_TRACE_DISPUTES_ENABLED` defaults off. Complete resumes original payment/clinical checks; refund issuance is separate.
