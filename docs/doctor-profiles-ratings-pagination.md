# Doctor profiles, criterion ratings and paginated discovery

Bio and Education controls and public UI sections are removed. Stored profile values remain unchanged when omitted; onboarding still requires the assigned specialty, PRC, saved signature, availability, applicable virtual fee and agreement.

## Ratings contract

POST /api/appointments/:id/feedback retains signed Appointment ownership. Its strict request requires expectedVersion and four integer scores: friendlinessAttitude, professionalism, explanation, careServices (1–5 each). The server stores ratingVersion=2 and starRating=(sum)/4 without rounding. Client-supplied overall/rating fields and comments are rejected. Obsolete rating payloads return APPOINTMENT_RATING_FORMAT_RETIRED, directing the patient to refresh.

The unique appointment constraint, version checks, transaction locks, financial verification for virtual consultations, doctor-completed face-to-face eligibility, command replay and audit outbox remain. Old version-1 reviews retain their stored values and prevent a second review. They are excluded from new aggregate averages, review counts and review lists. Owner appointment details identify the earlier format. All doctor aggregates, including spotlight ratings, use version 2 only. Headlines show one decimal; individual overall scores retain fractional precision. Patient lists expose only overall/date entries; authorized admin reviews include criterion scores.

## Directory ownership and paging

Core doctor_directory_entries contains only trusted Auth name/email search projections and Auth/Core doctor IDs, grouped by generation. Auth remains authoritative. There is no Auth/EHR database access and no Auth/EHR code change. Public discovery neither searches nor returns the email projection.

The existing worker uses VITAL_AUTH_INTERNAL_URL and VITAL_SERVICES_AUTH_PROFILE_KEY with the existing /internal/users/profiles/batch contract (100 subjects per request). The same directional key must be available to the worker. Refresh runs in the background at startup, every five minutes, and after doctor/member changes marked by Core triggers. It uses a database advisory lock and stages a replacement generation; publication occurs only if the member revision remains unchanged. Failures retain the previous published generation, discard incomplete staging and retry after 30 seconds. Uninitialized directories return retryable 503 DOCTOR_DIRECTORY_INITIALIZING. No list request scans/enriches all identities as a fallback. Removed Core memberships are excluded immediately by owner joins.

GET /api/admin/doctors accepts page (default 1), pageSize (default 10, max 50), search (max 160). Its private Profile counterpart applies search before count/offset/limit and returns items,total,page,pageSize. Web enriches only those subjects using trusted Auth profile reads. Manage Doctors no longer exhausts /api/admin/users. Account badges describe Auth account flags; system access is managed separately in User Management.

GET /api/patient/doctors returns one page (UI default 12, max 50) with existing opaque snapshot cursor metadata. Web no longer exhausts pages or sorts/filters a full directory in memory. Services applies name/specialty/hospital filters, care mode, date and availability-first ordering before limiting results. Bio is excluded from search. doctorId permits a bounded one-doctor lookup for profile deep links. Database triggers maintain a constant-size discovery revision for membership, calendar, rating and hospital changes, avoiding full-profile revision hashes on every request. Discovery cursors last 15 minutes and remain actor/filter/snapshot-bound; changed snapshots require restarting the directory. Other existing collection cursor lifetimes are unchanged.

Both lists preserve filters/page in URLs. Patient Previous navigation additionally keeps opaque cursor positions in tab-scoped sessionStorage; it grants no authority and contains no clinical information. Page enrichment uses current Auth data, so name changes can appear before the five-minute search index catches up. Current Core membership always controls eligibility.

## Rollout and checks

Apply Core migration 202611220001_doctor_ratings_directory using the existing tools role, then rerun existing post-migration runtime DML grants. It preserves old reviews and profile values, adds criterion constraints/indexes, resets legacy-only cached averages, and creates directory projection tables/triggers. Start the compatible worker and populate the first generation, then deploy compatible Web/Services together. No migration has been executed by this source change.

Focused checks cover criterion validation/mean, replay/duplicates/eligibility, legacy exclusion, bounded query/enrichment, missing directories, failed/superseded refreshes and browser navigation. Mocked SQL/API checks are distinct from live Auth/PostgreSQL acceptance. Deployment, commits and pushes are excluded until requested.


## Verification recorded — 22 November 2026

Web focused regressions, including profile boundaries, anonymous ratings, bounded discovery, admin enrichment and navigation contracts, passed. Services profile regressions and the directory/rating/appointment/route-contract batch passed. The worker batch and aggregation checks use SQL/Prisma doubles; they are not live PostgreSQL migration or concurrency acceptance.

Both type checks and the Services production build passed. Web compiled, completed build-time TypeScript checks and generated pages, then exited at the installed Next.js dependency's SecurityFatalError. Web production-build acceptance remains outstanding; no dependency upgrade is bundled here.

Mocked browser journeys at 390px and 1440px passed for pagination, name search/reset, profile deep links outside the current page, back navigation, four initially unanswered criteria, keyboard scoring, submission/decimal display, admin criterion details and onboarding without Bio/Education. Fixture screenshots and the harness are in workspace outputs. APIs and auth guards were mocked; no real appointment submission, live Auth lookup, database migration, deployment or Google/EHR change was performed.


Manage Doctors opens **View Ratings** in an accessible modal rather than expanding the table row. The modal keeps aggregate/criterion details and bounded pagination, resets to page one on reopening, aborts outstanding reads when closed, supports Escape/close, and returns focus to its trigger. Mocked desktop/mobile checks verified these behaviors and unchanged underlying row heights.
