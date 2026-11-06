# VITAL audit history and export

Updated: 2026-10-29. Source implementation, with no deployment or production activation performed.

Local results and outstanding runtime acceptance are recorded in [audit verification](audit-verification.md).

## Ownership and contract

BGH Audit is the canonical audit store. VITAL Services commits audit intents to the existing Core/Integrations outbox and delivery pipeline. The ordinary worker sends POST /ingest/business using its scoped X-Audit-Ingest-Key. New intents carry schema_version=2 and source_service=vital-services, using BGH Audit's finite universal metadata vocabulary. The receiver still accepts existing legacy VITAL events. Persisted legacy intents and delivery payloads are not rewritten or enriched, and event IDs/payloads remain stable during retry.

Metadata contains event/time/correlation identifiers, verified actor identity/type, entity references, action and outcome. Approved changed-field names may be recorded without their values. Code values, tokens, credentials, messages, clinical notes, patient names, IPs and user-agent strings are not recorded. A missing legacy outcome or actor type remains Not recorded. Generic legacy user_id is treated as actor identity only for the known legacy VITAL resource-reference contract.

The maintained code catalog is src/eda/contracts/audit-catalog.ts. Its accepted names stay in parity with BGH Audit's VITAL allowlist. Some names are compatibility aliases, not proof that a current workflow emits them. The table below describes default metadata for new intents, never retroactive classifications of old events. Successful operations keep their audit intent in the same transaction. Denied verified operations use a separate transaction after rollback. Incorrect code counters and their audit intents commit together, with a separate lockout event on the fifth incorrect attempt.

Security events cover incorrect codes, lockouts, access/privilege denials, throttling and rejected code operations. Generic denials contain only registered route templates, method and fixed reason classifications, without raw error text or guessed resource IDs. Invalid signatures and login/perimeter evidence remain owned by Gateway/Auth; VITAL does not trust unverified identity headers. Failed security-intent persistence preserves the denial and emits content-free persistence-failure telemetry. Automatic anomaly detection/alerts are not included.

## Administrator interface

The page is /admin/dashboard/audit-logs. GET /api/admin/audit-logs lists VITAL history. POST /api/admin/audit-logs/export downloads a filtered CSV. Both require a validated admin session AND current VITAL administrator membership. SuperAdmin alone is insufficient. The BFF uses Gateway with the validated token, X-System-Context: vital and correlation ID, forcing system=vital for every query and checking every returned event's system. It never proxies a browser-selected system or URL and does not call Audit's SuperAdmin-only raw-detail/timeline endpoint.

The UI defaults to seven hospital-calendar days and 50 rows. It supports exact event type, outcome, actor, entity, correlation and date filters. It shows readable event labels, approved metadata, copyable identifiers, cache/freshness and explicit loading/empty/failure states. History is refreshed passively on focus and once per minute while visible to recheck authorization; stale rows and selected details are cleared on failed revalidation. No patient-name enrichment or log editing/deletion is provided.

Filters use Asia/Manila calendar boundaries and timezone-bearing instants. Cursor pages retain an upper time bound. Actor filtering uses the existing user_id query contract for current and legacy VITAL events. Entity/outcome filtering uses BGH Audit's existing details.entity_id/outcome fields; older legacy resource_id events remain readable but cannot acquire fields they never recorded.

Safe detail data comes from GET /audit-logs/business with summary_only=false. The BFF projects explicit safe DTO fields and discards raw/unknown details. Existing Audit history-access recording remains independent of VITAL's own per-request view event. One VITAL view intent is recorded per BFF list call, not per export pagination call.

## Durable private operations

POST /internal/v1/audit/intents accepts event=viewed, export_requested, export_completed or export_failed, with optional resultCount (0..10000). Scope audit.admin.write is self-bound, admin-only and checks Core membership inside the recording transaction. Commands use signed UUID/hash metadata and the existing idempotency journal. No new tables/migrations are required.

POST /internal/v1/audit/denials accepts only the two fixed public audit route templates and their exact methods. Scope audit.security.write is self-bound to an already verified VITAL actor. It records a boundary denial and grants no read/export/admin capability. The private mTLS and actor-signing boundary remains enforced. These are server-only interfaces, not browser-supplied audit records.

## CSV completeness and privacy

Exports require explicit dates spanning at most 31 hospital-calendar days and allow at most 10,000 events. They request existing exact totals, traverse cursor pages and reject oversized, foreign, repeated, changing-total, missing-total, expired-membership, aborted and incomplete results. They never silently truncate. A fixed upper timestamp excludes newly occurring events, while late ingestion/count changes cause a retryable rejection. This does not provide a database snapshot or tamper-evident forensic package.

