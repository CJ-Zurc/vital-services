# VITAL Services verification

Run `npm test`, `npm run build` and `npm run lint` in this repository. The suite
includes ownership, event, replay, security, profile and baseline-manifest tests.
Live PostgreSQL/RabbitMQ checks require the explicit isolated integration harness;
a skipped check is not a pass. Runtime images exclude development test tooling.

Root lifecycle/Compose changes require script syntax checks, dry-run startup,
Compose rendering and env preflight. Staging verification separately covers exact
image IDs, migrations, scoped infrastructure, seed relationships, outbox replay,
scanner/media, session/SSO and affected patient/doctor workflows. Do not label
manual checks GitHub CI or claim unexecuted bulk/load/fresh-OS checks passed.

`eda-profile-schedule.test.ts` covers Profile version updates used by booking
contacts, schedule availability and SQL effects, including durable events and
unchanged-contact no-ops. `VitalUser` has no `updatedAt` column; these updates
must change only `version` to avoid PostgreSQL `42703` and transaction rollback.

## Sprint 6 document checks

See [Capstone documents](capstone-documents.md) for strict signing/classification, private signature replacement, immutable issuance, S2 validity, acknowledgment authorization/replay and migration tests. The root test catalog records retained coverage and the temporary S6 suites removed after execution at the user's request. Their historical results remain in the implementation report; the removed migration harness is no longer runnable.

For development PRs with coordinated Web changes, the repository variable
`VITAL_EDA_PR_<Services PR number>_WEB_SHA` selects the full published companion
Web SHA. For example, PR 20 reads `VITAL_EDA_PR_20_WEB_SHA`. Malformed values fail;
checkout and the existing exact-source/route checks verify the selected commit.
The setting applies only to that PR into development. Other PRs, staging checks
and development/staging pushes continue using their matching Web branch. Remove
the PR-specific variable when closing the PR. No SHA file or helper script is
needed. Manual runs retain `web_sha` with `eda_action=none` for validation only.
Do not reduce route counts or refresh fingerprints against incompatible source.


## S6-005 / S6-009 source verification

Maintained Profile/admin-management suites cover bounded current-admin patient
summaries, safe field projection, combined filters, role override denial and
pagination past 100 accounts. Messaging owner/BFF suites cover exact scheduled
boundaries, missing schedules, cancellation, accepted replacements, overlapping
windows/gaps, ownership, locks, encrypted history and committed retries after
closure. The existing Philippine overnight interval tests remain unchanged.

Local 2026-10-21 results: Services 435 passed / 2 isolated-DB checks skipped;
Web 279 passed; final transport 14 passed; route source review 5 passed for 124
routes. Services build/configured lint and Web TypeScript/build/BFF check passed.
Chromium verified admin patient UI/filter links and both messaging roles' timer
transitions/draft preservation/clock-skew backoff using fictional mocked APIs.
The temporary browser script is removed; retained unit suites remain registered
in the workspace catalog. Docker was unavailable: real authentication, external
account actions and live concurrent event/SSE workflows remain acceptance gates.


S6-011–S6-014 local verification (2026-10-21): Services 442 passed / 2 isolated-stack checks skipped, Web 283 passed, Gateway 235 passed, Central Notification affected suite 53 passed, and source contract review 5 passed for 131 routes. Builds, TypeScript/BFF checks and focused lint passed. Actual Prisma fresh/previous-schema/repeat deployment and direct SQL tests passed against temporary in-memory PostgreSQL instances. Fictional mocked-API Chromium checks passed for doctor calendar/complaint/inbox, patient numerical ratings/read-only history and admin ratings. Genuine multi-connection PostgreSQL and full Auth/broker/payment/video/Records acceptance remain pending because Docker is unavailable. See the saved Sprint 6 checklist; no deployment or database reset was performed.


## Pre-push cleanup check — 2026-10-22

After the Web public-error and page-boundary changes, the paired static route
review correctly rejected stale source fingerprints. Re-reviewed the changed
Web wrappers/helpers/tests and refreshed 51 existing reviewed fingerprints in
`scripts/eda/route-contracts.mjs`; no route was removed, no guard was disabled,
and the inventory remains 131 routes. The maintained route-contract suite passed
5/5, including changed/unknown-source rejection. This is source review, not live
runtime acceptance. Web and Services have no untracked JSON/image/log/scratch
artifacts, no tracked file deletions, and both pass `git diff --check`.

The Gateway-locality revision remains paused while the existing feature work
is committed/pushed by the user. No branch switch, stash, commit, push or Gateway
edit was performed during this cleanup check. Publish the matching Web source
with Services so exact-source CI can verify the reviewed companion checkout.


## S6 local-workflow boundary — 2026-10-22

