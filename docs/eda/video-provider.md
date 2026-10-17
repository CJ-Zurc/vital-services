# Google Meet Provider Boundary

The Video adapter pins Google's OAuth token, verified userinfo, revoke and Meet
v2 space endpoints. It uses separate doctor Meet consent and
`meetings.space.created`, not UHSE_AUTH login tokens. Creation requests use
restricted spaces; manual links receive syntax validation only.

Transport has a twelve-second whole-response deadline and 64-KiB streaming
response limit. Redirects and unsafe known-resource paths are denied. Error
bodies are not returned or logged. No automatic network retries exist. Creation
and OAuth exchange persist execution-start before transport; lost/ambiguous
outcomes cannot authorize another creation/code exchange. Only a known resource
name can be retrieved, under current doctor authority and connection fencing.

AES-256-GCM credentials bind key version and doctor identity as authenticated
data. The bounded keyring supports previous decrypt keys and a single active
encrypt key. Runtime reads credentials/keys from backend-only mounted secret
files. OAuth storage encrypts PKCE/state/binding/revision and contains no VITAL
session token. Rotation/revocation and real consent remain activation gates.

Backend quota is two started creation attempts per doctor/appointment-purpose
lineage. Failed or uncertain starts count. Identical commands, preflight failures
and throttle rejections do not consume another start. Reservation and quota
transactions use shared advisory/row locks. Five/doctor and fifty/application
per minute are enforced across replicas. Reconnect/reschedule do not reset quota.

`test/eda-video-provider.test.ts` exercises the real adapter through injected
fetch responses, including bounded streams, deadlines, receipt validation,
encryption/rotation and Web-compatible link rules. These are fixtures, not live
Google acceptance. No provider action is performed by checkpoint verification.

References: [Meet spaces creation](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces/create),
[Meet spaces retrieval](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces/get).
