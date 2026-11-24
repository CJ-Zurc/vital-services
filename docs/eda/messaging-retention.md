# Messaging Retention

The supported runtime is the default ecosystem EDA API and worker. Business
ownership lives under `src/eda/modules/messaging/`; the Core and Integrations
schemas and migrations declare persistence ownership. Web adapters retain browser
DTO/session behavior while domain decisions and writes execute in the API.

Mutations validate actor/resource authority and operation identity. Transactions
write the outbox; worker effects use idempotent delivery and owner receipts.
External outcomes must be verified before retrying a mutation. No cross-owner
database access or synthetic acknowledgement is permitted.

See [architecture](../architecture.md), [integration](../integration_guide.md),
[configuration](../configuration.md) and [verification](../testing.md). Source
tests describe contract behavior; live workflow, replay, scanner, load and reset
acceptance must be recorded against the deployed image IDs.

Messages are encrypted under backend-owned keyrings. Retention scanning/deletion
remain disabled. Browser messaging streams use reviewed Gateway SSE forwarding.

## Admin hold search

The admin metadata list accepts an optional `participantAuthId`, `startDate`,
and `endDate`, alongside the existing exact IDs and hold state. Services filters
before cursor pagination. Appointment dates are inclusive Philippine calendar
dates; UTC timestamp boundaries are explicit and independent of database session
timezone. Inverted ranges and invalid dates are rejected.

Services returns participant Auth IDs only to the authorized Web peer. Web
enriches names through the existing protected Auth profile API, then removes
these Auth IDs from the browser response. No Auth database access or transcript
access is added. Deploy the paired Services and Web revisions together; older
Web decoders reject the new metadata fields, while older Services rejects the
new filters. If deployment is sequential, keep the existing message-holds
feature flag off during the transition. No migration or new environment
variable is required. Verify name lookup, midnight boundaries, pagination and
place/release actions in staging with both revisions.
