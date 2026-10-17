# Records Artifact Processing

Status: disabled checkpoint. The Records runtime wires these adapters into the
existing API/worker and additive Core ownership. No scanner daemon, extra worker,
bucket or shared deployment is provisioned. Do not activate staging independently.

## Dependencies

Runtime: `pdfkit`, `pdf-lib`, `sharp`, `@aws-sdk/client-s3`,
`@aws-sdk/s3-request-presigner`. Development: `@types/pdfkit`.
Versions are pinned in package files. The coordinated API/worker image must carry
the same dependencies; Node 22/Linux image validation remains outstanding.

## Public adapter contracts

All imports are under `src/eda/modules/records/`:

| File | Public surface |
| --- | --- |
| `storage.ts` | `S3RecordsStorage`, `RecordsStorage`, `RecordsStorageConfig`, `StoredContent` |
| `scanner.ts` | `ClamAvScanner`, `RecordsScanner`, `ClamAvConfig`, `ScanEvidence` |
| `upload-validation.ts` | `validateUpload`, `detectRecordsMime`, `sha256`, `ArtifactError`, `MAX_UPLOAD_BYTES`, `MAX_MULTIPART_BYTES` |
| `pdf.ts` | `createPrescriptionPdfBuffer`, `createCertificatePdfBuffer`, `PrescriptionPdf`, `CertificatePdf`, `RecordsFontConfig`, `validatePrescriptionLines`, `philippineDate` |
| `artifacts.ts` | `RecordsArtifactWorker`, `ArtifactRepository`, `ArtifactJob`, `ArtifactClaim`, `ArtifactPrepared`, `ArtifactPublication`, `CanonicalDocument` |

Storage methods: `key(area, assetId, sha256, mime)`,
`putQuarantine(key, bytes, mime, signal?)`,
`readQuarantine(key, expected, signal?)`,
`ensureFinal(key, bytes, mime, signal?)`,
`inspectFinal(key, expected, signal?)`, and `signedLink(key)`.
`StoredContent` is `{contentHash, byteLength, mimeType}`. Scanner implements
`scan(bytes, signal?)`; validation returns `{bytes, mimeType, inputHash,
contentHash, byteLength}`. No function takes an untrusted arbitrary URL.

## Persistence boundary

`records_file_assets` retains the input SHA-256 and quarantine key separately
from the published SHA-256/final key. Protected titles, descriptions and canonical
document bodies stay encrypted in owner tables. Object metadata carries only
`sha256` and the constant `records-artifact-v1` schema label, never patient names,
clinical text or filenames. Buffers never enter DB workflow metadata or RabbitMQ.

`ArtifactJob` contains `operationId`, `assetId`, optional `documentId`, `patientId`,
`kind`, `attempts`, `fence`, optional `input` and optional `prepared`.
`input` is `StoredContent & {objectKey}`; `prepared` uses the same shape for final
bytes. These map to `record_operations`, `records_file_assets` and the immutable
document payload owner; no cross-database FK or SQL is added here.

`ArtifactRepository` methods are each short, fenced Core transactions:

```typescript
claimDue({leaseOwner, leaseMs, now}): Promise<ArtifactJob | null>
renew({operationId, leaseOwner, fence}, {leaseMs, now}): Promise<boolean>
savePrepared(claim, {objectKey, contentHash, byteLength, mimeType}): Promise<boolean>
recordScan(claim, {input?, final}): Promise<boolean>
publish(claim, {...prepared, scanEvidence: {input?, final}}): Promise<boolean>
retry(claim, {errorCode, nextAttemptAt, blocked}): Promise<void>
reject(claim, errorCode): Promise<void>
```

`claimDue` atomically selects at most one due/recoverable operation and increments
attempt count/fence. Every later method must compare lease owner, nonexpired lease,
fence and legal state. `savePrepared` must enforce immutable expected output on
replay. A later lease claimant must reload existing preparation metadata.
`publish` atomically marks the asset ready and operation complete, persists minimal
scan evidence, and appends the owner's one authoritative fact/audit intent.
Repeated publication must be an idempotent no-op, not a second issuance/event.
Retries/rejection must never update a superseding claim. Durable retries are
60/300/900/3600 seconds; ten failures become blocked for explicit owner review.

