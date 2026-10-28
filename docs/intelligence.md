> **2026-10-28 superseding scope:** Specialty recommendation endpoints are retired (410). The 19-specialty TRACE lookup remains for manual selection. Booking is doctor/slot first, with NLP confirmation in final review. Appointment identity and record access require the separate six-digit-code policy, independently of AI flags. Deploy paired Web/Services contracts and provision dedicated access keys before cutover. See [the current implementation brief](vital-ai-implementation.md).

# Intelligent intake and symptom analytics

Source implementation; deployment and clinical acceptance are separate. This feature introduces no LLM, external inference API, MongoDB, or vector database.

## Ownership and rollout

VITAL Services owns operational drafts, confirmed analyses, derived analytics, job orchestration, and the private Python runtime. VITAL Web remains a database-free BFF. TRACE still owns department IDs; EHR still owns clinical cases. `vital-ai` is an unchanged reference snapshot, not a service dependency.

Apply `202610250001_intelligent_intake` using the existing migration tools, then rerun the existing scoped database grants/provisioning. Start the AI worker only after migration and grants. No legacy data is imported. The worker inserts a one-time `ai_settings` activation timestamp when analytics is enabled. Only subsequent submitted bookings are captured. Reschedules preserve the submission ID; source history is not backfilled.

Four independent opt-ins default to false:

| Key | Purpose |
|---|---|
| `VITAL_AI_ENABLED` | Core AI API/runtime ownership |
| `VITAL_AI_SANDBOX_ENABLED` | Authenticated staff synthetic-case preview |
| `VITAL_AI_PATIENT_ENABLED` | Normalization and confirmation within doctor/slot-first final review |
| `VITAL_AI_ANALYTICS_ENABLED` | Post-activation submissions and new symptom dashboard |

Enable sandbox, patient normalization and analytics independently according to the rollout stage. Appointment privacy and access codes remain enforced regardless of AI flags. No clinical routing artifact is required or loaded.

Unused routing code, graph/candidate helpers, routing JSON and routing-only tests have been removed. The [routing prototype](routing-prototype.md) remains historical reference only.

Manual doctor selection uses the authenticated TRACE specialty lookup. The [19-specialty catalog](department-mapping.md) remains a validated reference. Legacy candidate analyses require fresh normalization; symptom analytics and the complete BODHI reference remain unchanged.

## Contracts

Browser routes use same-origin BFF calls and existing private mTLS plus signed actor assertions. Private AI routes are a finite `POST /internal/v1/ai/{action}` allowlist. Core independently validates roles, current membership, actor scope/resource, draft ownership, session binding and versions.

- `/api/patient/intakes`: GET current draft, POST/PATCH versioned save, DELETE session draft.
- Subroutes `catalog` and `status` use GET; `analyze` and `confirm` use POST. The retired `recommendations` operation returns explicit HTTP 410.
- `/api/admin/ai/sandbox` and `/api/doctor/ai/sandbox` expose the corresponding synthetic-only workflow. The admin preview page is `/admin/dashboard/ai-sandbox`.
- `/api/doctor/appointments/{id}/intake-brief`: GET editable brief and POST doctor approval with appointment version and text (maximum 2,000 characters).
- Existing admin dashboard and refresh routes switch to Core only with the analytics opt-in. The new dashboard payload is version 2. It excludes raw text, patient identifiers, source membership and individual recommendations.
- `/api/admin/analytics/clusters/label` approves a suggested descriptive symptom label for an immutable cluster version.

The BFF supplies session deadlines from Gateway `/auth/session/status` and age from the authorized EHR profile. Browser requests cannot choose these authority fields. Background validation forwards `X-Idle-Passive`; polling does not extend login lifetime. Drafts use a random HttpOnly cookie binding distinct from access tokens. Explicit logout deletes the bound draft and clears the cookie. Expired drafts are inaccessible and are swept every 30 seconds while the worker is running. Cleanup failures do not block logout; expired payloads are physically removed when the worker resumes. Database backup retention remains governed by the existing backup policy.

Draft payloads use dedicated versioned AES-256-GCM keys, with row ID as authenticated context. Source text is transient in Python and excluded from logs and job payloads. Clinical originals remain in their authorized operational records. AI failures never replace originals or silently approve clinical findings.

## Processing and reporting

MedCAT recognition and exact MiniLM matching use checked-in BODHI vocabulary and locally built model assets. Assertion handling is conservative and rule-based; it requires evaluation and is not a claim of comprehensive clinical-language understanding. OPQRST remains structured. The main-symptom selector supplies a known concept without requiring a free-text chief complaint. No body location is automatically turned into pain.

Patient confirmation and corrections precede recommendation. Confirmed concepts are used for a separate candidate-graph pass so a removed symptom cannot continue driving candidates. BODHI provides candidates only; hospital routing criteria and verified department mappings decide which may be shown. Unapproved artifacts are sandbox-only. Unsupported input, missing age, unavailable mappings and failures produce explicit clarification, abstention or manual continuation.

Briefs are deterministic and preserve unknown answers. They are never silently truncated. If chief complaint is blank, the assigned doctor approves or edits a factual brief before VITAL opens the EHR case using its unchanged nonempty complaint contract. The patient's original complaint remains null. Corrections invalidate the brief approval and pending derived output.

Analytics counts submissions, including later cancellations, not unique patients or disease prevalence. Positive concepts are deduplicated per submission. The denominator for symptom percentages is successfully analyzed submissions, including no-positive outcomes. Counts below five and related percentages are suppressed; genuine zero counts remain zero. Clinical corrections revise the original report date rather than adding encounters. Derived records and aggregates expire together after 12 months.

DBSCAN uses `eps=0.35`, `min_samples=5`, symptom overlap 70%, anatomy 10%, and quality/onset/timing/severity 5% each. Missing components are omitted and weights renormalized; no shared positive symptom means distance 1. Adults and children are clustered separately. Unknown-age encounters retain symptom statistics but are excluded from clustering. Each immutable snapshot covers the latest 90 days, at most 2,000 encounters per cohort, with noise retained as unclustered. These are experimental settings, not clinical validation. Nightly refresh runs after 02:00 Asia/Manila; admin refresh is also supported.

## Runtime and deployment

Use the root `compose.vital-ai.yaml` overlay and its examples. The Node AI worker uses existing Core/Integrations worker identities, no migration privileges. Python has no database credentials. Its dedicated runtime key authenticates private calls. Coordination uses the existing `analytics:heavy-work:lease` key with a separately scoped Redis ACL identity; do not supply general analytics credentials. Models load in a bounded child, with one native thread, a hard task timeout and no simultaneous heavyweight AIMS task. The parent holds no loaded models. Limits start at 2 GiB for Python and 256 MiB for Node orchestration.

At accepted cutover, stop the old `analytics-vital-worker`, drain or discard old VITAL-only queued work, and enable `VITAL_ANALYTICS_RETIRED` in Analytics API/Beat. Its VITAL routes return 410 and new VITAL jobs stop; AIMS/EHR schedules and shared volumes remain intact. Root overlay and environment changes are operator opt-ins, not an automatic deployment. Never delete shared volumes or the reference repository as a migration step.

## Verification limits

Run Services tests/build/schema validation; Web tests/typecheck/BFF checks; and Python tests in `runtimes/nlp`. Local Python tests skip actual DBSCAN if the locked dependencies are absent. Build and smoke-test the NLP image to validate real MedCAT/MiniLM compatibility and offline inference. See [the verification record](intelligence-verification.md) for completed local checks and remaining release gates. Source checks do not certify a deployed or clinically safe workflow.