Generation is bounded by 60 seconds, reserving time for recording failure outcomes. The request intent must commit before retrieval. Completion auditing and final membership validation must succeed before releasing the CSV. Failures produce a failed-export intent where durable storage/valid authorization remains available. An Audit outage is queued through the existing worker; failure to persist the local required intent prevents CSV release.

The CSV uses UTF8 with BOM, CRLF, proper quoting and formula-prefix protection. Columns: timestamp, eventType, outcome, actorType, actorId, entityType, entityId, correlationId, eventId, source, action, reason, route, method, changedFields and resultCount. Files have generated date-only names, private/no-store responses, no storage objects and no public URLs. Users must still handle exported identifiers as restricted administrative information.

BGH Audit retention remains controlled by its existing setting (repository default 365 days). No backfill, new retention policy, new log database, alert engine or special access bypass is included.

## Configuration and rollout

Use existing VITAL_EDA_ENABLED, Gateway/Auth/BFF transport, VITAL_AUDIT_URL and AUDIT_VITAL_INGEST_KEY. Run the ordinary delivery/consumer worker. No additional production env flag or secret is introduced. Audit's matching scoped key, unique event index and Gateway trust must already be configured. Monitor existing delivery_outcome and delivery_snapshot telemetry for retries/blocked rows, rather than treating local outbox insertion as proof of central receipt.

1. Deploy Audit recognition/validation first. Confirm old and version2 scoped events persist idempotently and foreign-system/unknown/unsafe records fail closed.
2. Deploy compatible Services API/ordinary worker and Web together, including updated private route delegation and the paired static route review.
3. Verify committed business events and denied accesses in the central VITAL history. Reconcile existing blocked deliveries through the owner-approved recovery procedure without altering their persisted payloads.
4. Check ordinary admin, revoked admin, SuperAdmin without VITAL membership, cross-system substitution and expiry. Exercise all filters, cache refresh, safe details, CSV boundaries and cancellation.
5. Rehearse against isolated actual PostgreSQL/RabbitMQ/Audit/Gateway before acceptance. Unit/mock tests and a static route review do not certify deployed permissions, delivery or browser accessibility. No live deployment or service restart is part of this source change.

## Event catalog

