# VITAL lead developer environment handoff

Updated: 2026-10-29. Target: complete VITAL business workflows with PayMongo SANDBOX, automatic Google Meet, NLP summaries and symptom analytics. This document is suitable for handing to the environment/deployment owner. It describes the current repository contracts, not proof that the deployed environment is configured.

## 1. Required outcome and boundaries

The finished environment must support registration/onboarding, manual doctor/specialty selection, published schedules, doctor/slot-first booking, OPQRST and factual AI summary confirmation, restricted doctor review, acceptance/rejection, PayMongo sandbox payment and reconciliation, automatic Meet, verbal appointment-code record unlock, messaging, clinical documents/QR assets, rescheduling/cancellation, follow-up, completion and administrator symptom analytics.

PayMongo remains test-mode: this environment must not collect real payments. Production Node/application mode, public HTTPS and normal authorization still apply. There are no OTP, identity, payment, consent or appointment-code bypasses. Do not activate E2E credential support or staff AI sandbox in the production runtime. AI is normalization and a deterministic summary, not diagnosis or specialty recommendation. External email/SMS transport belongs to Notifications and requires that owner's separate configuration.

## 2. Process and file ownership

| Process | Actual environment/config source | Must be running for |
|---|---|---|
| VITAL Web | Root .env.vital_eda_web, Web build arguments, Compose environment overrides | Browser pages, session checks, BFF, summary UI, appointment-code UI |
| Services API | Root .env.vital_eda_api plus .env.vital_ai when AI overlay is included | All business authorization and domain API operations |
| Ordinary Services worker | Root .env.vital_eda_worker | Outbox, broker consumers, payments, meetings, notifications, profile sync and timed lifecycle tasks |
| AI worker | .env.vital_eda_worker plus .env.vital_ai in the overlay | Intake analysis jobs, derived analytics, aggregation and cluster processing |
| Private Python NLP runtime | .env.vital_ai_runtime plus image/overlay settings | MedCAT/MiniLM normalization and DBSCAN execution |
| One-shot tools | .env.vital_eda_tools plus dedicated migration/provision secrets | Schema deployment, grants/provisioning, explicit maintenance |
| PostgreSQL and object storage | .env.vital_infra plus mounted bootstrap secrets | VITAL-owned data and files |
| Compose itself | .env.compose, explicitly supplied interpolation files or shell variables | Host paths, ports, images, build-time public values and overlay flag interpolation |

The repo-local .env.example files are references. Editing them alone has no runtime effect. Do not send the lead developer actual keys in this document. Supply secrets privately. Web must never receive backend DB/broker/storage/provider/data-encryption credentials. Python must never receive DB credentials.

Important precedence: explicit Compose environment values override env_file values. Compose interpolation is not populated automatically from a service's env_file. In compose.vital-ai.yaml, Web AI flags use interpolation with a false default. Set them in the environment used to parse Compose as well as the owning private files. Do not globally reuse shared NEXT_PUBLIC_APP_URL for another ecosystem frontend: verify the VITAL build receives VITAL's own public origin.

## 3. Exact feature settings for the requested full-feature setup

The following are intentional target values after dependencies are provisioned. Do not infer that current example defaults already have these values. Apply a flag only to a process that reads it.

| Setting | Web | API | Ordinary worker | AI worker |
|---|---|---|---|---|
| NODE_ENV | production | production | production | production |
| APP_ENV | production | not consumed | not consumed | not consumed |
| VITAL_EDA_ENABLED | true | true | true | true |
| VITAL_EDA_PROFILE_WRITES_ENABLED | not consumed | true | true where Profile is initialized | not needed for AI jobs |
| VITAL_EDA_CONSUMERS_ENABLED | not consumed | not a consumer loop | true | not a consumer loop |
| VITAL_EDA_DELIVERY_ENABLED | not consumed | not a delivery loop | true | not a delivery loop |
| VITAL_EDA_PROFILE_SYNC_ENABLED | not consumed | not a sync loop | true | not a sync loop |
| VITAL_EDA_APPOINTMENT_ENABLED | true | true | true | not needed for AI jobs |
| VITAL_EDA_APPOINTMENT_MAINTENANCE_ENABLED | not consumed | true where maintenance is initialized | true | not its maintenance loop |
| VITAL_EDA_PAYMENT_ENABLED | true | true | true | not needed for AI jobs |
| VITAL_EDA_PAYMENT_RECONCILE_ENABLED | not consumed | not a scan loop | true | not a scan loop |
| VITAL_EDA_RECORDS_ENABLED | true | true | true | not needed for AI jobs |
| VITAL_EDA_RECORDS_ARTIFACTS_ENABLED | not consumed | true | true | not needed for AI jobs |
| VITAL_EDA_VIDEO_ENABLED | true | true | true | not needed for AI jobs |
| VITAL_VIDEO_GOOGLE_ENABLED | never put provider config here | true | true | not needed for AI jobs |
| VITAL_EDA_VIDEO_MAINTENANCE_ENABLED | not consumed | not a scan loop | true | not a scan loop |
| VITAL_EDA_MESSAGING_ENABLED | true | true | true | not needed for AI jobs |
| VITAL_EDA_MESSAGE_HOLDS_ENABLED | true | true | true | not needed for AI jobs |
| VITAL_EDA_SSE_ENABLED | true | true | no Web/API stream endpoint | not needed for AI jobs |
| VITAL_EDA_COMPLETION_ENABLED | true | true | true | not needed for AI jobs |
| VITAL_EDA_PROFILE_QR_ENABLED | true | true | true where initialized | not needed for AI jobs |
| VITAL_AI_ENABLED | true | true | optional inherited value, not the AI job loop | true |
| VITAL_AI_PATIENT_ENABLED | true | true | not its request gate | optional inherited value |
| VITAL_AI_ANALYTICS_ENABLED | true | true | match if deployed code captures analytics there | true |

Keep destructive message retention disabled until the policy and deletion acceptance are explicitly approved: VITAL_EDA_MESSAGING_RETENTION_ENABLED=false and MESSAGE_RETENTION_APPROVED=false. Retention scanning is optional and is not required to send/read messages. Keep VITAL_EDA_PROVISION_BROKER=false for ordinary API/worker runs. Use it only in the explicit one-shot provisioner. Missing a retention policy approval is not a reason to disable normal appointment/chat features.

## 4. Provisioning worksheet: origins, identities and matching secrets

Before setting feature flags, the lead developer must obtain the following from the owning service/team.