`decryptCanonicalData(job)` is injected and returns the existing immutable
`{kind: 'prescription', data: PrescriptionPdf}` or
`{kind: 'medical-certificate', data: CertificatePdf}`. Main binds the document
to the operation/patient/resource, decrypts its Records-keyring payload and
converts persisted ISO date strings to `Date` values before returning it. The
sidecar does not create clinical issuance records, query identity providers or
re-evaluate treatment authority. Those decisions must commit before artifact work.

The worker defaults off (`enabled !== true`), claims one job, renews every 15
seconds with a 60-second lease, and does not overlap calls within one instance.
Global one-artifact concurrency across worker replicas requires a repository
singleton lease claim; per-row leases alone are insufficient. The repository now
locks the migration-seeded `records_artifact_capacity` row (`id=1`) before locking
an operation. Claim and renewal update both leases in one Core transaction, with
the operation ID, owner and operation fence bound to capacity. Publication,
retry (including blocked retries) and rejection release capacity only under that
same nonexpired binding. Expired claims are recoverable; superseded owners cannot
renew, publish, release capacity or reopen another claim. Lease deadlines use
PostgreSQL `clock_timestamp()`, not the worker-supplied clock or transaction-start
`NOW()`. A missing singleton fails closed; restricted runtime performs no DDL or
seed insertion. Migration `202610130003_records_ownership` owns the table, checks
and seed; both Core schema sources include the model. Main runs
this inside the existing worker; broker messages only wake durable DB work.
Graceful shutdown aborts in-flight adapters and leaves work recoverable.

No rendering, scanner, S3, EHR or Auth call occurs inside these repository
transactions. A committed canonical issuance is not recreated after a crash.
The worker reconstructs bytes, compares any prior prepared hash, rescans and
inspects the same immutable object. Storage success/Core failure therefore leaves
an inaccessible unreferenced final object until fenced publication succeeds.

## Storage controls

Configuration is injected, with no fallback credentials:
`endpoint`, `publicEndpoint`, `region`, `bucket`, `accessKeyId`, `secretAccessKey`,
`quarantinePrefix`, `finalPrefix`, optional `deadlineMs` (15 seconds default,
30 seconds maximum). Internal endpoint must be an HTTP(S) origin; public endpoint
may include the reviewed Gateway media prefix. Both reject credentials/query/hash.
Production network/TLS policy remains an infrastructure activation requirement.

Prefixes must be disjoint and keys are strictly
`<configured-prefix>/<asset-UUID>/<sha256>.<pdf|png|jpg|webp>`.
Do not accept legacy `/uploads/` paths, arbitrary S3 keys or HTTP URLs.
Never log signed URLs/query strings or SDK error bodies. Errors are content-free
codes. Runtime has no bucket-create/delete action and must use a provisioned,
separately scoped MinIO identity restricted to these prefixes. Separate API and
worker credentials may further restrict final writes.

Writes use `If-None-Match: *`, fixed byte length, SHA-256 metadata and the actual
SHA-256 checksum. Recovery checks Head metadata/content type/length, then retrieves
bounded bytes and verifies their hash. ETag is not a SHA-256 proof. A mismatch is
a conflict, never overwrite permission. MinIO conditional-write/checksum support,
at-rest encryption and IAM policy require real activation evidence.

`signedLink` accepts only final keys and produces a 300-second capability, with
inline/no-store response controls. The owning domain must independently authorize
each issuance and require asset `ready` plus matching scan/publication evidence;
calling the storage adapter alone does not establish access authority.
Signing uses the internal MinIO host, then replaces only the scheme/host prefix
with the configured Gateway proxy prefix. Gateway must forward the original
MinIO Host and preserve signed query/Range behavior. BFF additionally supplies
no-store and referrer-policy controls. Issued links can remain usable until expiry;
this is not immediate revocation. See
[AWS signed-link behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html).

## Upload validation and scanning

File bytes are capped at 10 MiB; route/BFF parsing must enforce the separately
exported 11 MiB multipart envelope, exactly one file, bounded fields and binary
assertion length/hash verification. The adapter receives bounded bytes, not a
request parser. Actual magic plus complete parser/decoder validation takes
precedence over declared MIME; declared MIME mismatch is rejected.

