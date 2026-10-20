# VITAL integration contracts

- Browser business/auth calls enter Web BFF or Gateway. User session/RBAC checks
  use Gateway; active UHSE integration routes remain `/vital/integrations/v1/*`
  and reviewed `/vital/bff/*` routes. Unknown generic paths are rejected.
- Web/API transport uses mTLS and signed assertions bound to actor, method, path,
  request hash, resource and correlation ID. Plain `X-User-*` headers do not grant
  API access.
- Auth owns identities, login/refresh/OTP and system access. Backend profile and
  stale-control requests call protected Auth internal contracts directly with
  distinct directional keys. No VITAL process connects to Auth's database.
- EHR owns hospital patient IDs/MRNs, clinical persistence, signed Records
  evidence and doctor mirrors. TRACE owns department UUIDs and names.
- Baseline seed commands exchange a credential-free manifest containing resolved
  owner IDs. EHR patient IDs, Auth IDs and VITAL user IDs are not interchangeable.
- API mutations write Core outbox events. Worker delivery uses durable RabbitMQ,
  inbox protection and receipt-aware Audit/Notification clients. Notification
  email/SMS providers remain disabled in staging.
- Auth-facing VITAL roles are served by Web delegating to Core ownership.
  Analytics reads only the authenticated submitted-preconsultation export.
- Gateway diagnostics calls Web's protected `/api/internal/vital/readiness`;
  Web checks API `/internal/readiness` over mTLS without impersonating a user.

## Capstone document contract release

Doctor honorific has been removed from Profile, appointment and portal doctor DTOs. Deploy the paired Web schema after Core/Integrations migrations. New self-scoped signature and patient/admin acknowledgment routes, snapshot versions and QR retrieval are detailed in [Capstone documents](capstone-documents.md). EHR evidence endpoints are unchanged; no EHR-owned tables are modified.