| Item to obtain | Set in VITAL | Matching peer requirement |
|---|---|---|
| Public VITAL HTTPS origin | NEXT_PUBLIC_APP_URL, VITAL_PAYMENT_APP_ORIGIN, VITAL_VIDEO_APP_ORIGIN | Browser origin, reverse proxy and provider return URLs must agree |
| Public Gateway origin | NEXT_PUBLIC_API_GATEWAY_URL | Public routing/TLS works from a browser |
| Private Gateway address | GATEWAY_URL | Reachable from Web, correct internal HTTP allowlist or HTTPS trust |
| Gateway protected-call key | GATEWAY_SECRET | Same value in Gateway's VITAL integration configuration |
| VITAL registered Auth client | VITAL_AUTH_CLIENT_ID, VITAL_AUTH_CLIENT_SECRET | Auth client exists with approved redirects/system access |
| Web process Auth identity | VITAL_BFF_SERVICE_AUTH_ID | Dedicated valid service UUID, not an end-user UUID |
| Web-to-Auth profile key | VITAL_WEB_TO_AUTH_INTERNAL_SERVICE_KEY | Auth accepts this direction and limited purpose |
| Web registration key | VITAL_WEB_AUTH_REGISTRATION_KEY | Auth registration contract agrees |
| Services registration key | VITAL_SERVICES_AUTH_REGISTRATION_KEY | Auth receipt/lookup contract agrees |
| Auth-to-Web role lookup key | VITAL_INTERNAL_SERVICE_KEY | Auth's outbound VITAL role lookup uses the same key |
| Services-to-Auth profile key | VITAL_SERVICES_AUTH_PROFILE_KEY | Auth protected profile endpoint agrees |
| Worker-to-Auth stale key | VITAL_SERVICES_AUTH_STALE_KEY | Auth stale-state contract agrees |
| EHR recovery and mirror keys | VITAL_SERVICES_EHR_RECOVERY_KEY, VITAL_SERVICES_EHR_MIRROR_KEY | Two distinct EHR purposes, configured on the receiving owner |
| Audit delivery key | AUDIT_VITAL_INGEST_KEY | Audit accepts VITAL events |
| Notification delivery key | VITAL_NOTIFICATION_INGEST_KEY | Notification accepts VITAL events and recipient isolation |
| Legacy export read key | ANALYTICS_TO_VITAL_WEB_INTERNAL_SERVICE_KEY | Retained startup/compatibility contract remains configured while transition exists |
| Web signing identity | VITAL_BFF_SIGNING_KEY_ID, private signing file in Web, matching public file in API | Key ID/public key agree, old public keys retained during rotation |
| Private TLS identity | service CA, API server certificate/key, Web client certificate/key | Names, validity, trusted CA and intended peer identities agree |

Do not make every directional secret identical. Reuse only where the same peer-to-peer contract requires a match. AUTH_INTERNAL_URL is Web's narrow Auth internal address. VITAL_AUTH_INTERNAL_URL is Services/worker's address. VITAL_EHR_INTERNAL_URL is Services/worker's EHR address. Obtain actual internal DNS names/ports from the deployed topology rather than copying the sample strings unverified.

## 5. PayMongo SANDBOX: mandatory for the full paid journey

Set VITAL_EDA_PAYMENT_ENABLED=true consistently on Web, API and worker. Set VITAL_EDA_PAYMENT_RECONCILE_ENABLED=true on the ordinary worker. API and worker need PAYMONGO_SECRET_KEY from the sandbox account, starting sk_test_, and the correct VITAL_PAYMENT_APP_ORIGIN. Never put the key in Web or NEXT_PUBLIC variables.

Confirm the Core/Integrations billing migrations, scoped grants and RabbitMQ confirmation delivery are active. Exercise checkout, sandbox payment, provider reconciliation, appointment confirmation and refund/cancellation eligibility using the implemented routes. Do not mark an appointment paid manually to make record unlock work. Verify the deployed provider callback/webhook requirements against the maintained payment integration and configured transport before exposing any new public callback. A checkout redirect or browser success page alone is not proof of confirmed payment.

Acceptance evidence: one accepted synthetic booking receives a sandbox checkout, payment is reconciled once, the correct appointment becomes confirmed and replay does not duplicate payment or EHR work. An unpaid booking must remain unable to unlock records. This sandbox configuration does not permit real-money operation.

## 6. Automatic Google Meet: separate from Google login

On API and ordinary worker set VITAL_EDA_VIDEO_ENABLED=true, VITAL_VIDEO_GOOGLE_ENABLED=true and worker VITAL_EDA_VIDEO_MAINTENANCE_ENABLED=true. Set VITAL_VIDEO_APP_ORIGIN to VITAL's public HTTPS origin. Supply VITAL_VIDEO_GOOGLE_CLIENT_ID, mount the client-secret file selected by VITAL_VIDEO_GOOGLE_CLIENT_SECRET_FILE, and mount VITAL_VIDEO_KEYRING_FILE on every backend process that uses the provider.

Set VITAL_VIDEO_GOOGLE_REDIRECT_URI to exactly https://YOUR-VITAL-HOST/api/doctor/google-meet/callback and register that exact redirect for the dedicated Meet OAuth client. The repository provider uses the Meet meetings.space.created scope and OpenID user identity calls. Confirm the Google project/API/consent and account eligibility for that flow with the provider account owner. Do not reuse Auth's login tokens or assume an Auth Google login means Meet is connected.

Every participating doctor must complete the existing Connect Google Meet flow. Required runtime outbound access includes the Google OAuth token endpoint, OpenID identity endpoint and Meet API used by the implementation. Protect encrypted refresh credentials and retain the old keyring versions during rotation.

Meet keyring file format used by the code: {"activeKeyId":"v1","keys":{"v1":"BASE64_OF_32_RANDOM_BYTES"}}. Use privately generated keys, not literal placeholders. The regular intake/message map format is different.

Acceptance evidence: a connected doctor accepts an appointment with automatic Meet selected, a valid Meet link is returned after successful provider finalization, retries recover the same workflow without creating another case/charge, and reconnect/provider failures show a recoverable state. Joining the meeting must not require first unlocking patient records.

## 7. AI summary and symptom dashboard: all required parts

Set VITAL_AI_ENABLED=true, VITAL_AI_PATIENT_ENABLED=true and VITAL_AI_ANALYTICS_ENABLED=true on Web/API with the matching AI worker settings shown above. Keep staff sandbox activation absent/off in production. Supply .env.vital_ai from its maintained example to API and AI worker, and ensure Web's Compose interpolation receives the intended three true values. The overlay profile is vital-ai. Review the full merged Compose configuration to ensure the AI worker and Python runtime are actually included.

API and AI worker need identical VITAL_AI_ENCRYPTION_KEYS and VITAL_AI_ACTIVE_KEY_VERSION. VITAL_AI_CATALOG_FILE must point to the packaged symptom vocabulary inside the API image. Set VITAL_AI_RUNTIME_URL to the private Python service address, and share VITAL_AI_RUNTIME_KEY between AI worker and Python only. Never expose that endpoint or bearer key to browsers.

Python needs VITAL_AI_COORDINATION_URL with the existing shared heavyweight lease Redis ACL, AI_ASSET_DIR, BODHI_SOURCE_DIR and the prototype similarity settings. Keep one native inference thread, bounded child execution and the resource limits from the overlay. Build the model assets before runtime, retain attribution/licensing files and use offline inference. An HTTP health check is not evidence that the Redis lease, model loading and analysis succeeded.

Important integration check: confirm the AI worker can access both scoped DB secrets required by its current launcher, resolve the database network aliases, and use the expected runtime paths. Confirm it can acquire the shared AIMS-compatible lease without widening the Redis ACL. Never create a replacement shared lock contract just to pass startup.

Operational summaries use the dedicated appointment-access key map rather than relying on AI uptime. AI failure must preserve booking with a structured factual brief. Patient corrections and source assertions must be preserved. There is no LLM, vector DB, condition-routing artifact or new model training requirement.

Analytics starts only after the recorded activation timestamp. Create fresh eligible submissions after activation to verify it. Reschedules retain the original submission identity. Sandbox cases and legacy appointments do not populate the new dashboard. Small nonzero counts below five are suppressed. Separate adult/pediatric clustering needs known age, enough eligible samples and density. Nightly processing occurs at 02:00 hospital time with admin-triggered refresh also available. The implementation uses its existing hospital-time reporting contract, not the server's arbitrary local timezone.

