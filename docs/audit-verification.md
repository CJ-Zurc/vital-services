# VITAL audit implementation verification

Verified locally on 2026-10-29. This records source verification, not deployment acceptance.

## Delivered

- BGH Audit recognizes the finite VITAL event catalog and strict universal version-2 metadata from `vital-services`, retaining legacy ingestion and event-ID replay/conflict handling.
- Services enriches new audit intents only, preserves persisted legacy payloads, and records verified security denials separately from failed business transactions.
- VITAL administrators have scoped history, approved details and bounded CSV export at `/admin/dashboard/audit-logs`.
- Export checks include exact totals, duplicate/incomplete pages, membership revocation, cancellation, date/row limits, formula protection and mandatory local audit persistence.
- The catalog records the owner module, trigger classification, entity, outcome and known changed-field names. Metadata is restricted by the publisher and receiver contracts; arbitrary field values are prohibited.

## Local results

| Check | Result |
|---|---|
| BGH Audit full Python suite | 682 passed |
| Scoped VITAL ingestion compatibility suite | 621 passed, included in the full Python suite |
| Services full regression suite | 496 passed; 4 skipped; 0 failed |
| Services focused audit tests after catalog documentation refinement | 5 passed |
| Web full regression suite | 322 passed; 0 failed |
| Web focused audit tests after final authorization/projection refinements | 8 passed |
| Paired route review | 7 passed; static evidence only |
| Services and Web TypeScript | Passed |
| Affected Web source lint, Services route-script lint and Audit source Ruff | Passed |
| Web BFF ownership | Passed |
| Web production build | Passed with webpack; initial sandbox filesystem restriction required a retry outside the sandbox |
| Whitespace checks | Passed |

The four Services skips require optional integration/runtime fixtures. Python verification used an isolated local environment; it did not connect to a deployed audit database. Full-suite results precede the final small projection/authorization refinements, which were rechecked with focused tests and TypeScript. No test result establishes production authentication, database permissions, delivery recovery or browser accessibility.

## Remaining acceptance

Docker Desktop's Linux-engine pipe was unavailable. No containers were started, no databases were migrated and no live-service rehearsal or deployed-event verification was claimed.

1. Start isolated PostgreSQL, RabbitMQ, Audit, Gateway and VITAL services with their existing scoped credentials. Run optional integration fixtures.
2. Verify old queued payloads and new version-2 payloads reach Audit unchanged across retries, reject conflicting IDs and recover through the existing delivery procedure after an Audit outage.
3. Exercise administrator membership revocation, token expiry, SuperAdmin isolation, filters, safe details, paging and CSV against real Gateway/Audit responses.
4. Confirm sensitive denied operations remain denied when local audit persistence fails. Verify no clinical text, codes, secrets or perimeter identifiers enter stored metadata.
5. Check keyboard/screen-reader behavior and cancellation in a browser. Confirm retention matches Audit configuration; the repository default remains 365 days.

Deploy Audit's backward-compatible receiver recognition first, then coordinated Services publishing and Web routes/UI. Actual deployment and activation remain separate operations. No automatic anomaly detection, retrospective events, retention changes or unrelated team changes are included.

See [the integration guide and event catalog](audit-integration.md) for configuration and rollout details.
