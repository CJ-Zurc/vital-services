# Video / Google Meet Ownership Checkpoint

Status: implemented code checkpoint; disabled by default. Authority is the revised
EDA plan and the approved Video extraction. UI files and UHSE_AUTH Google sign-in
are outside the edit scope. No provider actions, deployment or migration execution.

## Browser Manifest (Published Before Extraction)

| Method / browser path | Authority | Contract / dependencies |
| --- | --- | --- |
| GET `/api/doctor/google-meet` | Current doctor session | Existing enabled/status/email; Core doctor and Video connection |
| DELETE `/api/doctor/google-meet` | Doctor, same origin | Existing revoked/message; clear binding cookie, disconnect locally first |
| POST `/api/doctor/google-meet/start` | Doctor, same origin | Existing authorizationUrl and HTTP-only binding cookie; allowlisted returnTo |
| GET `/api/doctor/google-meet/callback` | Fresh doctor session plus binding/state | Existing 303 redirect and cookie cleanup; current Auth session required |
| POST `/api/doctor/google-meet/generate` | Doctor, same origin | Existing requestId/appointmentId/purpose and generationId/status/meetingUrl/expiresAt; 202 + Retry-After while creating |
| Existing approval/follow-up paths | Assigned doctor | Existing meetingProvider and exactly one meetingUrl/meetingGenerationId for virtual appointments |

Google login `/api/auth/google/url` and SSO callbacks remain unchanged. Web is a
thin adapter; no target-mode provider calls or Meet persistence run there. Legacy
flag-off handlers remain. No counters, button guards or new UI feedback.

## Internal Manifest

All paths require process mTLS, verified short-lived actor assertions and exact
scope/resource binding. Mutations additionally require command IDs and hashes.
Replies are `{success:true,contractVersion:1,data}`; errors are content-free codes.

| Method / `/internal/v1/video` suffix | Scope | Resource |
| --- | --- | --- |
| GET `/connection` | `video.connection.read` | Actor Auth UUID |
| DELETE `/connection` | `video.disconnect` | Actor Auth UUID |
| POST `/oauth/start` | `video.oauth.start` | Actor Auth UUID |
| POST `/oauth/callback` | `video.oauth.callback` | Actor Auth UUID |
| POST `/generations` | `video.generate` | Appointment UUID supplied in the bound body |
| GET `/generations/{id}` | `video.generation.read` | Generation UUID |
| GET `/resources/appointments/{id}` | `video.resource.read` | Appointment UUID; current assigned patient/doctor |

OAuth start accepts returnTo; callback accepts state, binding and code/error only.
Generation accepts requestId, appointmentId and approval/follow_up purpose only.
Use the browser's existing requestId as the generation command ID. OAuth/disconnect
adapters may mint server command IDs because their existing UI has no such field;
callback IDs are deterministically bound to state. Provider credentials, callback
codes, authorization URLs and meeting links are never command-journal results.

## Ownership And Coordination

Core owns appointment identity, timing, workflow state, versions and minimal
Video intents/receipts. Integrations owns connections, encrypted Google tokens,
OAuth state/PKCE secrets, generations, quota, resources and participant holds.
Only scalar cross-database references; migrations are additive.

Core workflow prepare binds a normalized selection hash and commits before Video
reserves it. Video independently reads the Core preparation intent, validates
ownership/versions and prepares the manual/generated resource outside the Core
transaction. EHR external-start requires verified Video preparation. Core approval
commits with a durable finalization intent; Video finalizes idempotently afterward.
Incomplete finalization never becomes browser success or starts another checkout.
Workers recover committed intents, never impersonate a user for new clinical work.

Reschedule uses the existing prepare/abort/finalize participant contract and Core
saga authority. Transfer active association only, retain provider-origin identity,
meeting URL and historical consultation evidence. No provider creation on transfer.
Before a pivot, only a durable compensation/abandonment intent releases a hold.
After a pivot, recover forward; wall-clock expiry alone cannot release ownership.
In-person appointments have a verified no-meeting requirement, not a fake owner.

## Reliability And Security

Two provider starts per doctor/stable source appointment-purpose lineage; failed
and uncertain starts count. Replays, pre-provider validation and throttling do not.
Follow-up generation uses the completed source/purpose quota context; the created
follow-up owns a separate resource/billing lineage. Reschedules and reconnection
never reset quota. Preserve 5/doctor/minute and 50/application/minute atomically.

Persist execution-start before provider creation/exchange. No automatic retries
of unknown creation or code exchange. Known-space recovery is read-only; a missing
identifier proves nothing. Automatic generation stays unavailable without its
configuration, while validated manual fallback remains available through Video.
OAuth callback retains state/PKCE, binding, exact redirects, current actor and
connection-revision fencing. Encrypt only Google credentials and necessary OAuth
secrets; never persist the unused VITAL access token. Disconnect clears local
credentials regardless of best-effort provider revocation outcome.

RabbitMQ carries identifiers/versions/association state only. One audit-intent
path per transition; no URLs, raw Google bodies, clinical data or secrets. UI and
login flows are unchanged. Required runtime dependencies fail closed; never fall
back to Web persistence in target mode. Existing unrelated composed views stay gated.

## Verification Boundary

Focused provider/crypto, module, quota, approval/association, worker and Web BFF
fixtures plus full regression/build/typecheck checks are required. Live Google,
PostgreSQL/RabbitMQ/mTLS, callback ingress, Node 22, capacity and key rotation
remain NOT EXECUTED acceptance gates until explicitly authorized. Register tests
in the root catalog; preserve earlier histories, user changes and existing ports.

The isolated harness accepts a separate `EDA_TEST_VIDEO_ENABLED=true` opt-in,
only with the existing isolated database/broker/mTLS configuration. Three real
boundary scenarios are implemented and NOT EXECUTED. Provider transport remains
a fixture even in those scenarios; real Google consent/generation is separate.
Gateway already forwards these exact routes, cookies and Retry-After; no Gateway
Video business logic or new transport change was required in this phase.