| Event type | Owner module | Entity | Trigger classification | Default outcome | Known changed fields |
|---|---|---|---|---|---|
| vital.appointment.access_code_reissued | appointment | appointment | access_code_reissued | success | Not supplied |
| vital.appointment.access_redeemed | appointment | appointment | access_redeemed | success | Not supplied |
| vital.appointment.access_withdrawn | appointment | appointment | access_withdrawn | success | consent |
| vital.appointment.approved | appointment | appointment | approved | success | Not supplied |
| vital.appointment.cancelled | appointment | appointment | cancelled | success | Not supplied |
| vital.appointment.complaint_updated | appointment | appointment | complaint_updated | success | chief_complaint |
| vital.appointment.completed | appointment | appointment | completed | success | Not supplied |
| vital.appointment.completion_acknowledged | appointment | appointment | completion_acknowledged | success | Not supplied |
| vital.appointment.confirmed | appointment | appointment | confirmed | success | Not supplied |
| vital.appointment.date_block_created | appointment | appointment | date_block_created | success | Not supplied |
| vital.appointment.date_block_deleted | appointment | appointment | date_block_deleted | success | Not supplied |
| vital.appointment.expired | appointment | appointment | expired | success | Not supplied |
| vital.appointment.feedback_saved | appointment | appointment | feedback_saved | success | Not supplied |
| vital.appointment.follow_up_requested | appointment | appointment | follow_up_requested | attempted | Not supplied |
| vital.appointment.follow_up_scheduled | appointment | appointment | follow_up_scheduled | success | Not supplied |
| vital.appointment.recovery_requested | appointment | appointment | recovery_requested | attempted | Not supplied |
| vital.appointment.rejected | appointment | appointment | rejected | rejected | Not supplied |
| vital.appointment.requested | appointment | appointment | requested | attempted | Not supplied |
| vital.appointment.rescheduled | appointment | appointment | rescheduled | success | Not supplied |
| vital.appointment.schedule_created | appointment | appointment | schedule_created | success | Not supplied |
| vital.appointment.schedule_deleted | appointment | appointment | schedule_deleted | success | Not supplied |
| vital.appointment.schedule_updated | appointment | appointment | schedule_updated | success | schedule |
| vital.appointment.scheduled | appointment | appointment | scheduled | success | Not supplied |
| vital.audit.export_completed | audit | audit_history | export_completed | success | Not supplied |
| vital.audit.export_failed | audit | audit_history | export_failed | failed | Not supplied |
| vital.audit.export_requested | audit | audit_history | export_requested | attempted | Not supplied |
| vital.audit.viewed | audit | audit_history | viewed | success | Not supplied |
| vital.doctor.onboarded | profile | profile | onboarded | success | Not supplied |
| vital.doctor.provisioned | profile | profile | provisioned | success | Not supplied |
| vital.doctor.specialty_updated | profile | profile | specialty_updated | success | specialty |
| vital.document.accessed | document | document | accessed | success | Not supplied |
| vital.document.created | document | document | created | success | Not supplied |
| vital.document.deleted | document | document | deleted | success | Not supplied |
| vital.document.updated | document | document | updated | success | Not supplied |
| vital.message.access_denied | message | message | access_denied | denied | Not supplied |
| vital.message.accessed | message | message | accessed | success | Not supplied |
| vital.message.created | message | message | created | success | Not supplied |
| vital.message.hold_placed | message | message | hold_placed | success | Not supplied |
| vital.message.hold_released | message | message | hold_released | success | Not supplied |
| vital.message.purged | message | message | purged | success | Not supplied |
| vital.message.read | message | message | read | success | Not supplied |
| vital.message.sent | message | message | sent | success | Not supplied |
| vital.messaging.changed | messaging | message | changed | success | Not supplied |
| vital.patient.onboarded | profile | profile | onboarded | success | Not supplied |
| vital.payment.changed | payment | payment | changed | success | Not supplied |
| vital.payment.checkout_prepared | payment | payment | checkout_prepared | attempted | Not supplied |
| vital.payment.completed | payment | payment | completed | success | Not supplied |
| vital.payment.confirmed | payment | payment | confirmed | success | Not supplied |
| vital.payment.failed | payment | payment | failed | failed | Not supplied |
| vital.payment.invoice_created | payment | payment | invoice_created | success | Not supplied |
| vital.payment.paid | payment | payment | paid | success | Not supplied |
| vital.payment.receipt_linked | payment | payment | receipt_linked | success | Not supplied |
| vital.payment.refund_completed | payment | payment | refund_completed | success | Not supplied |
| vital.payment.refund_failed | payment | payment | refund_failed | failed | Not supplied |
| vital.payment.refund_requested | payment | payment | refund_requested | attempted | Not supplied |
| vital.payment.requested | payment | payment | requested | attempted | Not supplied |
| vital.payment.review_requested | payment | payment | review_requested | attempted | Not supplied |
| vital.payment.status_changed | payment | payment | status_changed | success | status |
| vital.payment.succeeded | payment | payment | succeeded | success | Not supplied |
| vital.profile.changed | profile | profile | changed | success | Not supplied |
| vital.profile.created | profile | profile | created | success | Not supplied |
| vital.profile.materialized | profile | profile | materialized | success | Not supplied |
| vital.profile.role_changed | profile | profile | role_changed | success | Not supplied |
| vital.profile.signature_saved | profile | profile | signature_saved | success | signature |
| vital.profile.updated | profile | profile | updated | success | Not supplied |
| vital.records.document_accessed | records | document | document_accessed | success | Not supplied |
| vital.records.document_issued | records | document | document_issued | success | Not supplied |
| vital.records.file_link_issued | records | document | file_link_issued | success | Not supplied |
| vital.records.file_uploaded | records | document | file_uploaded | success | Not supplied |
| vital.records.prescription_qr_retrieved | records | document | prescription_qr_retrieved | success | Not supplied |
| vital.records.snapshot_captured | records | document | snapshot_captured | success | Not supplied |
| vital.security.access_denied | audit | appointment | access_denied | denied | Not supplied |
| vital.security.code_incorrect | audit | appointment | code_incorrect | failed | Not supplied |
| vital.security.code_locked | audit | appointment | code_locked | failed | Not supplied |
| vital.security.throttled | audit | appointment | throttled | denied | Not supplied |
| vital.video.association_finalized | video | video | association_finalized | success | Not supplied |
| vital.video.association_transferred | video | video | association_transferred | success | Not supplied |
| vital.video.changed | video | video | changed | success | Not supplied |
| vital.video.connected | video | video | connected | success | Not supplied |
| vital.video.created | video | video | created | success | Not supplied |
| vital.video.disconnected | video | video | disconnected | success | Not supplied |
| vital.video.failed | video | video | failed | failed | Not supplied |
| vital.video.generation_expired | video | video | generation_expired | success | Not supplied |
| vital.video.generation_failed | video | video | generation_failed | failed | Not supplied |
| vital.video.generation_ready | video | video | generation_ready | success | Not supplied |
| vital.video.generation_started | video | video | generation_started | attempted | Not supplied |
| vital.video.generation_uncertain | video | video | generation_uncertain | attempted | Not supplied |
