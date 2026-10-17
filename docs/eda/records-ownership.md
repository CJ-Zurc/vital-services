# Records checkpoint (disabled)

This manifest precedes extraction. The revised EDA plan is authoritative. No
shared runtime activation, storage/scanner provisioning or clinical data reset
is authorized. UHSE-EHR remains the clinical record owner.

## Compatibility manifest

All browser routes preserve refreshed session/cookie headers. Protected BFF
traffic uses Gateway; internal calls use process mTLS plus an action/resource/
request-hash-bound assertion (maximum 60 seconds). DTO version is 1. Unknown
artifact outcomes are processing states, not permission to repeat issuance.

| Browser/integration contract | Method | Authority | Target/dependency |
|---|---|---|---|
| `/api/patient/documents` | GET | Current patient | Records document list; existing filters/pagination |
| `/api/patient/documents/{type}/{id}/file` | GET | Owning patient | Authorized file link; JSON `{url}` or redirect |
| `/api/patient/files` | GET/POST | Current patient | Records file list/upload; quarantine until verified |
| `/api/patient/files/{id}/file` | GET | Owning patient | Authorized clean asset only |
| `/api/doctor/patients` | GET | Current doctor | Records episode membership; Profile identity enrichment |
| `/api/doctor/patients/{id}/record` | GET | Assigned doctor | Read-only EHR transport; live grant or immutable snapshot |
| `/api/doctor/patients/{id}/opqrst` | GET | Assigned doctor | Appointment intake owner; no Records clinical creation |
| `/api/doctor/appointments/{id}/prescriptions` | POST | Assigned doctor | Current paid paperwork eligibility + EHR evidence |
| `/api/doctor/appointments/{id}/medical-certificates` | POST | Assigned doctor | Same gate; canonical issuance before artifact processing |
| `/vital/integrations/v1/prescriptions` | GET/POST | EHR reader / VITAL doctor writer | Route-scoped foreign reader delegation / EHR treatment evidence |
| `/vital/integrations/v1/medical-certificates` | GET/POST | Same | Same; omitted appointment cannot bypass linked-case checks |
| Patient EHR records/sections/catalogs/biometric/vitals | Existing | User-scoped EHR authority | Thin Gateway/EHR transport; Profile owns identity linkage |

Profile photos/QR, registration consent, Meet, Messaging, SSE and full dashboard/
Appointment composition are excluded. Notes/reports have model ownership only.

## Internal contract

- `GET /internal/v1/records/documents`, `/files`, `/patients`: authorized lists.
- `POST /internal/v1/records/access-plans`: current episode access, version and financial checks.
- `POST /internal/v1/records/snapshot-workflows`: prepare a read-only EHR snapshot operation.
- `POST /internal/v1/records/snapshot-workflows/{id}/capture`: verify EHR receipt and capture protected normalized payload.
- `GET /internal/v1/records/snapshots/{id}`: independently authorized immutable episode evidence.
- `POST /internal/v1/records/documents`: canonical prescription/certificate issuance.
- `POST /internal/v1/records/document-workflows`: minimal preparation ledger (no clinical request bodies).
- `GET /internal/v1/records/documents/{id}`, `/files/{id}`: authorized metadata lookup independent of list pagination.
- `GET /internal/v1/records/patients/{id}/context`, `/episodes`: owning-module identity linkage and episode descriptors.
- `POST /internal/v1/records/uploads`: bounded binary upload; assertion covers descriptor, length and SHA-256.
- `GET /internal/v1/records/operations/{id}`: own durable operation status.
- `POST /internal/v1/records/files/{id}/link`: authorize a five-minute signed link.

The private patient directory and patient episode history accept only `limit`
(1..50, default ten) and a subject/collection-bound opaque `cursor`. Responses
contain `items` and `meta` with `nextCursor`, `validationCursor`, `snapshot`,
`total` and `asOf`. Every page independently checks current doctor authority and
consent/episode ownership. The BFF rejects duplicate rows, nonadvancing cursors,
changed snapshots and incomplete totals; it validates the final snapshot before
returning existing complete browser arrays. A stale read may restart once within
the overall 30-second/16-MiB composition budget. It does not repeat clinical
capture workflows. No silent patient or episode row cap remains.

Mutations use stable command IDs, existing canonical command hashes and expected
versions. Clinical payload hashes separately use RFC 8785 JCS. Dedicated EHR
RS256 receipts use issuer `uhse-ehr`, audience `vital-services.records`, bounded
key IDs and <=60-second lifetimes. Snapshot receipts bind workflow ID, doctor
Auth ID, patient EHR ID, case ID and canonical payload hash. Treatment receipts
add external appointment reference and native authorization; mirrored identity
alone never grants treatment authority. Receipt tokens are never persisted.

Document preparation accepts exactly one local `patientId` or `patientAuthId`.
The backend resolves Auth IDs; the BFF never queries Core for that mapping.
An independent Auth-ID request uses version zero for the new document aggregate;
Core captures the actual Profile revision in the returned workflow and rechecks
it at commit. Appointment-linked requests still use the Appointment version.
Identifiers do not substitute for consent, current doctor membership or EHR
treatment evidence. Missing VITAL linkage is an explicit error, not GET repair.

## Readiness and invariants