PDFs require a valid header/xref/EOF envelope, unencrypted successful parsing,
1-100 pages, bounded object/nesting counts and no active actions, embedded files,
rich media or external URI actions. Invalid/encrypted/truncated files never pass.
PDF parsing runs in a disposable worker thread with a ten-second deadline and
128 MiB old-generation memory limit, so a pathological parser cannot block the
shared worker's lease heartbeat. Timeout/resource exhaustion is not approval.
Images require actual PNG/JPEG/WebP decoding, at most 40 million pixels, each
dimension at most 12,000, a single frame, and bounded decode/re-encoding. EXIF and
other source metadata/trailing payloads are not copied. No metadata-only approval.
Input and final bytes are independently scanned; evidence must match exactly the
bytes being published, including changed hashes after image normalization. These
controls align with [OWASP upload guidance](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).

ClamAV configuration is explicit: `socketPath`, `daemonConfigPath`, `deadlineMs`
(100-30,000 ms), `maxDatabaseAgeMs` (one minute-48 hours). Only absolute restricted
Unix paths are accepted. Runtime checks an actual nonsymlink socket with no
world permissions and a nonsymlink daemon configuration not group/world writable.
The read-only config must explicitly match `LocalSocket`, omit `TCPSocket`, enable
`AlertExceedsMax`, `AlertEncrypted`, `ScanPDF`, `ScanArchive`, and provide
`StreamMaxLength`/`MaxFileSize` at least 10 MiB plus `MaxScanSize` at least 50 MiB.
Duplicate configuration directives fail closed in this restricted profile.
Operators must ensure this attested file is the daemon's effective configuration,
controlled parent directories/UIDs and daemon timezone UTC. Mounting a different
config file is not runtime policy attestation.

The adapter sends real `zVERSION` and binary `zINSTREAM` commands, 64 KiB frames,
big-endian lengths and a zero terminator. Signature DB version/date must be fresh,
not in the future, and stable across the scan. Response size is bounded; only
`stream: OK` becomes clean evidence. FOUND (including limits), ERROR, skips,
unknown/malformed responses, timeouts and reloads never mean clean.
The library does not provision/start a daemon or offer a permissive scanner.
`ClamAvIo` injection is a test protocol seam, not a production clean-result adapter.
[ClamAV documentation](https://docs.clamav.net/manual/Usage/Scanning.html) notes its
TCP interface is unauthenticated; no exposed TCP listener is allowed here.

## PDF parity

Templates retain the existing A4/50-point PDFKit layout, VITAL header, prescription
line fields, certificate fields, code, party/license snapshots and signature.
Dates explicitly use `Asia/Manila`. Creation/modification timestamps are frozen
to issuance time, yielding stable byte output for unchanged canonical inputs and
renderer/font versions. Malformed lines reject the whole prescription.

ASCII uses the existing Helvetica template. Non-ASCII requires configured regular
and bold font files; glyph coverage is checked before rendering. Missing fonts or
unsupported code points fail closed, not replacement glyphs. Fonts are trusted
deployment assets; their license, version/digest, shaping coverage and visual
regression evidence remain activation requirements. No font is downloaded or
silently substituted by this sidecar.

## Verification boundaries

`test/eda-records-artifact-repository.test.ts` exercises global capacity and
per-operation fencing using a transactional SQL fixture, including competing
workers, database-clock expiry, atomic renewal/release, stale owners and rollback.
It does not connect to PostgreSQL; real multi-session lock verification remains
a coordinated activation check.

`test/eda-records-artifacts.test.ts` exercises real library parsing/rendering,
actual AWS command objects/signing and the actual ClamAV command/framing adapter
against bounded protocol fixtures. Worker/repository fixtures exercise failure,
fencing, retry and publication order; they are not proof of real SQL locking.
Optional installed-font coverage is explicitly skipped without a test font.
Main registers the tests in the root catalog and records actual run evidence.

Local checkpoint evidence (2026-10-13, Node 24.12.0): 26 artifact tests passed,
zero failures/skips. Backend TypeScript and the standalone strict artifact-test
typecheck passed. Representative Unicode prescription and certificate PDFs were
generated and rendered with Poppler; visual inspection showed preserved fields,
readable accented names, Philippine dates and no overlap. Derived verification
artifacts are under root `.artifacts/tmp/records-pdf-sidecar`, not deployment data.

Not executed by this sidecar: real PostgreSQL/RabbitMQ/MinIO/mTLS/scanner daemon
concurrency, Linux socket/config policy, malware engine efficacy, Node 22 image,
IAM/at-rest encryption, deployment-font visual acceptance, full multipart ingress and Gateway
proxy behavior. These remain isolated/coordinated-release acceptance gates.
No shared reset, deployment, port change, provider action, commit or PR.
