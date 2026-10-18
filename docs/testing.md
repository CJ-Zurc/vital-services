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