Acceptance evidence: patient final review shows normalized symptoms, denials/uncertainty and readable corrections; confirmed fields generate a factual summary without diagnoses; failures preserve manual booking; admin symptom counts/coverage/trends and versioned clusters are returned without patient identity or raw complaint exposure.

## 8. Privacy, records, chat, files and completion prerequisites

Provision VITAL_APPOINTMENT_ACCESS_KEYS, VITAL_APPOINTMENT_ACCESS_ACTIVE_KEY_VERSION and VITAL_APPOINTMENT_ACCESS_DIGEST_KEY on API and ordinary worker even when AI is disabled. Encryption map and digest key must be separate generated 32-byte secrets. Keys protect retrievable six-digit codes, identity snapshots and durable briefs. Missing keys cannot be solved by removing privacy checks.

For Records, configure its keyring, EHR public verification keys, restricted storage endpoint/bucket/region/access pair, quarantine/final prefixes, mounted ClamAV socket/config and regular/bold fonts. API and worker both need the configuration/mounts used by their respective artifact paths. Provision the Profile QR bucket and its separate restricted storage principal/scanner settings. A volume path appearing in an env file does not mount it automatically.

For Messaging, configure identical MESSAGE_ENCRYPTION_KEYS and MESSAGE_ACTIVE_KEY_VERSION on API/worker. Enable messaging, applicable holds and SSE flags. Normal messaging requires neither retention approval nor retention deletion. Check the actual schedule-based send windows, reference-based locked labels and revocation behavior. Full chat history is not an administrator dashboard capability.

For completion, enable ordinary worker maintenance and verify the existing EHR/Records evidence and billing owner contracts. Run explicit appointment backfill only through the maintenance procedure outside active consultations. Historical access is limited to authorized episode evidence, not the patient's evolving unrelated EHR.

Acceptance evidence: locked doctor responses contain no identity/contact data, payment/acceptance alone cannot unlock, assigned doctor code redemption works only in its window, reschedule rotates codes, cancellation/withdrawal/completion revoke access, documents are scanned/rendered/downloaded under authorization and completion does not duplicate side effects.

## 9. Infrastructure and host interpolation worksheet

These values live in the deployment's Compose interpolation environment rather than being business-feature toggles:

| Variable | Required meaning |
|---|---|
| VITAL_EDA_SECRETS_DIR | Host directory holding mounted DB/broker passwords and private TLS/signing material referenced by Compose secrets. Create files before startup and restrict permissions. |
| VITAL_EDA_API_CONFIG_DIR | Existing host directory mounted read-only at /run/vital-config in the API. Contains the API's configured keyrings, trust keys, fonts and provider secret files. |
| VITAL_EDA_WORKER_CONFIG_DIR | Existing host directory mounted read-only at /run/vital-config in the ordinary worker. Must contain its matching required configuration files. |
| VITAL_EDA_SCANNER_DIR | Existing host directory for the shared ClamAV socket/config mounted at /run/clamav. Verify socket group permissions. |
| VITAL_RUNTIME_UID, VITAL_RUNTIME_GID | Container runtime UID/GID used for configured mounts and writable tmpfs. Align file access with these identities and the scanner group. |
| VITAL_EDA_SCANNER_IMAGE | Compatible scanner image pin where the maintained Compose definition uses it. |
| VITAL_DB_PORT | Optional host-published database port. Keep private or loopback-bound. Internal service DNS remains separate. |
| VITAL_STORAGE_PORT, VITAL_STORAGE_CONSOLE_PORT | Optional host storage ports. Keep private or loopback-bound. Never expose root administration publicly. |
| VITAL_WEB_PORT | Host mapping for Web. Public origin and reverse proxy must agree. |
| EDA_DATABASE_SUFFIX | Leave empty for the normal VITAL databases. The launcher reserves _test for separate isolated verification and rejects it for normal runtime. This is a tools/launcher selector, not a patient feature switch. |
| NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_API_GATEWAY_URL | Build-time public values for the actual Web image build. Verify which overlay/build args override shared workspace defaults. |
| VITAL_AI_ENABLED, VITAL_AI_PATIENT_ENABLED, VITAL_AI_ANALYTICS_ENABLED | Explicit true interpolation values needed by the AI overlay for Web, in addition to its service env files. |

Infrastructure bootstrap values POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, MINIO_ROOT_USER and MINIO_ROOT_PASSWORD belong only to .env.vital_infra. Root database/storage credentials must never be supplied to API, worker or Web. Runtime scoped passwords are mounted separately, including core_api_password, integrations_api_password, core_worker_password, integrations_worker_password and rabbit_runtime_password. Migrator/provisioner secrets belong only to tools. The existing launcher derives DB URLs and rejects unsafe runtime identities.

Compose sets internal health metadata file paths and some TLS paths directly. Use those actual container target paths when provisioning files. Example API env paths such as api-cert.pem are not authoritative when Compose explicitly overrides them with /run/secrets/api_cert. Inspect the merged service configuration, not an individual file in isolation.

## 10. Deployment order and lead-developer sign-off

1. Record compatible Web/Services/worker/NLP image revisions and the relevant owner contract revisions. Resolve outstanding CI failures before rollout. Do not infer that the guide itself fixes CI or deploys images.
2. Obtain every matching peer key and infrastructure credential in the worksheet. Privately generate independent encryption/signing/provider keys and mount the required files.
3. Configure public HTTPS origins, reverse proxy, Gateway routes, allowed private DNS/ports and provider outbound access. Ensure all process clocks are synchronized.
4. Apply migrations using tools credentials, grant scoped runtime access and provision the existing broker topology. Verify migrations succeeded before starting enabled API/worker processes. Prepare required buckets/scanner/fonts.
5. Verify Auth registration/login/OTP/session restoration, EHR profile/case/evidence, active TRACE specialties and doctor assignments, Audit and Notification ingestion. Configure and test doctor onboarding and published slots.
6. Configure PayMongo sandbox and dedicated Meet OAuth. Perform doctor Meet connection rather than assuming flags connect accounts automatically.
7. Start/recreate compatible API, ordinary worker and Web with matching feature configuration. Add the AI overlay/profile and start its two separate processes. Use the supported deployment/runbook for actual commands and secret paths.
8. Use docker compose config --quiet with the exact intended files/interpolation inputs to validate structure. Do not paste a full rendered config into tickets or chat because it may include secrets. Privately inspect effective flag names and mounted file targets. Verify relevant process health and content-free logs.
9. Perform the feature acceptance cases below. Confirm new post-activation analytics data, state transitions, code grants and provider results from authorized views rather than only HTTP health.
10. Record each result, actual image revisions, migration version and peer readiness. The lead developer should list any disabled capability explicitly. Do not describe the environment as fully working until each required row passes.

| Feature acceptance | Required evidence |
|---|---|
| Identity and onboarding | Patient and doctor login/OTP/session restore work and doctor specialty matches current TRACE lookup |
| Booking and concurrency | Published slot can be booked, conflicting concurrent booking is rejected and answers survive date changes |
| AI summary | Normalized symptoms/corrections appear, factual summary matches confirmed fields and NLP failure preserves booking |
| Doctor review | Only reference, age/sex and sanitized intake are visible before unlock |
| Acceptance and EHR handoff | Case created once, blank complaint uses separately approved handoff and patient sees code |
| PayMongo sandbox | Test checkout and reconciliation confirm only the correct appointment with idempotent retries |
| Automatic Meet | Connected doctor's automatic generation produces one valid meeting and recovers pending provider operations |
| Appointment code | Leading zeros, wrong doctor/code, expired window, lockout, reissue and replay are enforced |
| Records/documents/QR | Authorized upload/scan/render/download works and revoked users cannot keep downloading |
| Messaging/live updates | Schedule windows and reference labels are correct, live updates work and administrator metadata does not expose transcripts |
| Reschedule/cancel/follow-up | Counters, approvals, billing linkage, meeting handling and code invalidation/new-booking rules remain consistent |
| Completion | Required notes/evidence persist, timed maintenance runs and live access ends correctly |
| Analytics | Activation, deduplication, corrections, symptom coverage, suppressed counts and exploratory cluster versions are correct |
| Audit/Notifications | Real background delivery succeeds and retries do not duplicate events or leak identities/codes |

