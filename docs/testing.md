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

For PRs into development/staging, paired route CI checks the Web revision on the
matching base branch. A coordinated Web PR adding routes must reach that branch
before the ordinary Services PR check can pass. Alternatively, run the existing
manual CI workflow on the Services feature branch with `eda_action=none` and
`web_sha` set to the exact published compatible Web commit. Do not reduce the
expected route count or refresh fingerprints against an incompatible Web base.
