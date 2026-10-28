# VITAL Symptom Summaries and Appointment-Controlled Patient Access

Updated: 2026-10-29. This revision supersedes the intake-first specialty-recommendation plan. Source changes do not deploy or activate an environment.

## Agreed journey

Choose doctor → choose slot → structured OPQRST and optional complaint → review normalized symptoms and factual template summary → the existing consent and submission step.

MedCAT, MiniLM and BODHI symptom vocabulary remain. Normalization reads the symptom CSV without loading the condition/specialty graph. No diagnosis, specialty recommendation, new ML training, LLM, external inference provider or vector database is required. The authenticated Gateway TRACE lookup still supplies the 19 specialties for manual doctor selection, onboarding and profiles. Recommendation operations return `410 AI_RECOMMENDATIONS_RETIRED`.

The final review shows readable assertion labels and lets patients correct or remove recognized symptoms. Structured answers remain available during an NLP outage. Session-bound encrypted drafts retain their existing expiry and optimistic concurrency rules. Encrypted draft autosaving restores answers after refresh; the shared save queue prevents autosaving and analysis from racing. In-memory answers survive doctor/date navigation; no intake is put into browser storage. Submission confirms the displayed concepts without a new routine consent click and consumes the session-bound draft, including manual continuation after an NLP outage. Follow-ups with a blank complaint include a separate editable, doctor-approved factual EHR handoff; the patient complaint stays null.

## Doctor review and patient identity

Services produces a privacy-aware appointment projection. While locked, patient/Core/Auth/EHR identifiers, profile enrichment and EHR case links are absent. Doctors see an independently random reference such as **Patient #7K4M-9Q2R**, age and sex snapshots, appointment information, structured OPQRST and a sanitized factual summary. Unknown free-text spans are withheld. This is restricted disclosure, not a claim of anonymity. External meeting identity displays remain outside VITAL's guarantee.

References are random eight-character values, independent of database identifiers. A registry prevents collisions between distinct bookings. Reschedule replacements preserve their source reference; distinct follow-ups receive new references. The reference remains visible alongside an authorized name after unlock. Appointment references are not credentials.

Known identity values obtained through the patient's authorized EHR profile read are encrypted privately for redaction. If this snapshot is absent, free text is withheld conservatively. Structured OPQRST values are preserved. Originals remain in private clinical records. Doctor-facing messaging uses the same reference and withholds unsafe content and sender identifiers while locked. Patient-wide OPQRST history is retired in favor of appointment-scoped review.

## Appointment access codes

A successful acceptance transaction issues a cryptographically random six-digit code, preserving leading zeros. The authenticated patient can retrieve it from the appointment card and explicitly print its reference, doctor, schedule and instructions. Notifications, jobs, logs, doctor DTOs and URLs never contain plaintext codes.

The code uses a keyed verification digest and versioned AES-GCM ciphertext. Its binding includes appointment, patient, assigned doctor and generation. Patient retrieval, replacement, withdrawal, doctor redemption and access-state operations use private signed Services routes behind authenticated same-origin BFF endpoints.

Redemption requires the assigned doctor, current consent, confirmed/payment eligibility, the current appointment version and generation, and the interval from scheduled start minus 30 minutes through scheduled end plus two hours. Verification and consumption run under a transaction and row locks. Five wrong attempts lock a generation. Broader doctor/booking throttles persist across reissues. Patients may replace unused or locked codes at most three times per hour; staff cannot retrieve or bypass them.

Successful redemption establishes a grant through the existing documentation deadline, normally scheduled end plus 24 hours. Cancellation, rejection, rescheduling, revocation, finalized completion and documentation locking close live access as applicable. Refresh and token rotation do not recreate the grant. Payment and acceptance alone do not grant access. Meeting links remain usable while records are locked.

Access states are `review_only`, `unlock_available`, `unlocked`, `locked` and `historical_only`. A version-2 privacy object is required for doctor list/request/dashboard composition; older or contradictory projections fail closed. Web and Services must deploy together.

## Clinical handoff and retention

`appointment_intake_briefs` stores durable encrypted operational summaries with intake version and source hash. Doctor-approved handoff text and approval provenance live there, independently of analytics expiry. Blank patient complaints stay null. Before EHR case creation, an assigned doctor must approve a factual nonempty brief within EHR's existing 2,000-character contract. Long drafts require editing; nothing is silently truncated. Changes invalidate approval.

Live Records operations require the appointment grant in addition to existing consent, financial, ownership and paperwork checks. Historical reads return only saved case evidence, not a route into the evolving EHR. Local historical documents/files must belong to that episode. Doctor file delivery proxies authenticated bytes rather than returning reusable storage download URLs. Patient-owned file access and independent integration contracts retain their existing authorization.

Derived analytics remain independently configurable: post-activation submissions, stable submission identities, correction handling, symptom counts/coverage, suppression below five, 12-month derived retention and versioned DBSCAN snapshots. No condition pathways enter analytics and no legacy analytics are backfilled. Sandbox cases remain excluded.

## Storage and configuration

Migration: `prisma/core/migrations/202610280001_appointment_access/migration.sql`.

New Core tables: `appointment_access`, `appointment_references`, `appointment_access_attempts`, `appointment_intake_briefs`. Operational clinical data is outside the analytics retention sweep.

Dedicated configuration, independent of AI flags:

- `VITAL_APPOINTMENT_ACCESS_KEYS`: JSON version-to-base64 map; each AES key is 32 bytes.
- `VITAL_APPOINTMENT_ACCESS_ACTIVE_KEY_VERSION`: active encryption version. Retain previous keys for decryption.
- `VITAL_APPOINTMENT_ACCESS_DIGEST_KEY`: distinct 32-byte base64 HMAC key.

Provision these privately for the API and any worker performing appointment transitions. Never reuse Auth, model, messaging or video keys. Example files contain no generated secrets.

## Cutover and release

1. Provision keys and review hospital consent, retention and privacy policy.
2. Validate migrations and paired Web/Services/private NLP contracts in an isolated environment.
3. Stop booking/acceptance writers and cut over outside active consultations.
4. Run the explicit `appointment-access-backfill` maintenance entrypoint with `VITAL_APPOINTMENT_ACCESS_MAINTENANCE=confirmed-writers-stopped`. It refuses active confirmed consultations, creates upcoming/pending references and eligible accepted codes, and does not import analytics or alter completed records.
5. Complete runtime, concurrency, resource, mobile, keyboard, screen-reader and print acceptance before enabling the revised journey.

No deployment, real database migration, TRACE edits, specialty creation, feature activation or legacy deletion is part of this source implementation. Clinical routing approval is no longer a release dependency for summaries and analytics. Runtime acceptance and hospital policy review remain required.