The current repo examples intentionally contain blank secrets and off-by-default optional providers/AI. Use the exact target matrix above for the requested environment after prerequisites are ready. Keep PayMongo SANDBOX explicitly identified in deployment notes. No private .env was changed, no keys were generated, no database was migrated and no feature was activated by writing this guide.

---

# Detailed variable dictionary and supporting procedures


Updated: 2026-10-29. Source-based production preparation guide for the current summary and appointment-code implementation. No real secrets or runtime settings were changed by this documentation update.

## Should every switch be enabled?

No. Enable the domain workflows together, then opt into AI and external test providers after their dependencies are ready. Provider credentials, migrations, mounted keys, running workers and cross-system contracts are required in addition to flags. The examples intentionally keep Payment, Google provider activity, AI and destructive retention off. They are configuration references, not a ready-to-run environment.

PayMongo sandbox/test mode is retained as requested. Live financial transactions are not enabled by this configuration. Test credential-support and staff AI sandbox variables are omitted from production examples and remain disabled by their runtime defaults. Retention deletion requires its own policy approval. Appointment masking and six-digit-code enforcement are mandatory and independent of AI flags. There is no specialty-routing file or clinical-routing approval gate in the revised scope.

## Which files actually control the containers?

The service-local .env.example files document supported variables. For the supported deployment, edit private copies of the process-specific examples in Capstone_BGH: .env.vital_eda_web, .env.vital_eda_api, .env.vital_eda_worker, .env.vital_eda_tools and .env.vital_infra. Compose also uses .env.compose for interpolation, ports, host paths and image pins. Copying service .env.example alone does not configure this topology.

The AI overlay uses .env.vital_ai for API/AI-worker configuration and .env.vital_ai_runtime for Python. Its Web flags use Compose interpolation: explicitly supply those same flags in the Compose interpolation environment, not only in .env.vital_ai. Keep values consistent with .env.vital_eda_web. Consult compose.vital-ai.yaml before assembling the stack. Starting or retiring the legacy VITAL analytics services remains an explicit cutover operation.

Web receives no database, broker, storage, model or data-encryption secrets. API and workers use different scoped database identities. The ordinary delivery worker and the AI worker are separate processes. Python has no database credentials.

## Feature activation matrix

| Capability | Set true | Other requirements |
|---|---|---|
| Core booking and consent | VITAL_EDA_ENABLED, VITAL_EDA_APPOINTMENT_ENABLED, VITAL_EDA_COMPLETION_ENABLED | Auth/Gateway, verified TRACE specialties and doctor assignments, published slots, Core migrations, EHR contracts, dedicated appointment keys |
| Profile onboarding | VITAL_EDA_PROFILE_WRITES_ENABLED in Services | Auth/EHR peers and registration/profile keys |
| Background lifecycle | VITAL_EDA_CONSUMERS_ENABLED, VITAL_EDA_DELIVERY_ENABLED, VITAL_EDA_PROFILE_SYNC_ENABLED, VITAL_EDA_APPOINTMENT_MAINTENANCE_ENABLED | Running ordinary worker, RabbitMQ topology, peer ingestion keys |
| Pay for an accepted booking | VITAL_EDA_PAYMENT_ENABLED on Web/API/worker, VITAL_EDA_PAYMENT_RECONCILE_ENABLED on worker | sk_test_ key, billing migrations, test-provider account and confirmed event delivery |
| Documents and records | VITAL_EDA_RECORDS_ENABLED, VITAL_EDA_RECORDS_ARTIFACTS_ENABLED in backend | Trusted EHR signing keys, Records keyring, restricted storage, scanner, fonts, appointment access grant |
| Chat and live updates | VITAL_EDA_MESSAGING_ENABLED, VITAL_EDA_SSE_ENABLED | Shared message keys, allowed appointment window, API streams and worker consumers |
| Administrative holds | VITAL_EDA_MESSAGE_HOLDS_ENABLED | Messaging enabled and administrator authority |
| Meeting links | VITAL_EDA_VIDEO_ENABLED | Meeting URL validation and configured public origin |
| Automatic Google Meet | VITAL_VIDEO_GOOGLE_ENABLED in backend, VITAL_EDA_VIDEO_MAINTENANCE_ENABLED on worker | Dedicated Meet OAuth client, mounted secret/keyring, registered callback, doctor connection |
| Doctor payment QR | VITAL_EDA_PROFILE_QR_ENABLED | Separate restricted QR storage and scanner |
| Patient AI summary | VITAL_AI_ENABLED, VITAL_AI_PATIENT_ENABLED on Web/API and master AI on AI worker | AI keys, migrated tables, assets, running AI worker and private Python runtime |
| Symptom analytics | VITAL_AI_ENABLED, VITAL_AI_ANALYTICS_ENABLED on Web/API/AI worker | Recorded activation, eligible new submissions and successful derived processing |

A complete paid consultation test needs Payment working. Payment disabled is not an unlock bypass: confirmed/payment eligibility, current consent, assigned doctor and valid code are still checked. Acceptance alone never reveals full records.

## Shared keys and secrets

Provision unique random values privately. No actual secret should be committed. Encryption maps have the form {"1":"BASE64_OF_32_RANDOM_BYTES"} with active version 1. Use a different random key for each purpose: AI intake, appointment encryption, appointment HMAC, messages and provider keyrings. The Python bearer key is a separate random string of at least 32 characters.

API and ordinary worker share appointment keys. API and AI worker share intake keys. API/worker share message keys. The AI worker and Python share the private runtime bearer key. Web signs assertions with its private key, while API holds the matching public key and key ID. Keyring-file formats for Records/Video must follow the existing provisioning contracts rather than assuming the flat intake-map format. Retain old versions when rotating encryption keys.

## Service variable reference

Tables list every active assignment in the revised service .env.example files. Defaults shown are sample values, not proof that a mounted file or peer exists. Blank values must be provisioned when the dependent feature is enabled. true and false are case-sensitive literal strings.

### vital-services/.env.example

