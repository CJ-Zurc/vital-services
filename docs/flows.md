# Runtime flows

Gateway session → Web adapter → mTLS API assertion verification → domain transaction.
The transaction writes its owned data and outbox event atomically. Worker delivery
uses RabbitMQ with inbox deduplication, operation receipts, retry and quarantine.
Unknown external outcomes require receipt lookup rather than repeated mutations.

Auth owns credentials; EHR owns clinical records; TRACE owns department UUIDs.
See [integration contracts](integration_guide.md) and [architecture](architecture.md).
