# VITAL AI and Appointment Privacy — Verification Report

Updated: 2026-10-29. Source implementation is ready for review; environment rollout remains separate.

## Implemented behavior

- Doctor/slot-first booking, encrypted session-draft autosaving and refresh restoration, a shared optimistic save queue, normalized symptom confirmation in final review, and manual continuation on NLP failure.
- Retained MedCAT, MiniLM, BODHI symptoms and existing analytics/clustering. The normalization runtime no longer constructs the condition/specialty graph. Recommendation endpoints are retired; manual TRACE specialty lookup remains.
- Random per-booking references and versioned privacy projections across doctor requests, lists, dashboards, schedules, messaging and notifications. Locked projections omit patient identifiers and profile enrichment. Unsafe free text is withheld; structured clinical answers remain readable.
- Six-digit acceptance-bound codes, dedicated authenticated encryption and HMAC verification, private patient retrieval/printing/reissue, doctor redemption, persistent attempt limits, replay protection, time/payment/consent checks and patient withdrawal without automatic cancellation.
- Appointment version changes and invalidation notifications on access changes. Access-state polling is passive and does not renew login lifetime. Client clinical views clear when live access ends or cannot be verified.
- Appointment grants added to Records checks. Historical views expose case-scoped evidence rather than current longitudinal EHR data; doctor file delivery uses authenticated byte delivery instead of reusable download capabilities.
- Durable operational summaries and handoff approvals outside the analytics expiry sweep. Blank complaints stay null; editable doctor-approved EHR text respects the existing 2,000-character contract. Blank-complaint follow-ups have an explicit factual handoff approval.
- Core schema/migration and a maintenance-only reference/code backfill. No real environment migration or backfill was executed.

## Cleanup verification — 2026-10-29

Removed unused specialty routing, condition/specialty graph helpers, candidate projection, routing JSON and routing-only tests. Kept catalog reference validation and manual TRACE lookup coverage. Removed graph-only computation from normalization without changing its concept output. Python cache files are now excluded from Git and Docker contexts; temporary logs remain outside both repositories.

After cleanup: affected Services tests passed 13/13; Services TypeScript and both repository whitespace checks passed. Python discovery passed eight tests and skipped seven (six require real model assets; one requires locked clustering dependencies). No full-suite rerun was needed for this isolated removal. The full regression counts below describe the earlier pre-cleanup baseline. Targeted ESLint reports these TypeScript files are outside its configured matching scope, so it does not establish additional TypeScript lint coverage.

## Completed source checks before cleanup

| Check | Result |
|---|---|
| Services regression | 491 passed, 4 skipped; 495 total |
| Web regression | 313 passed, 0 failed |
| Services production build | Passed, including Prisma generation and TypeScript |
| Web production build | Passed using `next build --webpack` |
| TypeScript | Both repositories passed; later authorization/draft refinements were checked again |
| Prisma Core schema validation | Passed |
| Services lint | Passed |
| Affected Web source lint | Passed |
| BFF ownership check | Passed |
| Diff whitespace check | Passed |
| Python assertion/context and clustering unit suite | 8 passed, 1 dependency-dependent skip |

The sandboxed default Turbopack build stalled and was stopped. The Webpack build compiled, completed TypeScript, generated pages and completed build traces. HTTP tests blocked by sandbox `EACCES` were rerun with local test-server access.

Dedicated code tests cover random references; encryption/binding; leading-zero-safe six-digit values; redaction; committed failed attempts and five-attempt lockout; replay; wrong doctors; stale versions/generations; payment/time-window restrictions; cancellation, withdrawal and changed assignments; patient-only retrieval; persistent reissue limits; and historical episode filtering. Web checks include hidden identifiers, skipped patient enrichment, old/contradictory privacy DTO rejection, shared SSE composition, role-bound access endpoints and handoff/code availability while AI is disabled.

The four skipped Services checks require configured isolated environments: Core/RabbitMQ integration, intake PostgreSQL integration, messaging retention/privilege integration, and the new appointment-code concurrency integration. The latter can run only with `VITAL_APPOINTMENT_ACCESS_TEST_DATABASE_URL` pointing to `127.0.0.1/vital_appointment_access_test`; it uses a uniquely named test schema and verifies concurrent attempts/redemption using real row locks. It was not connected to a database in this run.

## Reproducible source checks

From `vital-services`: `npm test`, `npm run build`, `npm run lint`, and `node node_modules/prisma/build/index.js validate --config prisma/core.config.ts`.

From `vital-web`: `npm test`, `npm run check:bff`, `node node_modules/typescript/bin/tsc --noEmit`, affected-file ESLint, and `node node_modules/next/dist/bin/next build --webpack`.

The optional real database test is `node --import tsx --test test/eda-appointment-access-postgres.test.ts`, with the isolated test URL described above. Run deployment/backfill only under the separate maintenance procedure; these verification commands do not activate features.

## Remaining operational acceptance

1. Provision the dedicated versioned AES keys and separate HMAC key for API/transition workers. No real secrets were generated or changed.
2. Obtain hospital review of consent wording, retention, historical evidence and privacy policy.
3. Apply migrations through tools in an isolated environment; verify runtime privileges and run the PostgreSQL/broker suites.
4. Exercise the paired Web/Services/NLP deployment: concurrent redemption/reissue/cancellation, scheduling/payment conflicts, logout/expiry, token rotation, old clients and unavailable owners.
5. Complete real offline-model/resource acceptance and elderly-user/mobile, large-text, keyboard, screen-reader, printing and stale-view checks.
6. Cut over with writers stopped and outside active consultations; run the maintenance backfill, then activate only after acceptance.

