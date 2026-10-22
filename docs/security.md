# VITAL security boundaries

Gateway owns browser session verification, refresh and canonical claims. Web
validates its inbound Gateway credential before using trusted headers. Web sends
short-lived signed actor assertions over mTLS to the API. The API requires the
authorized Web peer, verifies signatures/request bindings and checks domain authority.
Readiness is a separate authenticated machine check, never a fabricated user.

Core and Integrations use separate databases and API/worker/migrator principals.
Only tools receive schema privileges. Worker delivery uses directional Auth, EHR,
Audit and Notification credentials. No service reads another owner's database.

Staging allows only explicitly named Docker-network HTTP infrastructure endpoints.
Public traffic and Web/API transport retain HTTPS. Records/profile storage has
scoped principals and file validation. The current capstone build deliberately
disables antivirus through its server-owned [inspection policy](capstone-file-validation.md),
retains file parsing/normalization, and never claims unscanned content is clean.
Secrets stay outside the checkout and
Web never receives database, broker, storage or provider credentials.

Payment/provider creation, email/SMS delivery and retention deletion require their
separate explicit controls. Source test results do not establish staging acceptance.
