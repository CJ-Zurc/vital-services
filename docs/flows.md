# Runtime flows

Gateway session → Web adapter → mTLS API assertion verification → domain transaction.
The transaction writes its owned data and outbox event atomically. Worker delivery
uses RabbitMQ with inbox deduplication, operation receipts, retry and quarantine.
Unknown external outcomes require receipt lookup rather than repeated mutations.

Auth owns credentials; EHR owns clinical records; TRACE owns department UUIDs.
See [integration contracts](integration_guide.md) and [architecture](architecture.md).


Sprint 6 patient administration adds a separate read-only patient-monitoring
view and bounded admin summary route. Messaging now follows scheduled 24-hour
appointment/follow-up windows with retained read-only history. See
[integration contracts](integration_guide.md#s6-005-patient-monitoring-and-s6-009-messaging)
for routes, ownership, response fields and boundary behavior.


See [portal consistency and clinical review](portal-consistency.md) for appointment review, name masking, batch slots and the merged dashboard.
