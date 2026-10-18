# Remaining Owners

The supported runtime is the default ecosystem EDA API and worker. Business
ownership lives under `src/eda/modules/profile/`; the Core and Integrations
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