No services were deployed, feature flags enabled, TRACE data changed, legacy data imported or repositories/databases deleted. No clinical specialty-routing approval or ML training is required for this revised scope. These checks establish prototype/source behavior, not clinical safety, diagnostic accuracy, anonymity or production privacy certification.

See [the implementation brief](vital-ai-implementation.md) and [status/completion report](vital-ai-status-and-completion-report.md).

---

## Earlier verification history (superseded scope)

# VITAL intelligence implementation verification

## Clinical-specialty alignment — 27 October 2026

VITAL now uses `vital-departments-v2`, matching TRACE's 19 canonical clinical specialties; Dermatology and General Surgery are excluded. Source contracts were inspected at TRACE staging `fccd4e6` and VITAL Web staging `8a0d492`. All packaged UUIDs remain unresolved. **Source verified; deployed response unverified:** no authenticated staging session was available, so seed definitions were not treated as live records.

The full Web regression run passed all 308 tests. The full Services run passed 480 tests with no failures and three skips (483 total). The latest focused intelligence checks passed all 19 tests, including rejection of hospital/uncategorized bindings. The final four Web specialty tests passed, covering the exact authenticated Gateway category query, uncached bounded reads, browser response compatibility, lookup failures, malformed/duplicate/inactive rows, and browser authority rejection. Profile and provisioning checks also passed. Services and Web TypeScript checks, BFF ownership checks and diff whitespace checks passed. Targeted Web lint reported no errors and one existing staging ProfileForm hook-dependency warning.

No deployment, migration, seeding, TRACE record change or feature-flag activation was performed. Prior model/runtime acceptance limitations remain outstanding. Details are in [department mapping](department-mapping.md).

## Department-mapping update — 26 October 2026

The finalized 20-department catalog, accepted BODHI source IDs, spelling aliases, exact TRACE resolution and legacy-analysis reanalysis handling are implemented. All 20 packaged UUID bindings remain null; no live staging lookup was performed and no records, flags or deployments were changed. See [department mapping](department-mapping.md).

Mapping verification: full Services suite 483 tests, 480 passed, zero failures, three skipped; 18 focused intelligence tests passed; three Python provenance-projection tests passed; affected Web lookup/profile/delegation tests passed, including browser-authority rejection. Services and Web TypeScript checks, targeted Web lint, BFF ownership checks and Python source syntax checks passed. No model-image rebuild, resource-limit acceptance or new live PostgreSQL run was performed for this update. Earlier runtime limitations below remain outstanding.

## Initial implementation verification — 25 October 2026

Verified locally on 25 October 2026. Feature flags remain disabled by default; no existing database was migrated and no production service was replaced.

## Completed checks

- Services build, including both Prisma client generations and TypeScript compilation.
- Complete Services regression suite: 474 tests, 471 passed, no failures, three skipped. The opt-in PostgreSQL test is one of those skips in the ordinary suite.
- All Core migrations applied in order to an isolated PostgreSQL 16 container with temporary storage.
- Opt-in PostgreSQL test passed separately: encrypted draft persistence, optimistic version conflicts, session isolation, expiry denial, physical expiry sweep, stale-job claiming, logout deletion and rejection of delayed saves after logout.
- Web TypeScript compilation, BFF ownership check and targeted lint. The earlier full Web regression run passed all 304 tests; the final affected authentication/session run passed all 28 tests.
- Python context and DBSCAN tests passed with scikit-learn installed. The model image also exercises actual MedCAT and MiniLM inference using synthetic examples, with network access disabled for inference.

The runtime smoke test exposed root-only permissions on generated model weights. The Dockerfile now makes immutable assets readable and executes model tests as the unprivileged runtime user; all 15 tests passed after this correction.

The corrected image's final export and resource-limited smoke run were interrupted when the Windows C: drive reached zero free space. The temporary host Python test environment was removed to recover space. The 2-GiB/one-CPU/read-only runtime acceptance remains unverified; the successful build-stage tests must not be treated as that acceptance. Free Docker storage and repeat this check before rollout.

## Repeat the database check

Use an isolated database named `vital_ai_implementation_test`, apply Core migrations, and set `VITAL_AI_TEST_DATABASE_URL` to its loopback address. Run:

```powershell
node --import tsx --test test/eda-intelligence-postgres.test.ts
```

The test refuses other database names and non-loopback hosts. It creates synthetic identities and removes them afterwards. Never point this test at an operational database.

## Remaining release acceptance

Clinical reviewers must author and approve sourced routing criteria with verified TRACE IDs. The checked-in artifact remains unreviewed and contains no hospital routing rules.

Staging must still exercise complete authenticated browser journeys, Gateway expiry and token rotation, concurrent slot booking and retries, doctor-approved EHR handoff, failure injection, production runtime privileges, shared AIMS heavyweight-work coordination and sustained load at the configured Node/Python limits. Local tests cover selected contracts; they do not establish clinical accuracy or complete staging acceptance. Do not switch legacy analytics traffic or enable the patient journey before these gates pass.