| Variable | Example default | Purpose |
|---|---|---|
| `NODE_ENV` | `production` | Node runtime mode. Use production for built container runs, even on a testing server. This also affects secure cookies. |
| `VITAL_EDA_PRIVATE_HTTP` | `true` | Permits only code-allowlisted internal HTTP/database/broker hosts. Does not turn off Web-to-API mTLS or allow arbitrary insecure URLs. |
| `VITAL_EDA_ENABLED` | `true` | Master EDA/BFF domain mode. true on Web, API and worker for the maintained architecture. |
| `VITAL_EDA_PROFILE_WRITES_ENABLED` | `true` | Services Profile writes and materialization. API/worker only. |
| `VITAL_EDA_CONSUMERS_ENABLED` | `true` | Start ordinary worker event consumers. Required for asynchronous lifecycle projections. |
| `VITAL_EDA_DELIVERY_ENABLED` | `true` | Worker delivery to Audit, Notifications and profile-sync owners. Requires peer URLs and directional keys. |
| `VITAL_EDA_PROFILE_SYNC_ENABLED` | `true` | Worker profile synchronization. Requires Auth and EHR directional configuration. |
| `VITAL_EDA_PAYMENT_ENABLED` | `false` | Expose Payment operations. Match Web/API/worker. Requires PayMongo test configuration and billing infrastructure. |
| `VITAL_EDA_PAYMENT_RECONCILE_ENABLED` | `false` | Worker payment reconciliation. Backend worker only. Pair with Payment enabled and test-provider configuration. |
| `VITAL_EDA_APPOINTMENT_ENABLED` | `true` | Appointment scheduling, requests, changes and lifecycle. Match Web/API/worker. |
| `VITAL_EDA_APPOINTMENT_MAINTENANCE_ENABLED` | `true` | Worker expiry and automatic appointment completion tasks. Required for testing timed lifecycle behavior. |
| `VITAL_EDA_RECORDS_ENABLED` | `true` | Authorized clinical records and document workflows. Match Web/API/worker. Requires EHR, payment/access authority and Records keys. |
| `VITAL_EDA_RECORDS_ARTIFACTS_ENABLED` | `true` | Backend record artifact rendering/scanning/publication. Requires storage, fonts and ClamAV. |
| `VITAL_EDA_VIDEO_ENABLED` | `true` | Meeting arrangement and doctor connection workflows. Match Web/API/worker. Does not itself enable Google OAuth/provider calls. |
| `VITAL_EDA_VIDEO_MAINTENANCE_ENABLED` | `false` | Worker recovery/maintenance for meeting workflows. Enable with Video and required provider dependencies for timed recovery tests. |
| `VITAL_EDA_MESSAGING_ENABLED` | `true` | Appointment-scoped messaging. Match Web/API/worker and provision shared message encryption keys. |
| `VITAL_EDA_MESSAGE_HOLDS_ENABLED` | `true` | Administrative message hold controls. Requires messaging. Does not allow administrators to read transcripts. |
| `VITAL_EDA_MESSAGING_RETENTION_SCAN_ENABLED` | `false` | Worker retention eligibility scanning. Separate from destructive deletion and useful only for explicit retention testing. |
| `VITAL_EDA_MESSAGING_RETENTION_ENABLED` | `false` | Destructive message retention processing. Keep false for ordinary testing. Requires policy approval and separate acceptance. |
| `VITAL_EDA_SSE_ENABLED` | `true` | Appointment/message live streams. Match Web/API, and keep required domain flags enabled. |
| `VITAL_EDA_COMPLETION_ENABLED` | `true` | Completion dashboard, patient consent and reporting projections. Match Web/API/worker. |
| `VITAL_EDA_PROFILE_QR_ENABLED` | `true` | Doctor payment-QR profile assets. Match Web/API and configure separate storage/scanner. |
| `VITAL_PAYMENT_APP_ORIGIN` | `https://vital.example.invalid` | Public VITAL origin for payment return links. Match the real testing origin. |
| `PAYMONGO_SECRET_KEY` | `(empty)` | Services-only PayMongo test secret, starting sk_test_. Required when Payment is enabled. Never use a live key for this test setup. |
| `VITAL_RECORDS_KEYRING_FILE` | `/run/vital-config/records-keyring.json` | Mounted versioned Records cryptographic keyring JSON. Use the existing provisioning format and retain old keys. |
| `VITAL_EHR_RECORDS_PUBLIC_KEYS_FILE` | `/run/vital-config/ehr-records-public.json` | Mounted trusted EHR public keys for verifying signed clinical evidence. Match the EHR signing configuration. |
| `VITAL_AUTH_INTERNAL_URL` | `http://auth-api:8000` | Services/worker address for protected Auth owner contracts. |
| `VITAL_SERVICES_AUTH_PROFILE_KEY` | `(empty)` | Services-to-Auth protected profile verification key. |
| `VITAL_RECORDS_STORAGE_ENDPOINT` | `http://minio:9000` | Records: private S3-compatible storage endpoint. |
| `VITAL_RECORDS_STORAGE_PUBLIC_ENDPOINT` | `https://gateway.example.invalid/media/vital-web` | Records: permitted public storage endpoint where applicable, not an access-control bypass. |
| `VITAL_RECORDS_STORAGE_BUCKET` | `vital-records` | Records: pre-created bucket accessible by this restricted principal. |
| `VITAL_RECORDS_STORAGE_REGION` | `us-east-1` | Records: storage signing region. |
| `VITAL_RECORDS_STORAGE_ACCESS_KEY` | `(empty)` | Records: restricted bucket principal access ID, never a root credential. |
| `VITAL_RECORDS_STORAGE_SECRET_KEY` | `(empty)` | Records: secret for that restricted storage principal. |
| `VITAL_RECORDS_QUARANTINE_PREFIX` | `quarantine/records/` | Storage prefix for untrusted files pending validation and malware scan. |
| `VITAL_RECORDS_FINAL_PREFIX` | `records/final/` | Storage prefix for approved finalized clinical artifacts. |
| `VITAL_RECORDS_CLAMAV_SOCKET` | `/run/clamav/clamd.sock` | Mounted Unix socket of the ClamAV scanner. Enable scanner infrastructure before file uploads. |
| `VITAL_RECORDS_CLAMAV_CONFIG` | `/run/clamav/clamd.conf` | Mounted ClamAV configuration file used by scanner integration. |
| `VITAL_RECORDS_FONT_REGULAR_FILE` | `/run/vital-config/regular.ttf` | Mounted regular font file needed for document rendering. |
| `VITAL_RECORDS_FONT_BOLD_FILE` | `/run/vital-config/bold.ttf` | Mounted bold font file needed for document rendering. |
| `VITAL_EHR_INTERNAL_URL` | `http://uhse-ehr-api:8008` | Services/worker address for protected EHR recovery and mirror contracts. |
| `VITAL_SERVICES_EHR_RECOVERY_KEY` | `(empty)` | Read-only recovery key for existing authorized EHR operations. Does not authorize creating a new operation. |
| `VITAL_VIDEO_GOOGLE_ENABLED` | `false` | Backend Google Meet OAuth/provider operations. Requires the separate Meet client and real doctor authorization. Leave false for manual meeting-link testing. |
| `VITAL_VIDEO_APP_ORIGIN` | `https://vital.example.invalid` | Public VITAL origin used by the dedicated doctor Google Meet connection flow. |
| `VITAL_VIDEO_GOOGLE_CLIENT_ID` | `(empty)` | Backend-owned OAuth client ID for doctor Meet authorization. This is separate from Auth Google login. |
| `VITAL_VIDEO_GOOGLE_CLIENT_SECRET_FILE` | `/run/vital-config/meet-client-secret` | Mounted file containing the Meet OAuth client secret. Never put it in Web. |
| `VITAL_VIDEO_GOOGLE_REDIRECT_URI` | `https://vital.example.invalid/api/doctor/google-meet/callback` | Exact registered Meet OAuth callback URL, ending /api/doctor/google-meet/callback. Must match Google client settings. |
| `VITAL_VIDEO_KEYRING_FILE` | `/run/vital-config/meet-keyring.json` | Mounted versioned encryption keyring for provider credentials. Keep separate from intake, access-code and messaging keys. |
| `MESSAGE_ENCRYPTION_KEYS` | `(empty)` | JSON object mapping positive version numbers to base64 32-byte message encryption keys. API and worker must agree. Retain old versions. |
| `MESSAGE_ACTIVE_KEY_VERSION` | `(empty)` | Version in MESSAGE_ENCRYPTION_KEYS used for new message encryption. |
| `MESSAGE_RETENTION_APPROVED` | `false` | Explicit approval prerequisite for destructive message retention processing. Not a normal feature-enablement switch. |
| `MESSAGE_RETENTION_POLICY_APPROVAL_ID` | `(empty)` | Recorded policy approval identifier required by approved retention configuration. |
| `VITAL_EDA_API_PORT` | `8443` | Private Services API listening port. Web transport and container ports must agree. |
| `VITAL_SERVICE_CA_FILE` | `/run/secrets/service_ca` | CA bundle for verifying the private Web/API certificates. Mount the actual file. |
| `VITAL_API_TLS_CERT_FILE` | `/run/secrets/api-cert.pem` | Services server certificate. Its name must match the private API URL and trust configuration. |
| `VITAL_API_TLS_KEY_FILE` | `/run/secrets/api-key.pem` | Services server private TLS key. |
| `VITAL_BFF_SIGNING_KEY_ID` | `vital-bff-v1` | Active actor-assertion signing key ID. Web private key and Services public verification key must match. |
| `VITAL_BFF_SIGNING_PUBLIC_KEY_FILE` | `/run/secrets/bff-public.pem` | Services-mounted public key that verifies Web actor assertions. |
| `VITAL_BFF_PREVIOUS_PUBLIC_KEYS_FILE` | `(empty)` | Optional JSON verification key map for rotated Web signing keys. Leave blank when no previous key is required. |
| `VITAL_SERVICES_AUTH_REGISTRATION_KEY` | `(empty)` | Services-to-Auth registration receipt lookup key. Distinct from profile and stale-state keys. |
| `VITAL_PROFILE_QR_STORAGE_ENDPOINT` | `http://minio:9000` | Profile QR: private S3-compatible storage endpoint. |
| `VITAL_PROFILE_QR_STORAGE_BUCKET` | `vital-profile` | Profile QR: pre-created bucket accessible by this restricted principal. |
| `VITAL_PROFILE_QR_STORAGE_REGION` | `us-east-1` | Profile QR: storage signing region. |
| `VITAL_PROFILE_QR_STORAGE_ACCESS_KEY` | `(empty)` | Profile QR: restricted bucket principal access ID, never a root credential. |
| `VITAL_PROFILE_QR_STORAGE_SECRET_KEY` | `(empty)` | Profile QR: secret for that restricted storage principal. |
| `VITAL_PROFILE_QR_CLAMAV_SOCKET` | `/run/clamav/clamd.sock` | Mounted Unix socket of the ClamAV scanner. Enable scanner infrastructure before file uploads. |
| `VITAL_PROFILE_QR_CLAMAV_CONFIG` | `/run/clamav/clamd.conf` | Mounted ClamAV configuration file used by scanner integration. |
| `VITAL_APPOINTMENT_ACCESS_KEYS` | `{}` | JSON map of version to base64 32-byte AES key for durable appointment summaries, identity snapshots and retrievable access codes. API and worker must agree. Required even with AI disabled. |
| `VITAL_APPOINTMENT_ACCESS_ACTIVE_KEY_VERSION` | `1` | Active version present in VITAL_APPOINTMENT_ACCESS_KEYS. Preserve previous versions for decrypting existing records. |
| `VITAL_APPOINTMENT_ACCESS_DIGEST_KEY` | `(empty)` | Separate base64 32-byte HMAC key for six-digit code verification. Match API/worker. Not the six-digit code and not interchangeable with the encryption key. |
| `VITAL_AI_ENABLED` | `false` | Master normalization/analytics module. Enable on Web/API/AI worker for AI testing. Does not start the separate AI processes. |
| `VITAL_AI_PATIENT_ENABLED` | `false` | Patient symptom normalization and confirmation in doctor/slot-first final review. Match Web/API. Requires master AI flag, intake keys and functioning worker/runtime. |
| `VITAL_AI_ANALYTICS_ENABLED` | `false` | Post-activation derived symptom dashboard and processing. Match Web/API/AI worker with master AI enabled. Separate from patient normalization. |
| `VITAL_AI_ENCRYPTION_KEYS` | `{}` | JSON map of version to base64 32-byte intake/draft encryption key. Match API and AI worker. Separate from appointment access, Auth, messaging and model configuration. |
| `VITAL_AI_ACTIVE_KEY_VERSION` | `1` | Version in VITAL_AI_ENCRYPTION_KEYS used for newly encrypted intake data. |
| `VITAL_AI_CATALOG_FILE` | `/app/assets/ai/symptoms.json` | Services-readable packaged canonical symptom JSON path. Container default /app/assets/ai/symptoms.json. Use a real absolute path for a host-run process. |
| `VITAL_AI_RUNTIME_URL` | `http://vital-ai-runtime:8020` | AI worker address of the private Python runtime. No public ingress is needed. |
| `VITAL_AI_RUNTIME_KEY` | `(empty)` | Private runtime bearer secret of at least 32 characters. AI worker and Python runtime must match. Never place it in Web. |
| `VITAL_AUDIT_URL` | `http://audit-service:8081` | Worker-reachable Audit ingestion owner URL. |
| `AUDIT_VITAL_INGEST_KEY` | `(empty)` | Worker-to-Audit ingestion key, matched to Audit service configuration. |
| `VITAL_NOTIFICATION_URL` | `http://notification-api:8000` | Worker-reachable Notification ingestion owner URL. External email/SMS delivery is configured by that owner. |
| `VITAL_NOTIFICATION_INGEST_KEY` | `(empty)` | Worker-to-Notification directional ingestion key. |
| `VITAL_SERVICES_AUTH_STALE_KEY` | `(empty)` | Worker-to-Auth stale-profile/session signaling key. |
| `VITAL_SERVICES_EHR_MIRROR_KEY` | `(empty)` | Worker-to-EHR doctor/profile mirror key. |
| `VITAL_EDA_PROVISION_BROKER` | `false` | Explicit tools-only broker topology provisioning. Keep false in ordinary API/worker runs. Use provisioning credentials only in tools. |

