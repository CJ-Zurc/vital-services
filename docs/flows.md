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


See [portal consistency v2](portal-consistency-v2.md) for anonymous patient ratings and the screenshot-aligned portal changes.

See [face-to-face booking](f2f-booking.md) for booking-only acceptance, doctor outcomes, acknowledgment routes and paired rollout.


Manual Google Meet links replace the retired connection/generation feature. See [manual meeting workflow](manual-meet-links.md).


See [dashboard and doctor discovery redesign](dashboard-redesign.md) for chart scopes, monthly highlights, privacy and paired reporting contracts.

## Native TRACE disputes

See [the implemented contract and rollout ledger](integrations/trace/patient-feedback/VITAL_TRACE_Implementation_Changes_and_Verification.md). All native cross-system delivery uses Gateway; callbacks enter after JSON parsing and the existing Web mTLS/signed assertion boundary. `VITAL_TRACE_DISPUTES_ENABLED` defaults off. Complete resumes original payment/clinical checks; refund issuance is separate.


See [doctor profiles, criterion ratings and directory pagination](doctor-profiles-ratings-pagination.md) for updated forms, rating eligibility, the trusted search projection, worker configuration and paired rollout.