Created S6-Revision from freshly fetched origin/development (423b306); the working
tree was clean, so no recovery stash was needed. No production Services module,
API, domain rule or migration changed. Extended the maintained issuance test to
verify that ordinary/mixed/controlled prescription QR URLs use the configured
VITAL Web origin and authenticated page, without query data. Refreshed only the
reviewed fingerprint of the changed Web appointment-revisions test, retaining
all 131 route checks and unknown/changed-source rejection.
The route-contract/Records batch passed **33/33** (including all five static
contract checks). The initial sandbox run blocked one loopback HTTP connection
with EACCES; the same batch passed outside the sandbox. Container and live-stack
acceptance remain pending because Docker was unavailable. Existing migrations,
private mTLS/signed transport and authorization rules are unchanged.
Publish matching Web source before Services, or select it through the existing
PR companion setting. No commit, push, PR, database reset or deployment occurred.

## Complete browser compatibility retirement (2026-10-22)

Supersedes the earlier decision to preserve older browser compatibility routes.
All `/vital/bff/...` paths are now rejected unconditionally by the router and
have no manifest entries. This includes Auth browser wrappers; actual `/auth/*`
SSO/Auth integration remains, along with EHR, Analytics, TRACE, central
Notifications and `/vital/integrations/v1/*` cross-system contracts.
No Web or Services runtime caller uses the retired prefix. No database migration,
commit, push or deployment is included. Legacy stream helper unit tests remain;
obsolete positive browser routing/forwarding tests are replaced with rejection
coverage. Full Gateway suite: 428 passed. Focused Ruff passes. Container rebuild
and genuine live browser/SSO acceptance remain pending; no live result is claimed.

## S6 staging investigation (2026-10-22)

After fetching all origins, staging signature upload reproduced HTTP 500 while
private reads worked. Local fixes cover scanner 503/Retry-After, invalid-image
400, metadata-only diagnostics, encrypted versions, replay and role/owner isolation
in the maintained Records suite. Final Services suite: 445 passed / 2 skipped;
build, ESLint and TypeScript passed. Exact-source review: 5 passed (131 routes).
Web: 295 passed, build and BFF checks passed. Root configuration: 6 passed.

Live calendar previews, patient monitoring, doctor/rating directories and role
denials passed. Complete issuance/acknowledgment, timed messaging and reschedule
lifecycles remain pending: the doctor cannot finish onboarding until signature
processing is repaired, eligible test appointments were unavailable, and Payment
composition reports unavailable. Notifications remain intentionally deferred.
No staging deployment/configuration/database operation was performed.

## Temporary capstone validation-only build (2026-10-22)

Services selects `capstone-validation-only` centrally in `inspection.ts`. ClamAV
is retained for restoration but is not constructed/contacted by signature,
attachment/document or payment-QR processing in this build. See
[policy/evidence and rollback](capstone-file-validation.md). No new .env, public
API shape, database migration, Gateway or Capstone_BGH change is included.
Earlier scanner repairs/results above remain historical; current demo writes
truthfully record `not_scanned` validation evidence rather than clean scan claims.

Maintained test registration for this revision:

| Suite | New coverage |
|---|---|
| `test/eda-records.test.ts` | Capstone signature save/preview/replacement/replay without antivirus; Records/signing/artifact runtime creation without scanner paths. |
| `test/eda-records-artifacts.test.ts` | Selected default policy, real PNG/JPEG/PDF validation, invalid/oversized files, aborted work, evidence binding/freshness/policy checks, restoration/historical reads, branded signed prescription/certificate and attachment publication with commit-failure retry. |
| `test/eda-records-artifact-repository.test.ts` | Database publication accepts truthful demo evidence only under the selected write policy; antivirus mode rejects it without publication. |
| `test/eda-profile-qr.test.ts` | Payment QR publication with unavailable antivirus and truthful evidence, historical private reads after restoration, runtime without scanner paths. |

Final full Services suite: **452 passed, 2 isolated-stack tests skipped**. Final
strengthened capstone inspection/publication recovery rerun: **2 passed**. Services
build/TypeScript and configured lint passed. Web: **295 passed**, BFF check and
production build passed. Exact-source route review: **5 passed**, 131 routes;
no reviewed Web validator/test fingerprints changed. Existing antivirus suites
remain passing. The root test catalog is intentionally untouched by this
VITAL-only revision; this table records the maintained coverage instead.

No temporary verification artifacts were added to either repository. No staging
mutation or live antivirus-disabled acceptance was attempted. After a separately
authorized deployment, retest signature onboarding and actual issuance/QR/file
retrieval; unrelated Payment and notification availability gates remain.

## October 23 paired Web acceptance repairs

No Services runtime/schema change. Reviewed hashes were updated for the Web serializer, payment client, Records BFF and maintained payment/Records tests after reproducing staging defects. Exact-source contract suite: 5 passed; Web full suite: 302 passed, BFF check and production build passed. Earlier Services full-suite result is historical (452 passed, 2 isolated-stack skipped), not newly executed live acceptance. Deliver the reviewed matching Web revision through the existing compatibility process; no checks weakened. Live sandbox payment/four document issuances passed, but media download is truncated and normal completion-dependent workflows remain pending. Detailed sanitized evidence: `../../output/s6-payment-document-verification-2026-10-23.md`.