### vital-web/.env.example

Backend-only worker flags were removed from this example because Web never reads them. Configure those flags in the API/worker environment instead.

| Variable | Example default | Purpose |
|---|---|---|
| `NODE_ENV` | `production` | Node runtime mode. Use production for built container runs, even on a testing server. This also affects secure cookies. |
| `VITAL_EDA_PRIVATE_HTTP` | `true` | Permits only code-allowlisted internal HTTP/database/broker hosts. Does not turn off Web-to-API mTLS or allow arbitrary insecure URLs. |
| `PORT` | `3001` | Web listening port. Does not change the external public URL. |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3001` | Actual browser-visible VITAL origin, including scheme and port. Used by same-origin checks and callbacks. Rebuild Web when changing public build-time values. |
| `NEXT_PUBLIC_API_GATEWAY_URL` | `http://localhost:8080` | Public Gateway URL available to browser code. Never place a private container hostname or credentials here. |
| `NEXT_PUBLIC_SYSTEM_SLUG` | `vital` | Public system identifier. Keep vital for VITAL authorization context. |
| `GATEWAY_URL` | `http://bgh-gateway:8080` | Gateway address reachable by the Web server. Can differ from its browser-visible URL. |
| `GATEWAY_SECRET` | `(empty)` | Shared Gateway trust secret for protected integration/readiness traffic. Match the configured peer secret. |
| `VITAL_AUTH_CLIENT_ID` | `bgh_vital_client` | Registered VITAL Auth client identifier. Preferred name rather than legacy VITAL_CLIENT_ID. |
| `VITAL_AUTH_CLIENT_SECRET` | `(empty)` | Server-only VITAL Auth client secret. Preferred name rather than legacy VITAL_CLIENT_SECRET. |
| `AUTH_INTERNAL_URL` | `http://auth-api:8000` | Web server address for narrowly authorized Auth internal contracts. Ordinary session/login flows remain Gateway-owned. |
| `VITAL_WEB_AUTH_REGISTRATION_KEY` | `(empty)` | Web-to-Auth registration-only directional key. Match Auth configuration. |
| `VITAL_WEB_TO_AUTH_INTERNAL_SERVICE_KEY` | `(empty)` | Web-to-Auth profile/name enrichment key. Distinct from inbound VITAL_INTERNAL_SERVICE_KEY. |
| `VITAL_INTERNAL_SERVICE_KEY` | `(empty)` | Inbound Auth-to-Web role aggregation key. Not a generic outbound authorization key. |
| `ANALYTICS_TO_VITAL_WEB_INTERNAL_SERVICE_KEY` | `(empty)` | Inbound read-only legacy Analytics submitted-intake export key. Keep while that protected compatibility contract is retained. |
| `TRACE_API_URL` | `https://REPLACE-trace.internal` | Legacy required Web startup validation field. Clinical specialty lookups now call Gateway /trace/api/departments/lookup?category=specialty with the current session token. |
| `VITAL_BFF_SERVICE_AUTH_ID` | `(empty)` | Dedicated Auth UUID used by the Web process for signed service operations. Not a patient or doctor UUID. |
| `VITAL_EDA_API_URL` | `https://api:8443` | Private HTTPS Services API URL reachable by Web and covered by the API certificate. |
| `VITAL_BFF_SIGNING_KEY_ID` | `vital-bff-v1` | Active actor-assertion signing key ID. Web private key and Services public verification key must match. |
| `VITAL_BFF_SIGNING_PRIVATE_KEY_FILE` | `/run/secrets/bff_private` | Web-only mounted private signing key path. Never copy into Services or browser variables. |
| `VITAL_BFF_TLS_CERT_FILE` | `/run/secrets/bff_cert` | Web client certificate for the private Services mTLS connection. |
| `VITAL_BFF_TLS_KEY_FILE` | `/run/secrets/bff_key` | Private key for the Web mTLS client certificate. |
| `VITAL_SERVICE_CA_FILE` | `/run/secrets/service_ca` | CA bundle for verifying the private Web/API certificates. Mount the actual file. |
| `VITAL_RECORDS_PUBLIC_MEDIA_PREFIX` | `(empty)` | Optional permitted public-media URL prefix used when validating rendered assets. Not a substitute for appointment record authorization. |
| `VITAL_EDA_ENABLED` | `true` | Master EDA/BFF domain mode. true on Web, API and worker for the maintained architecture. |
| `VITAL_EDA_PAYMENT_ENABLED` | `false` | Expose Payment operations. Match Web/API/worker. Requires PayMongo test configuration and billing infrastructure. |
| `VITAL_EDA_APPOINTMENT_ENABLED` | `true` | Appointment scheduling, requests, changes and lifecycle. Match Web/API/worker. |
| `VITAL_EDA_RECORDS_ENABLED` | `true` | Authorized clinical records and document workflows. Match Web/API/worker. Requires EHR, payment/access authority and Records keys. |
| `VITAL_EDA_VIDEO_ENABLED` | `true` | Meeting arrangement and doctor connection workflows. Match Web/API/worker. Does not itself enable Google OAuth/provider calls. |
| `VITAL_EDA_MESSAGING_ENABLED` | `true` | Appointment-scoped messaging. Match Web/API/worker and provision shared message encryption keys. |
| `VITAL_EDA_MESSAGE_HOLDS_ENABLED` | `true` | Administrative message hold controls. Requires messaging. Does not allow administrators to read transcripts. |
| `VITAL_EDA_SSE_ENABLED` | `true` | Appointment/message live streams. Match Web/API, and keep required domain flags enabled. |
| `VITAL_EDA_COMPLETION_ENABLED` | `true` | Completion dashboard, patient consent and reporting projections. Match Web/API/worker. |
| `VITAL_EDA_PROFILE_QR_ENABLED` | `true` | Doctor payment-QR profile assets. Match Web/API and configure separate storage/scanner. |
| `VITAL_AI_ENABLED` | `false` | Master normalization/analytics module. Enable on Web/API/AI worker for AI testing. Does not start the separate AI processes. |
| `VITAL_AI_PATIENT_ENABLED` | `false` | Patient symptom normalization and confirmation in doctor/slot-first final review. Match Web/API. Requires master AI flag, intake keys and functioning worker/runtime. |
| `VITAL_AI_ANALYTICS_ENABLED` | `false` | Post-activation derived symptom dashboard and processing. Match Web/API/AI worker with master AI enabled. Separate from patient normalization. |
| `APP_ENV` | `production` | Production application environment. Test credential support is rejected in this mode. |
| `LOG_LEVEL` | `info` | Server diagnostic verbosity. info is suitable for workflow testing. Never add clinical data or credentials to logs. |
| `HTTP_LOGGING_ENABLED` | `true` | Set false to disable supported outbound HTTP metadata logging. Does not grant API access. |

