# Sprint 6 capstone documents

This release is for development, testing and presentation. It issues demonstration
prescriptions, medical certificates and payment acknowledgments. It makes no
external license, pharmacy, dispensing or tax-invoice verification claim.

## Doctor credentials

The doctor Profile contract has no `title`/honorific. Completing onboarding requires
PRC, PDEA S2, ordered S2 validity dates and a saved signature, in addition to the
existing specialty, biography, availability and terms requirements. Profile settings
support the same fields. Controlled issuance checks the issue date in Asia/Manila
against inclusive S2 dates. Fictional demonstration credentials are accepted.

`GET/POST /internal/v1/records/signing-profile` accepts only an active doctor with
`records.signature.read/write` scoped to their own Auth ID. POST requires an
operation UUID and a strict `{base64,mimeType}` body. Only actual PNG/JPEG up to
32 KiB passes; original and normalized bytes are scanned with the existing ClamAV
policy. Normalized PNG is bounded to 600 by 240, encrypted with the Records
keyring and bound to owner/asset/schema. Replacement adds a version and moves the
doctor pointer. Prior versions remain available for immutable issuance evidence.
No public Profile endpoint returns reusable signature bytes.

## Clinical issuance

Existing Records prepare/evidence/issue workflows retain membership, assignment,
consent, payment, appointment version and paperwork-window checks. Commands require
`signingConfirmed:true`. Each prescription line requires `isControlled:boolean`
and a generic `medicineName`; brand, strength and form are optional. Classification
is explicitly selected by the clinician, never inferred from the name. Existing
dosage, frequency, route, duration, quantity and instructions fields are retained.

Encrypted canonical documents use `payloadSchemaVersion:2` and
`templateVersion:bgh-capstone-v1`. Patient/prescriber identity, issue time, PRC,
S2, signature bytes/hash/asset ID and clinical content are snapshotted at issue.
`contentHash` covers the canonical issuance fields before adding the hash itself.
PDFs use only that snapshot. Profile/signature edits cannot change prior output.
Old issued payloads continue to render with the legacy template.

Corrections specify `supersedesId` and a nonempty `correctionReason`. The previous
document must have the same patient, doctor, appointment and kind. Locking and a
unique replacement index prevent competing successors. The new canonical records
the reason, signing actor and timestamp; old documents are retained. Reads identify
superseded versions rather than silently replacing historical content.

PDFs are A4 with the landing-page BGH logo, embedded Unicode fonts, numbered pages,
saved signature and the prominent capstone/not-for-dispensing marking. Controlled
lines are marked individually. Certificates include purpose, findings, consultation,
rest and recommendation fields. No general health-record export is introduced.
The runtime image packages the logo and DejaVu fonts; existing configured font paths
remain supported.

The prescription QR contains only
`VITAL_PAYMENT_APP_ORIGIN/documents/prescription/<opaque UUID>`. It contains no token,
patient or medication information. The Web page continues through login and reads
the authorized Records document/file APIs. Owning patients and the issuing doctor
can retrieve it; doctors retain consent checks. UUID possession grants no access.
References use `VITAL-RX`/`VITAL-MC`, with no PhilHealth UPSC claim. Document access,
file access/download and issuance use existing metadata-only audit outbox delivery.

## Payment acknowledgment

The existing `completeInvoice` lifecycle requires the committed consultation
completion, a verified paid payment and no unresolved financial review. No second
ledger is created. The invoice stores the immutable acknowledgment snapshot, names,
PHP centavos, payment facts, completion date, template and unique `VITAL-ACK`
reference. Original payment facts are retained after refunds; subsequent refund
status is returned separately. Replays reuse the same snapshot; the first PDF is
persisted under an invoice row lock, hashed and reused on downloads.

`GET /internal/v1/payments/appointments/:appointmentId/acknowledgment[/file]`
requires `payments.acknowledgment.read` scoped to that appointment. Patient ownership
is checked in both Core billing authority and Integrations. Administrators require
current admin membership. Missing snapshots return 409 instead of manufacturing a
receipt for an old or ineligible invoice. The file envelope includes base64/sha256;
Web verifies the hash and emits private, non-cacheable PDF responses.

The PDF says Payment Acknowledgment and explicitly does not replace a BIR-authorized
invoice. Sandbox snapshots print TEST — NO ACTUAL PAYMENT. No invented tax details
are used. Existing historical invoices without a snapshot remain unavailable.

## Migrations and deployment

Core migration `202610200001_signed_documents` creates signature versions, adds S2
and document correction fields, removes doctor title and resets existing doctors
to onboarding-incomplete without manufacturing credentials. Integrations migration
`202610200001_payment_acknowledgments` adds snapshot/PDF/hash columns to invoices.
Controlled line data remains in the existing protected Records payload, so no EHR
table or Alembic migration is needed. EHR treatment evidence contracts are unchanged.

Use matching API/worker/tools/Web images for this coordinated contract release.
The existing deployment runner acquires the lock, selects images, provisions scoped
infrastructure, runs both Prisma migration owners through the separate tools image,
then starts schema-dependent API/worker and checks readiness before compatible Web.
A failed migration stops that sequence. Routine rebuilds never reset databases.
No deployment or database reset was performed for this implementation.

## Verification

The temporary S6 document, acknowledgment and migration suites were executed
successfully during implementation, then their standalone files were removed at
the user's request. Their completed results below are historical evidence, not
currently runnable coverage. Records, Profile, Billing and Payment regression
suites remain. The removed migration test executed actual Core/Integrations SQL
on empty and previous-schema isolated databases and reran its ledger; it did not
verify a tools-image Prisma deployment.

Full backend tests: 439 passed, 2 skipped; subsequent focused Profile onboarding suite: 31 passed.
Full Web tests: 277 passed. Backend and Web production builds passed. Final focused
results and remaining live acceptance are recorded in the saved Sprint 6 checklist.
Generated fictional PDF samples were rendered and visually inspected, including
long Filipino names, multiple medicines/pages, signature, QR and sandbox labeling.
Docker is unavailable on this host, so actual container migration/readiness and
authenticated multi-service browser acceptance still require the running stack.
