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
