# Dashboard and doctor discovery redesign

Admin Dashboard separates all-time operational totals from month-to-date outcomes
and date-filtered symptom submissions. No payment owner is required for the admin
read. Patient dashboards and financial workflows keep their existing owners.

## Operational read

GET /api/admin/dashboard delegates to the existing signed completion.admin.dashboard
read. The paired DTO removes summary.paidVolume and paymentCounts. It adds
consultationCounts (virtual/in_person), monthly (from/to/asOf plus completed,
cancelled/noShow), and doctorSpotlight.leaders. The month is computed in Philippine
time. Completion uses completedAt on currently completed appointments; other
outcomes use distinct appointment IDs in their dated status-transition logs.
Null legacy completion timestamps are excluded. Counts are not inferred from
updatedAt, scheduledAt, ratings or payment records.

Doctor of the Month is a month-to-date volume highlight, not a clinical quality
award. Current Core doctor members with completed onboarding qualify. All tied
leaders are returned; no eligible completion yields an empty list. Rating and
review counts are all-time aggregates of valid feedback for completed appointments
and do not decide the ranking. No patient identity, complaint or individual rating
is returned. Auth display names and optional public picture URLs are enriched in
Web; images fall back to initials. Doctor discovery uses the same trusted image
projection without exposing Auth IDs to patients.

## Symptom and pattern reporting

The symptom date filter applies only to symptom submissions. Trends distinguish
submitted and analyzed records. Zero-submission calendar days are explicit zeroes;
counts of 1–4 remain null, displayed as Hidden for Privacy, with gaps in charts.
Chart labels and tooltips never substitute zero for withheld data. These reports
count submissions, including later cancellations, not patients or diagnoses.

Version-2 symptom dashboard data retains clusters:null and does not read cluster
versions or labels. GET /api/admin/analytics/patterns delegates via ai.admin to
POST /internal/v1/ai/admin/patterns. It requires current admin membership and the
existing VITAL_AI_ENABLED/VITAL_AI_ANALYTICS_ENABLED flags. It returns contractVersion:1
and snapshot:null or aggregate snapshot metadata, cohort summaries and pattern
labels. Member IDs and raw clinical text are excluded. The fixed 90-day window,
2,000-per-cohort limit, suppression and clustering algorithm are unchanged.

/admin/dashboard/complaint-patterns?tab=overview and ?tab=reviews are two views of
one admin page. POST /api/admin/analytics/clusters/label retains the exact suggested
label contract. It rejects expired/superseded snapshots, including rollover between
validation and insert. Confirmation is explicit; cancellation has no write.

Patient navigation is Book Appointment, Schedule, Prescriptions & Certificates.
Doctor cards use existing discovery, filters, ratings, profile and booking routes.

## Delivery and verification

No schema migration, award worker, new provider or chart dependency is required.
Deploy compatible Web/Services together because the operational DTO changes.
Source and mocked browser checks do not establish live Auth, PostgreSQL aggregate,
concurrent snapshot rollover or deployment acceptance. No commits, pushes or
production deployment are part of this implementation request.

## Verification performed — 21 November 2026

- Services: 39 focused regressions and route-contract checks passed, including
  Payment-independent reads, Philippine month boundaries, joint/empty leaders,
  privacy suppression, snapshot validation and admin authorization.
- Web: 35 focused regressions passed; TypeScript and BFF ownership checks passed.
- Services production build passed. Web compiled, passed its build-time TypeScript
  check and generated all 162 pages, but the command exited with the installed
  Next.js dependency's `SecurityFatalError`. Web production-build acceptance is
  therefore outstanding; no dependency upgrade was included in this UI change.
- Mocked browser checks exercised the actual React components and compiled styles
  at 390px and 1440px: responsive charts/cards, privacy gaps and real zeroes,
  empty/joint monthly leaders, independent reporting failures, pattern tab URLs,
  label cancellation/confirmation/stale refresh, doctor search/profile navigation
  and mobile navigation order. Screenshots and the fixture harness are in the
  workspace `outputs` directory. Fixtures are test data, never production metrics.
- These checks used synthetic API responses and SQL test doubles. Live Gateway,
  Auth, PostgreSQL aggregation, concurrent snapshot rollover and a real booking
  submission were not exercised. Existing booking code paths were preserved.
