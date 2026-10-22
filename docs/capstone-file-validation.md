# Temporary capstone file validation

Services selects `capstone-validation-only` in
`src/eda/modules/records/inspection.ts`. This is an explicit temporary capstone
build setting. NODE_ENV, environment variables and browser requests do not
select it. No new environment variable or database migration is required.

## Behavior

Doctor signatures, patient attachments, payment QR images and generated clinical
PDFs use real file validation without antivirus scanning. These runtimes do not
construct/contact ClamAV or require scanner paths in demo mode. Existing Compose
may still start a scanner container; its infrastructure and health dependencies
are not changed by this revision.

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

## Restoring antivirus

Change the single source setting to `clamav` and rebuild/deploy the matching API
and worker. The retained adapter requires configured ClamAV and real clean
evidence for new writes; validation-only evidence cannot authorize publication
in that mode. Previously finalized demo files remain authorized/readable and
are never retroactively claimed to have been scanned. Legacy ClamAV evidence
remains readable under either policy.

Earlier scanner-configuration repairs in Capstone_BGH are separate work and
were not modified. No commit, push or deployment is included here.

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