Records and artifact processing default off. Missing keyring, scoped storage,
EHR verifier, participant or scanner evidence fails closed; no legacy fallback.
Core effects share the Appointment transaction and explicit before/after state,
replacement association and verified financial evidence. Doctor acknowledgement
requires a verified episode snapshot; patient-first acknowledgement may start
the existing deadline. Missing snapshots block completion without a new public
status. Recovery is authorized read-only access, never case creation or reopened
paperwork. Unresolved proposals/sagas and effective completion deadlines close
issuance. Historical snapshots and referenced assets stay on their origin.

Uploads are <=10 MiB, exactly one file inside an <=11 MiB envelope. Actual format,
safe image/PDF validation and exact-byte malware evidence are mandatory. Scanner
limits, stale readiness, errors and malformed responses are never clean. No
clinical content, filenames, bearer links or upload bytes enter broker/audit.
Object writes happen outside retryable Core transactions. Stable keys/checksums
and recoverable leases resolve lost acknowledgements without duplicate issuance.

Signed links are bearer capabilities usable until expiry (300 seconds); no claim
of immediate revocation. Runtime cannot create buckets or accept arbitrary legacy
URLs. Existing Gateway signing-host behavior is preserved. Object at-rest
encryption, scanner capacity, Node 22 and live ingress/DB/broker/MinIO/mTLS evidence
remain coordinated activation gates.

## Concrete Security Boundaries

- Snapshot/document payloads use AES-256-GCM with patient/resource/schema AAD;
  episode freezes capture local-document/file cutoffs separately from EHR read
  provenance. Immutable Core triggers protect snapshots, freezes and canonical
  issued documents; privileged key/data recovery requires an audited owner runbook.
- Consent for doctor lists/counts matches individual document reads. Historical
  file permission uses the snapshot's authorizing episode; live permission checks
  current patient/doctor/association, consent, proposal/saga state and verified
  Payment ownership. Patient self-management is distinct from doctor sharing.
- Cached access plans recheck authority under the same Core locks. A late first
  acknowledgement cannot reopen an expired fallback deadline. A legitimate first
  acknowledgement still starts the existing 24-hour deadline.
- All Records workflow operations acquire a stable workflow advisory lock before
  calendar/resource locks. Capture also rechecks current versions and EHR linkage.
- Mutation preparation/capture/issuance holds patient and user share locks through
  commit; resolving a linked EHR case never bypasses an independent workflow's
  captured Profile revision. Current linkage reads require a consented live or
  retained-snapshot episode, not an empty revoked grant.
- Each protected payload is bounded to 2 MiB. Baseline capture and local freezes
  admit at most 256 documents and 256 uploads, checking a bounded extra row and
  failing explicitly rather than silently truncating evidence. Composed historical
  responses allow the separately protected baseline and freeze under a 4.125 MiB
  transport envelope. Larger histories need an owner-reviewed paged evidence
  contract before activation, not a raised unbounded memory budget.
- Binary transport rejects compression/chunked or mismatched-length envelopes,
  verifies SHA-256 independently and bounds API admission to two active uploads.
  Replays never advance artifact retry schedules or repeat clinical issuance.
- Artifact work uses persistent source facts, inbox deduplication and fenced leases.
  Source-event consumers wake persisted work; they do not republish facts, regrant
  access, or duplicate Appointment audits. DLQ replay remains Records-owner work.
- Audit actions are `vital.records.snapshot_captured`, `document_issued`,
  `file_uploaded` and `file_link_issued`, with `resource_type=document` and IDs only.
  Signed links are never command-journal results. Foreign EHR readers use the
  separate route-scoped delegation contract; no VITAL role marker is synthesized.

Notes/reports retain their model references and protected-payload columns only;
there is no new authoring API. Legacy plaintext/pair-snapshot persistence is not
target authority. Its schema/code remains for flag-off compatibility until full
coordinated parity permits cleanup. General registration consent and Profile
photos/QR still require Web dependencies and must not be removed prematurely.

The newly added Sharp validator was updated to the patched `0.35.5` release after
online advisory review. Remaining pre-existing dependency advisories (including
the Express trust-proxy dependency and Prisma tooling) are unresolved activation
gates, not evidence of a clean security audit. No forced dependency downgrade or
unrelated automated dependency rewrite was performed.

## Isolated Runtime Scenarios

The six Records scenarios in `test/helpers/records-live.ts` are NOT EXECUTED.
They require the existing isolated test topology plus explicit
`EDA_TEST_RECORDS_ENABLED=true`; optional storage/scanner scenarios additionally
require `EDA_TEST_RECORDS_ARTIFACTS_ENABLED=true`. Both default false. Database
configuration accepts only `postgres:5432/vital_core_test` and the isolated
migrator identity. Test cleanup is restricted to fixture-owned resources.

Optional storage accepts only `minio:9000`, bucket `vital-records-test`, runtime
identity `vital_records_test` and a distinct cleanup identity
`vital_records_test_cleanup`. Supply the corresponding isolated access/secret
settings through `EDA_TEST_RECORDS_STORAGE_*`; never use shared/root credentials.
The worker uses only runtime credentials; cleanup credentials are test-only.
The native scanner requires restricted mounts `/run/records-test/clamd.sock`
and `/run/records-test/clamd.conf`. No daemon or bucket is provisioned by these
tests. Explicit configuration is not evidence of live acceptance.
