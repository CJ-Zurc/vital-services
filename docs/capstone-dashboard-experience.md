# VITAL capstone dashboard and portal refinements

## Delivery state

Implemented in Web and Services on feat/vital/capstone-dashboard-experience.
Existing local work was preserved. Commit and branch delivery are recorded in Git; migration execution and deployment are separate actions and were not performed by this implementation.
Auth, EHR, TRACE and Audit repository sources were not modified.

## Reporting and navigation

Dashboard uses URL tab values overview, complaint-patterns and dispute-follow-up.
Previous standalone pattern/dispute routes redirect to Dashboard.
The shared reporting range defaults to the last 30 Philippine calendar days and weekly buckets.
It supports 7/30/90-day presets, custom ranges up to 366 days, and daily/weekly/monthly intervals.
Weeks start Monday and edge buckets are clipped. All-Time metrics, Month-to-Date outcomes/spotlight,
and the fixed 90-day complaint snapshot keep their own labeled periods.

Authenticated GET /api/admin/dashboard/{collections,satisfaction,specialties} delegates to the matching
/internal/v1/completion/admin/dashboard/{kind} read with a self-bound completion.admin.{kind} scope.
Only from/to/interval query parameters are admitted, without duplicates. Current Core admin membership
is checked by Services before and after owner reads. No AI flag is needed for these reports.

Collections uses Integrations Payment ownership only. It sums integer centavos for verified sandbox
PayMongo payment IDs by paidAt and completed provider refund IDs by refundedAt, excluding external
TRACE-confirmed refunds. Buckets use Philippine time; duplicate webhooks cannot multiply totals.
A later-period refund can make period Net Collected negative. This is sandbox PayMongo activity,
not hospital revenue, provider settlement, profit, or a report including external refunds.
Operational reporting continues to have no Payment dependency.

Satisfaction averages valid version-2 criterion reviews for currently completed consultations,
filtered by submittedAt. Overall is review-weighted; legacy reviews remain excluded.
Specialties count distinct completed appointments by completedAt and the doctor's current recorded
specialty; missing specialties use Unlisted. These are specialty counts, not hospital department claims.

The version-2 symptom dashboard retains clusters:null and daily compatibility output and adds interval/series.
Series counts are aggregated before small-group suppression. Zero stays zero and hidden values stay gaps.

## Complaint Patterns and disputes

Pattern contract v2 contains cohort-local groups with descriptive label, count and grouped percentage.
There are no member IDs, staff-review fields or reads of stored staff labels. Hidden group counts suppress
group percentages; hidden noise suppresses the complementary cohort total. Existing review history is retained.
Cluster-label writes return 410 AI_CLUSTER_LABEL_RETIRED; clinical brief approval remains active.
The clustering algorithm, per-cohort limits, actual generation date and fixed snapshot window are unchanged.

Dispute contract v2 adds complete outstanding-item reason/status aggregates, total/asOf and nextCursor.
The queue uses 25 items per page, with createdAt/id ordering and an upper-bound cursor. Aggregates cover all
outstanding items through the snapshot upper bound, rather than only the displayed page. These are review-item
counts and multiple items may refer to one appointment. Existing TRACE links and workflows remain.

## Code replacement and privacy

POST patient appointment access/reissue requires expectedVersion, generation and a UUID Idempotency-Key.
Services serializes under the appointment lock, checks ownership/consent/status/version, blocks prepared
clinical workflows and pending appointment transitions, and retains hourly throttles. After redemption,
replacement also requires current verified payment and the existing redemption window.
The replacement invalidates the previous code and clears grantedAt atomically. The existing grant deadline
is retained as a cap; replacement cannot extend it. The new generation must be redeemed before live identity,
records or clinical writes unlock again. Matching command retries return the same generation; changed hashes
conflict. Withdrawn or closed access cannot be reopened. Historical signed documents remain intact.
Both portals recheck access; clinical views clear on loss and reject stale responses. This does not erase
information already viewed or downloaded.

Doctor message sends and idempotent replays now use the same known-name masking context as history.
Original stored clinical/message text remains unchanged.

## Shared UI and loading

Health Records restores Cases, Medications, Surgeries, Immunizations and Workups through the existing
authenticated record read. Allergies remains default; Vitals stays hidden here and prescriptions/certificates
stay on the dedicated page. No camera initialization or face-verification flow is added.

The duplicate generated doctor intake paragraph is removed while structured complaint/OPQRST remains.
Read-only inputs, visible report-evidence file controls, receipt placement and alternating admin table rows
use VITAL/neutral tokens.

All 58 page entries have neutral loading fallbacks. Protected role content waits for session verification.
The shared SessionGate has a bounded retry state and preserves expired-session redirects. Bootstrap timeouts,
429 and 5xx failures remain retryable. Navigation uses supported router transitions, link/history events,
a thin green activity bar, completion/fade and reduced-motion handling. Existing mutation spinners and
duplicate-submit protection remain separate. Page/panel skeletons never automatically open dialogs.
See loading-inventory.md in Web for route entries and converted client loaders.

Audit and Message Holds enrich selected-page typed actor/participant IDs through trusted Auth profile reads,
with at most 100 unique IDs and ten concurrent reads. Names/emails are presentation-only; immutable audit
metadata and CSV exports are unchanged. IDs remain available in details; unavailable/system identities
have fallbacks.

## Verification and limits

- Web and Services TypeScript no-emit checks passed.
- Services production build passed.
- Web webpack production build passed; the default Turbopack path failed to initialize its CSS Node worker.
- Full Web regression suite passed: 355 tests.
- Services broad suite: 527 passed, five isolated-database tests skipped, one existing external audit-vocabulary parity failure.
- The audit mismatch concerns vital.appointment.appeal_started and vital.appointment.invalid in Services versus
  the local BGH Audit receiver. This feature did not change the publisher catalog or the external receiver.
- Focused reporting, privacy, code replacement, messaging, session and BFF regressions passed.
- Static route inventory: 187 routes, all source-reviewed; eight route-contract checks passed.
- Mocked headless Chromium journeys passed at 1440x1000 and 390x844, including tab navigation, charts,
  privacy gaps, independent Collections failure/retry, reduced motion, and no horizontal page overflow/errors.
- Browser screenshots were visually inspected. API fixtures are not live Auth/PayMongo/EHR/TRACE acceptance.
- Live database concurrency/rollback, authenticated provider integration and exhaustive role-specific modal
  journeys still require the configured integration environment. No production data reset or migration ran.

Deploy compatible Web and Services builds together. There is no new schema migration in this batch.
