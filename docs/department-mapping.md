> **2026-10-28 superseding scope:** Specialty recommendation endpoints are retired (410). The 19-specialty TRACE lookup remains for manual selection. Booking is doctor/slot first, with NLP confirmation in final review. Appointment identity and record access require the separate six-digit-code policy, independently of AI flags. Deploy paired Web/Services contracts and provision dedicated access keys before cutover. See [the current implementation brief](vital-ai-implementation.md).

# TRACE-aligned 19-specialty booking catalog

Updated 27 October 2026. The versioned source is `assets/ai/department-catalog.json` (`vital-departments-v2`). This catalog restricts booking recommendations only; BODHI vocabulary, symptom extraction and analytics remain unchanged. General Surgery and Dermatology are excluded. TRACE staging (`fccd4e6`) defines 19 clinical specialties separately from 22 hospital departments. This catalog follows that clinical list.

| Canonical department | Accepted BODHI IDs | Packaged TRACE UUID |
|---|---|---|
| Internal Medicine | 44 | Unresolved |
| Pediatrics | 9 | Unresolved |
| Cardiology | 1 | Unresolved |
| Otolaryngology (ENT) | 4 | Unresolved |
| Ophthalmology | 13 | Unresolved |
| Gastroenterology | 5 | Unresolved |
| Pulmonology | 21, 30 | Unresolved |
| Nephrology | 11 | Unresolved |
| Urology | 12 | Unresolved |
| Endocrinology | 15, 31 | Unresolved |
| Rheumatology | 18 | Unresolved |
| Neurology | 10 | Unresolved |
| Psychiatry | 16 | Unresolved |
| Allergy and Immunology | 32, 42 | Unresolved |
| Obstetrics and Gynecology | 7, 40 | Unresolved |
| Orthopedics | 8 | Unresolved |
| Oncology | 14 | Unresolved |
| Hematology | 43 | Unresolved |
| Dentistry | 2 | Unresolved |

## Name and source handling

The submitted spellings `Opthalmology`, `Gastroentrology`, `Nephrologoy` and `Obesterics and Gynecology` are explicit aliases of their corrected canonical names. Matching trims whitespace and ignores case; there is no fuzzy matching or automatic prefix removal. Other explicit aliases are recorded in the catalog.

BODHI `6` (General Physician) remains pending review and cannot independently qualify Internal Medicine. `TRACE General Medicine` is deliberately not an Internal Medicine alias. BODHI `39` (Pediatric Nephrologist) cannot independently qualify Pediatrics or adult Nephrology. Mixed candidates qualify only if they also carry an accepted source ID for that exact catalog specialty. Full BODHI reference normalization is preserved; this check occurs at the recommendation boundary.

The private analysis contract now carries `sourceSpecialtyIds` per candidate and `versions.candidateProvenance = bodhi-specialty-ids-v1`. Older analyses are hidden as current analysis and marked `reanalysisRequired`; recommendations abstain until analysis is repeated. An explicit analyze request can requeue completed, failed or stale jobs at the same draft version. Existing confirmation is preserved and supplied to the new analysis. Analytics requests still omit graph candidates.

## TRACE resolution and deployment bindings

All 19 checked-in `traceDepartmentId` values are null because no live staging lookup was read for this implementation. Seed names do not establish live UUIDs. The runtime can resolve a null binding from a unique exact canonical/alias match in the current active TRACE lookup. `TRACE Cardiology` and `TRACE Pediatrics` are supported aliases, not claims that these records are deployed.

The authenticated BFF calls Gateway `/trace/api/departments/lookup?category=specialty` using the validated session access token and VITAL system context. Every row must have a valid unique UUID, a nonempty name and `category: specialty`. Empty, mixed-category, uncategorized and malformed responses fail closed; explicit non-active statuses are rejected. There are no fallback specialty options. Browser `/api/trace/departments` responses retain their ID/name shape; signed private `verifiedDepartments` rows also carry `category: specialty`. Browsers cannot supply this authority field or the previous `verifiedDepartmentIds` field. Services abstains on older private payloads without category information. A row without status relies on TRACE's active-only lookup contract.

For an explicit binding, obtain the live UUID through that lookup and set the catalog entry's `traceDepartmentId` in a reviewed environment-specific artifact. The packaged catalog is read from `assets/ai/department-catalog.json` relative to the Services working directory (`/app` in the runtime). Rebuild the Services image or mount a reviewed replacement artifact at that path. Do not put stage-specific UUIDs into a different environment without verification.

Two matching TRACE records are ambiguous until an explicit UUID selects exactly one matching row. A pinned UUID must still exist in the active lookup with an accepted name; a pin cannot bypass name verification. Shared bindings across catalog entries are rejected or marked ambiguous. Inactive, absent, invalid and ambiguous mappings produce abstention. General Medicine needs a separate reviewed policy rather than an implicit Internal Medicine mapping.

This describes the historical routing design. The routing JSON and recommendation runtime have subsequently been removed. The catalog is retained for reference and validation; manual doctor selection uses the authenticated TRACE specialty lookup.

Deploy the Web specialty-fetch and Services category-validation versions together. The existing updated private Python provenance runtime is also required before using recommendations. Old Python images lack provenance and cannot produce accepted interactive analyses. No database migration is required for this catalog change; older JSON analyses require reanalysis rather than backfill. No TRACE records or feature flags are changed.

## Verification

Services tests cover all accepted BODHI IDs against the bundled CSV; the exact 19-entry scope and spelling aliases; merged and excluded sources; exact-name and explicit UUID resolution; ambiguous or missing mappings; wrong rule UUIDs; missing doctors; and older analysis contracts. Web tests cover active lookup validation, malformed UUIDs, inactive rows and lookup failure without specialty fallback. Python projection tests verify source preservation for merged specialties and that analytics candidates remain empty.

The 26 October mapping run passed 480 Services tests with no failures (three skips). Focused intelligence checks passed all 18 tests, and Python provenance checks passed all three tests. Web checks additionally verified that authenticated browsers cannot forge either the new or former department-authority fields. Type checks and targeted lint passed. These source checks do not verify live staging mappings or replace the outstanding resource-limited runtime test.

Live UUID binding, populated clinical rules and staging browser/runtime acceptance remain separate outstanding work.

## Verification status, 27 October 2026

The source contract was inspected at TRACE staging `fccd4e6` and VITAL Web staging `8a0d492`. Source verified; deployed response unverified. No authenticated staging session was available for a live lookup, and no operational UUIDs are pinned from seed definitions. No TRACE data, feature flags, deployment or migration was changed. See [verification record](intelligence-verification.md) for current test results.