## Private Python runtime variables

Set these in the private .env.vital_ai_runtime used by the AI overlay, never in Web.

| Variable | Purpose |
|---|---|
| VITAL_AI_RUNTIME_KEY | Same at-least-32-character bearer secret as the AI worker. |
| VITAL_AI_COORDINATION_URL | Existing shared Redis connection with narrowly scoped access to analytics:heavy-work:lease. No patient data is stored in Redis. Required to acquire heavyweight-work capacity shared with AIMS. |
| AI_ASSET_DIR | Built offline model assets, normally /opt/vital-ai-assets. Models are downloaded at image build time. |
| BODHI_SOURCE_DIR | Bundled vocabulary source, normally /app/vendor/bodhi-s. |
| AI_SIMILARITY_THRESHOLD | Prototype normalization similarity threshold, currently 0.70. Version/evaluate changes rather than using it as an accuracy switch. |
| AI_SIMILARITY_MARGIN | Prototype separation margin, currently 0.05. Changing it affects matching/abstention behavior. |
| OMP_NUM_THREADS, MKL_NUM_THREADS, OPENBLAS_NUM_THREADS | Keep 1 for the bounded one-child inference runtime. |
| TOKENIZERS_PARALLELISM | Keep false to avoid additional tokenizer workers. |
| HF_HUB_OFFLINE, TRANSFORMERS_OFFLINE | Image config keeps offline inference. Do not rely on runtime internet model downloads. |

The overlay limits Python to 2 GiB and the orchestration worker to 256 MiB. A /health response means the HTTP process is alive, not that model inference and coordination have passed acceptance.

## Launcher, TLS and maintenance variables

These are process-specific infrastructure/tool inputs rather than toggles to copy into Web:

