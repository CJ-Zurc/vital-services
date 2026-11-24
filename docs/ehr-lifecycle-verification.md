# EHR lifecycle verification — 24 November 2026

## Source delivered

- VITAL Web/Services: `feat/vital/ehr-lifecycle-integration`.
- UHSE EHR: `feat/ehr/vital-lifecycle-integration`.
- All branches originated from separately fetched `origin/development`; unrelated
  checked-out feature branches were not merged. Verification preceded the separately requested commit/PR delivery.
- Migrations are supplied, not executed. No deployment or historical backfill ran.

See [implemented contracts and rollout](ehr-lifecycle-integration.md) and EHR's
`docs/features/vital_lifecycle.md` for authorization and activation prerequisites.

## Passed checks

- Web: 83 focused regressions covering new prefill/BFF/metadata behavior plus
  appointment reads, approvals, Profile boundaries and real transport checks.
- Services: a 103-test appointment/complaint/Records/lifecycle/route-contract
  batch passed outside the sandbox for its loopback HTTP test servers.
- Subsequent focused reruns passed: 61 appointment/lifecycle/contract tests,
  including patient-first acknowledgment and rescheduled-case reference binding;
  eight lifecycle tests passed after final receipt-validation hardening.
  These overlap the earlier batch and must not be added as independent coverage.
- Both TypeScript checks; Services production build (`npm run build`, including
  both Prisma client generations); Core Prisma schema validation.
- Web production build (`next build --webpack`), including build-time TypeScript
  and all 165 static pages. New route directories use the existing
  `[appointmentId]` parameter convention.
- Web BFF ownership check; all 184 static route contracts reviewed, with zero
  missing reviews. Static review is not deployed route-parity evidence.
- Changed EHR Python modules, test and migration compiled successfully.
- Git whitespace checks passed.

## Mocked browser checks

Actual Onboarding and Final Diagnosis components were bundled with existing
styles and exercised in headless Edge at 390px and 1440px. APIs/session helpers
were mocked; this was not a live hospital booking journey.

Verified limited prefill before agreement acceptance, the unchecked agreement
field, visible retry after an outage, preservation of an edited phone number
across retry, initially blocked completion, explicit final-diagnosis save,
revision using the previous diagnosis ID, unsaved changes blocking completion,
and absence of horizontal overflow. No browser case/doctor/patient authority
fields were submitted in diagnosis requests.

Harness/logs/screenshots are in workspace `outputs/ehr-lifecycle-*` and
`outputs/ehr-final-diagnosis-*` / `outputs/ehr-onboarding-prefill-*`.

## EHR runtime and live integration limits

Docker Desktop's Linux engine is unavailable. The requested isolated Python
dependency installation was declined. An existing environment was then tried
without installation; EHR pytest collection stopped because SQLAlchemy asyncio
requires the missing `greenlet` dependency. The new native EHR regression tests
are supplied but have **not executed**. Python compilation is not a substitute.

Before rollout, rebuild/test EHR in the supported environment and run its full
pytest suite. Verify the supplied migration against the real PostgreSQL schema,
case/journal atomicity, concurrent operation delivery, native diagnosis rules,
follow-up-plan contention and recovery, and real Auth eligibility. SQLite/SQL
doubles do not prove PostgreSQL locking or transaction behavior.

Then perform a paired live journey: existing-patient onboarding, code redemption,
diagnosis save/revision, patient-first and doctor-first acknowledgment, worker
closure with an expired browser session, timeout/replay recovery, virtual
follow-up creating a distinct linked case, rescheduling, and F2F producing no
case or plan mutations. Confirm secret/grant/worker configuration and private
endpoint reachability through the owning deployment configuration.
