# Payment Reconciliation

The supported runtime is the default ecosystem EDA API and worker. Business
ownership lives under `src/eda/modules/payment/`; the Core and Integrations
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

Staging payment/provider and reconciliation flags remain disabled. Payment-dependent
behavior is verified only in an isolated harness; no simulated live feature is exposed.

## PayMongo sandbox webhook

VITAL Web relays POST /api/webhooks/paymongo over signed mTLS to the
Services payment owner. Set VITAL_PAYMONGO_WEBHOOK_ENABLED on Web and API
only after registration and mount the endpoint secret in the API's existing
read-only config directory. Set VITAL_PAYMONGO_WEBHOOK_SECRET_FILE to that
file. Services verifies the original body and the test-mode signature before
recording a checkout event and scheduling the existing worker reconciliation.
The worker verifies the provider checkout before committing financial state.
