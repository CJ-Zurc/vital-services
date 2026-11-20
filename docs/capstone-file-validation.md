# File inspection and historical evidence

Services selects `clamav` in `src/eda/modules/records/inspection.ts`.
The API and worker require their configured scanner socket and policy paths
when they construct the relevant runtimes. Signature uploads and incoming
payment QR images are scanned before their first write. Patient files enter
private quarantine and workers require clean, hash-bound evidence before
publishing patient attachments, normalized QR images and clinical PDFs.
No new environment variable or database migration is required.

## Historical capstone behavior

Doctor signatures, patient attachments, payment QR images and generated clinical
PDFs used file validation while the temporary `capstone-validation-only`
policy was active. They may retain historical validation evidence.

Size/type bounds, image decoding/normalization, PDF parsing/active-content
rejection, hashes, encrypted signature storage, ownership, authentication,
consent, payment eligibility, publication leases and immutable history remain.
Storage, fonts, database and other existing dependencies still apply.

## Evidence

The existing JSON evidence columns accept validation-only evidence containing
`policy: capstone-validation-only`, `verdict: not_scanned`, `validationVersion: 1`,
`validatedAt`, `contentHash` and `byteLength`. No ClamAV engine/database version,
scanned timestamp or clean antivirus verdict is invented. Evidence is bound to
exact bytes and processing time before publication. Public API shapes remain
unchanged; evidence is backend-owned metadata.

## Deployment and compatibility

Roll out the shared daemon policy first and deploy the matching API and worker
builds together. Pending quarantine uploads are scanned under the active
policy before publication. Authorized reads of finalized demo files retain
their original validation evidence. Existing ClamAV evidence also stays readable.

## Maintained verification

Existing Records, Records artifact/repository and Profile QR suites cover both
policies, unavailable ClamAV, real validation, truthful evidence, signature
save/preview/replacement/replay, branded signed PDF publication, attachment/QR
publication, owner isolation, stale/hash-mismatched evidence and historical
reads. Antivirus protocol/malware/outage tests remain in place.

Results and test registration are recorded in `docs/testing.md`. Local simulated
storage/database and test-peer HTTP tests do not certify staging issuance.
Authenticated staging onboarding and issuance must be rerun after a separately
authorized deployment of this build.
