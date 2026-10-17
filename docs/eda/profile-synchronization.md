# Profile Synchronization Checkpoint

The target is disabled by default. Legacy `npm start`, Web writers and existing
retry jobs remain authoritative on shared staging. No ports, shared data or
deployment configuration have been activated by this checkpoint.

## Ownership And Transactions

Profile owns Core markers, onboarding state, doctor fees and department metadata.
Auth owns identities/credentials; EHR owns hospital clinical data. Web is the
user-authorized transport adapter, never a second target Profile writer.

Each changed Profile transaction increments `VitalUser.version`, writes one
`vital.profile.changed` fact, one `vital.audit.requested` intent, and required
`ProfileSyncIntent` rows plus `vital.profile.sync.requested` outbox events. An
unchanged materialization emits nothing. Admin actors and target Auth UUIDs are
distinct. Audit delivery occurs through the audit-intent consumer only; the
Profile-fact consumer maintains a content-minimal revision projection and does
not enqueue a competing audit.

The sync event contains intent ID, target Auth UUID and destination, never the
HTTP payload or clinical input. The worker's owning-module interface verifies
the committed Core intent, association, source version and canonical HTTP hash.
It commits the Integrations inbox and delivery row before ACK. Core and
Integrations do not share a transaction, FK, join or database credential.

The Web route/DTO/cookie/authorization overlay is documented in
`vital-web/docs/eda-profile-phase.md` (workspace-relative). The original
105-route inventory remains a historical scan, not a claim of reviewed parity.
Registration/consent, pictures, QR/storage and mixed Appointment/Records routes
remain owned by their existing implementations until their extraction phases.

The approved EHR policy permits existing patients to update only their own
contact/email/address with a valid biometric session. Names, DOB, sex, blood
type, religion, PhilHealth and hospital classification remain staff-controlled.
New self-registration retains permitted demographic input and outpatient
classification. Neither operation headers nor service credentials grant patient
write rights. Unknown external outcomes require a fresh user session for
receipt-only recovery; workers never impersonate patients.

## Delivery Contract

| Destination | Method/Path | Scope |
| --- | --- | --- |
| Auth stale | `POST /internal/users/{authId}/stale` | Dedicated `VITAL_SERVICES_AUTH_STALE_KEY`; no other Auth internal permissions |
| Doctor mirror | `PUT /internal/users/{authId}/doctor-mirror` | Dedicated `VITAL_SERVICES_EHR_MIRROR_KEY`; no clinical creation, role lookup or impersonation |

Both calls identify `X-Internal-Service: vital-services` and carry stable
`X-Vital-Operation-ID`, `X-Vital-Request-Hash` and correlation ID. Request hash is
SHA-256 of canonical JSON `{method,path,body}`. Mirror body has only source,
request ID, source version and department identifiers/label. Auth body is empty.
Receipts must identify the same operation/hash; mirror receipt must identify the
same source version, target doctor and department. Unknown outcomes reuse the
same durable intent, not a new provider operation or a user token.

One worker leases one Profile delivery at a time for 30 seconds, with a 10-second
HTTP deadline and 64-KiB receipt limit. Backoff is 60/300/900/3600/21600 seconds,
at most ten attempts. Definite authorization/validation rejection and receipt
conflicts block. Expired leases are recoverable; accepted marking is fenced.
Old destination revisions become superseded before transport. EHR's receiver
also fences source revisions, closing the race between the Core check and HTTP.

Auth receipts default to 30 days through
`VITAL_SERVICES_AUTH_STALE_RECEIPT_TTL_SECONDS`; replay does not renew retention.
Expiry/Redis eviction can permit another safe cache invalidation, not another
clinical operation. This is not permanent exactly-once persistence. Retention
must cover the supported replay horizon; credentials and Redis persistence must
be reviewed before activation.

Before a future VITAL-only reset, reconcile retained EHR mirror source versions
and Auth UUIDs explicitly. Restarting Core versions at zero against a retained
EHR version fence is not a valid cutover strategy. Never reset the shared EHR or
silently bypass its fence to make a fixture synchronize.

`syncStatus` checks the latest required intent per target/destination: absent or
pending receipt is `pending`, blocked/conflicting receipt is `failed`, matching
accepted receipts are `synced`. Old blocked intents do not poison a newer
revision. Missing Integrations connectivity must never report synchronization
success. Marker fixtures must be initialized through Profile interfaces so their
required synchronization intents exist.

## Flags And Outstanding Gates

`VITAL_EDA_PROFILE_SYNC_ENABLED=false` is separate from API writes, broker
consumers and central delivery. New URLs/keys exist in `.env.eda.example` only;
they do not provision secrets or turn on a shared deployment. Production
transport requires HTTPS with verified server trust. The existing shared plain
HTTP listeners are not evidence of that TLS ingress being ready.

Real PostgreSQL/RabbitMQ/mTLS scenarios are present in the opt-in isolated test
harness, including inbox concurrency and the actual TLS Profile hop. They have
not been executed while the container runtime is deferred. External owner
transactions, key/certificate rotation, provider evidence and end-to-end
Gateway/BFF activation remain release gates.

## Required Audit Mapping

`materialize` -> `vital.profile.materialized`; contact/profile/fee updates ->
`vital.profile.updated`; patient/doctor completion -> `vital.patient.onboarded`
or `vital.doctor.onboarded`; admin provisioning -> `vital.doctor.provisioned`;
admin department override -> `vital.doctor.specialty_updated`. All use the local
Profile resource ID and real actor Auth UUID; no field values or clinical text.
