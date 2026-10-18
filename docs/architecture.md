# VITAL architecture

Browser routes terminate in Web/BFF. Gateway owns login, refresh/session claims,
system access and browser-facing integration routing. Web calls the modular API
over private mTLS with short-lived signed actor/request assertions. Browser code
never calls Docker service origins directly.

Core owns profiles, appointments, clinical document workflows, encrypted messages
and operational relationships. Integrations owns provider operations, durable
delivery/receipts and integration projections. Each uses separate runtime roles.
Transactions append outbox events; RabbitMQ and the shared worker deliver them
with inbox/idempotency protection. Privileged migration/provision/seed tools are
separate from runtime processes.

Auth owns identities/credentials. EHR owns hospital patients, MRNs and clinical
case persistence. TRACE owns department UUIDs. VITAL links owner-issued IDs and
never opens another owner's database. Audit and Notification accept their scoped
delivery contracts. Analytics reads only the documented operational exports.

Object storage has separate Records/profile principals. Files are scanned and
encrypted as required; browser links use the public Gateway media route. API,
worker and Web have process-specific configuration and bounded resource limits.
