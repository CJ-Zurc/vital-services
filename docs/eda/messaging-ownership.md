# Messaging Code Checkpoint

This manifest is published before extraction. All target flags default to false;
it does not authorize shared staging activation. The revised EDA plan remains
the architecture authority. SSE extraction is a subsequent checkpoint.

| Browser contract | Private contract | Authority / scope | Response |
| --- | --- | --- | --- |
| GET /api/messages/conversations | GET /internal/v1/messaging/conversations | Current patient/doctor; messaging.conversations bound to Auth UUID | Existing 50-item cursor page; trusted Auth name composition in BFF |
| GET /api/appointments/{id}/messages | GET /internal/v1/messaging/appointments/{id}/messages | Assigned participant; messaging.history bound to appointment | Existing 30-item history and eligibility fields |
| POST /api/appointments/{id}/messages | POST /internal/v1/messaging/appointments/{id}/messages | Assigned participant; messaging.send bound to appointment | 201 creation, 200 identical retry; content/clientMessageId only |
| PATCH /api/appointments/{id}/messages/read | PATCH /internal/v1/messaging/appointments/{id}/messages/read | Assigned participant; messaging.read bound to appointment | Existing success envelope; monotonic message-bound receipt |
| GET /api/admin/messaging/conversations | GET /internal/v1/messaging/admin/conversations | Current Core admin; messaging.admin.list bound to Auth UUID | Metadata-only 50-item cursor page |
| POST/DELETE /api/admin/messaging/conversations/{id}/hold | POST/DELETE /internal/v1/messaging/admin/conversations/{id}/hold | Current Core admin; messaging.hold.place/release bound to conversation | Versioned hold metadata; expectedVersion and stable command ID |
| GET /api/appointments/{id}/messages/stream | Deferred | Target mode unavailable; legacy mode unchanged | 503 until SSE owner exists; target UI uses authorized polling |

Private success responses carry contractVersion: 1. The BFF preserves browser
envelopes, session refresh headers/cookies, same-origin mutation checks and
private/no-store caching. Unknown or foreign appointments both return 404;
unauthorized roles return 403, malformed inputs 400, conflicting retries or
read-only sends 409, throttles 429 with Retry-After, unavailable owners 503.
Mutations bind action/path/body to mTLS actor assertions and operation IDs.

History reads never create conversations. Client message IDs deduplicate within
sender/conversation; command results retain message references, never bodies.
Encryption preserves versioned AES-256-GCM appointment/message AAD.
Envelopes require canonical base64, a 12-byte nonce and a full 16-byte tag;
truncated authentication tags and oversized ciphertext fail closed.
Appointment owns chain/lifecycle truth; Messaging uses its in-process transaction interface.
Sends take the shared doctor calendar lock before appointment/conversation locks.
Unfinished association transfers prevent new sends, not authorized history.

Messages/read receipts commit content-free messaging.changed facts, central
audit intents and PostgreSQL change signals with their Core mutation. The
messaging-appointment consumer verifies committed source facts and fences
reordered invalidations. RabbitMQ contains identifiers/versions only. A bounded
messaging-state consumer verifies committed Messaging facts and emits only
content-free recovery signals. Duplicate invalidations are harmless because
clients recover through authorized persisted history. No synthetic participant
or stream implementation is installed.

The admin page exposes identifiers, lifecycle/time metadata and hold state only;
it does not expose transcripts, clinical payloads or new access privileges.
Retention stays dry-run unless activation and recorded policy approval are both
configured. Ten years preserves existing policy, not a legal-compliance claim.
Live PostgreSQL/broker/mTLS, ingress/SSE, resource and rollback acceptance remain
pending and must not be inferred from fixture tests.