| Variable | Owner and purpose |
|---|---|
| VITAL_CORE_DATABASE_URL, VITAL_INTEGRATIONS_DATABASE_URL | Runtime launcher builds these from mounted role-specific secrets. For direct host execution, provide separate scoped non-superuser credentials for vital_core and vital_integrations on the same host. Do not use Auth's database or migration identities. |
| VITAL_DATABASE_CA_FILE | Trusted PostgreSQL CA for verified TLS outside the explicitly allowlisted private Compose transport. |
| VITAL_RABBITMQ_URL, VITAL_RABBITMQ_CA_FILE | Ordinary worker's scoped VITAL broker connection and trust bundle. Launcher derives the URL in supported containers. |
| VITAL_RABBITMQ_PROVISION_URL | Tools-only privileged topology connection. Never put provisioning credentials in Web or the ordinary worker. |
| VITAL_CORE_MIGRATION_URL, VITAL_INTEGRATIONS_MIGRATION_URL | Tools-only migration connections. Do not expose them to runtime identities. |
| VITAL_APPOINTMENT_ACCESS_MAINTENANCE | Explicit maintenance-only backfill opt-in. Not a permanent API feature flag. Follow the backfill entrypoint/runbook outside active consultations. |
| VITAL_BASELINE_SEED, VITAL_BASELINE_VERIFY | Explicit seed tooling and verification, not runtime settings. Do not seed over an existing environment to fix a flag problem. |
| VITAL_CATALOG_RECOVERY_MODE | Tools-only specialty catalog snapshot/restore operation. Not normal startup. |

## Production preparation and acceptance sequence

1. Finish the promotion fixes and deploy compatible Web, Services, ordinary worker and NLP images. A successful PR check alone does not activate functionality. Build Web with the correct public origins.
2. Provision private certificates, peer keys, restricted storage identities, message keys, appointment keys and AI keys. Confirm mounted file paths exist inside their respective containers. Use the existing configure-vital and environment-preflight tools after reviewing their current supported fields. Do not assume those tools already generate the new AI/access secrets.
3. Apply Core and Integrations migrations through the tools identity. Both intelligent-intake and appointment-access migrations must be present. Apply the required scoped runtime grants. Provision the VITAL RabbitMQ topology with the tools identity.
4. Verify Auth/Gateway login and session restoration, patient onboarding/EHR profile, doctor membership, active TRACE specialty UUIDs, available doctor slots and EHR case/evidence contracts. No specialty fallback or invented UUID should be used to hide a lookup failure.
5. Start the ordinary API/worker with matching domain flags. Confirm Audit, Notification, Auth profile sync and EHR mirror delivery. In-app notifications and external email/SMS are different owner configurations.
6. Configure PayMongo TEST credentials and enable Payment plus worker reconciliation for the full paid path. For manual meeting links keep Google provider creation off. For automatic Meet testing configure its dedicated OAuth client and doctor connection, then enable the Google provider and Video maintenance.
7. Enable Records artifacts, QR assets and Messaging only after storage/scanner/fonts/keyrings are mounted. Validate uploads, downloads, code-gated record access and message windows.
8. Prepare encrypted operational summaries and references for existing eligible appointments using the explicit maintenance/backfill procedure outside active consultations. New bookings create their own references. Never backfill legacy symptom analytics.
9. Configure the private NLP bearer/coordination secrets and built model assets. Start the AI worker and Python services using the explicit AI profile/overlay. Keep ordinary booking available when the NLP service fails.
10. Validate aliases, negation, uncertainty, missing information, identity redaction and NLP failure in a separate acceptance environment. Configure master AI and patient normalization consistently on Web/API before the approved production rollout. Production examples do not include staff sandbox activation.
11. Independently enable analytics on Web/API/AI worker. Confirm activation is recorded before creating fresh test submissions. Data submitted before activation is intentionally absent. Small nonzero groups below five are suppressed. Nightly refresh is at 02:00 hospital time and admin-triggered refresh is available. Empty, unprocessed and suppressed are different states.
12. Run the acceptance journey below, including runtime failure and expiry paths. Leave real environment activation separate from source example updates.

Changing an env file does not update an already running process. Recreate/restart only the relevant services through the supported deployment process. Public NEXT_PUBLIC variables require rebuilding the Web image. A Compose restart alone does not apply new env-file values.

## Acceptance journey and expected results

- Patient chooses doctor and slot, completes OPQRST, confirms normalized symptoms, reviews factual summary and submits consent. Editing answers invalidates earlier AI confirmation.
- Doctor sees the random readable reference, age/sex and sanitized clinical intake. Name, contact, address, birth date and full records stay locked before and after acceptance.
- Blank chief complaint requires the doctor's approved factual handoff before EHR case creation. The original complaint remains null.
- Doctor accepts, code becomes available only to the patient, payment completes in test mode and the appointment becomes eligible/confirmed. Payment alone does not unlock identity.
- During the redemption window (start minus 30 minutes through end plus two hours), patient says the code and the assigned doctor enters it. Wrong doctor, wrong generation, missing consent/payment, five incorrect attempts, replay and expired window must deny access.
- Doctor documents care and issues authorized documents. Completion, cancellation, consent withdrawal or the documentation deadline ends live access. The usual documentation deadline is scheduled end plus 24 hours, subject to earlier lifecycle closure. Historical evidence stays episode-scoped.
- Rescheduling preserves intake and readable reference but rotates the accepted booking's code. Follow-up is a separate booking with a new reference and code. A previous grant cannot unlock it.
- Admin sees only derived symptom aggregates, coverage and versioned exploratory clusters. Sandbox cases are excluded. Use at least five eligible similar submissions per known-age cohort to test cluster eligibility, and expect DBSCAN noise when cases do not form a dense group. No diagnosis or specialty recommendation is produced.

## Common configuration failures

| Symptom | Check first |
|---|---|
| Summary controls missing | Master AI and patient flags on Web/API, public build config and final-review journey. |
| Analysis remains pending | Separate AI worker running, migration grants, Python URL/key, Redis lease access, built assets and resource limits. |
| AI fails but booking succeeds | Expected manual fallback. Inspect content-free error codes and preserve original intake. |
| Dashboard empty after activation | New submitted bookings, analytics flags, activation timestamp and processing coverage. Existing appointments are not imported. |
| Values hidden or clusters unavailable | Small-count suppression, known-age cohort, five-case minimum, bounded 90-day fit population and DBSCAN density. |
| Cannot unlock after acceptance | Payment/confirmed state, consent, assigned doctor, code generation, redemption window and separately provisioned appointment keys. |
| Specialty list unavailable | Authenticated Gateway lookup with category=specialty, actual active UUIDs and current doctor assignments. |
| Upload or PDF fails | Storage principal/bucket, scanner socket, fonts and Records keyring. |
| Meeting generation fails | Separate Meet OAuth client, callback, provider flag, doctor authorization and Video worker recovery. |
| Browser mutations fail origin validation | NEXT_PUBLIC_APP_URL must equal the browser-visible origin. |
| Flags appear to have no effect | Wrong process env file, Compose interpolation override, stale container or missing Web rebuild. |

## Verification limits

This guide describes configuration contracts. It does not certify that your deployed services, migrations, OAuth grants, keys or provider accounts are ready. Keep the source checks separate from full synthetic end-to-end acceptance, real isolated database concurrency checks, model/resource tests, printing and accessibility verification. Hospital review of consent, privacy and retention remains an operational requirement.

## Production exclusions

The ordinary production examples omit E2E_TEST_SUPPORT_ENABLED, E2E_TEST_SUPPORT_KEY, VITAL_AI_SANDBOX_ENABLED and EDA_TEST_ENABLED where previously present. Their test harnesses remain available only through separate isolated configurations. None is needed for ordinary patient or doctor business operations. Keep PayMongo sandbox credentials, Google Meet OAuth configuration and all required security keys. Do not remove mandatory privacy checks to make a workflow pass. Existing private environment files can still contain old overrides: these example edits do not remove values already configured in a deployment.
