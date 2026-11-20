# Manual Google Meet links

Doctors create meetings outside VITAL and paste a Google Meet link when accepting
virtual requests or creating virtual follow-ups. No Google Meet connection is
needed. Google sign-in remains Auth-owned and unchanged. Face-to-face bookings
have no meeting controls. Virtual payment and clinical-access rules remain in force.

Web and Services validate HTTPS, meet.google.com, meeting-code format, normalized
URLs and existing association conflicts. A pasted URL is syntax-validated; VITAL
does not contact Google to prove that the meeting exists or that the doctor owns it.
Version checks, command replay, private resource reads, reschedule transfers and
association recovery remain active. Existing saved generated URLs remain usable.
New payloads containing meetingGenerationId return 410 MEET_AUTOMATION_RETIRED.
Former Meet connection, OAuth and generation endpoints return the same retirement
response. Old callbacks expire the Meet binding cookie and never exchange codes.

## Runtime and rollout

Keep VITAL_EDA_ENABLED and VITAL_EDA_VIDEO_ENABLED enabled for virtual meeting
resources, plus VITAL_EDA_VIDEO_MAINTENANCE_ENABLED on the worker for association
recovery. Google provider flags, client ID, secret, callback URL, app origin and
Meet token keyring are no longer runtime requirements.

Deploy paired Web and Services builds together. Before applying Integrations
migration 202611200001_retire_meet_automation, block automation traffic and stop
old API/workers, including in-flight OAuth requests. The migration clears stored
connection credentials and OAuth secrets while retaining historical generation
rows and all saved meeting resources. Historical migrations must remain intact.
After rollout remove only VITAL Meet client-secret/keyring mounts and obsolete
VITAL_VIDEO_GOOGLE_*, VITAL_VIDEO_KEYRING_FILE and VITAL_VIDEO_APP_ORIGIN settings
from the owning deployment configuration. The root deployment owner must also
remove the retired Meet keyring requirement in scripts/vital-env-preflight.mjs,
retire Meet provisioning in configure-vital.py, and remove obsolete Meet flags
from the root example files and provider-flag policy. These deployment-owned
files are outside the paired Web/Services feature branches. Auth Google sign-in
settings remain.
The migration clears VITAL credentials; it does not revoke grants in Google or
delete existing meetings.

Committed workflows recover using persisted URLs and receipts without credentials.
Uncommitted generated holds cannot be approved: let preparations with no external
side effect expire, allow existing owner abandonment/recovery to release them,
then refresh and submit a manual link. Preparations with an unknown EHR outcome
retain their holds until the existing authoritative recovery/reconciliation
establishes an outcome; do not clear them with direct SQL. Keep recovery enabled
and inspect pending holds before declaring rollout complete.

Tests and mocked browser checks do not certify live PostgreSQL migration, EHR,
Auth or provider meeting usability. Apply migrations and deploy only when requested.

## Verification on 2026-11-20

Services builds and both repositories pass TypeScript. The paired route-contract
suite passes 7 tests. Focused Services video/authority/recovery and integration
configuration checks pass 25 tests with the live isolated infrastructure suite
skipped. The earlier Appointment lifecycle suite passes 42 tests. Web manual-link,
approval, follow-up, appointment and session regression checks pass 28 tests;
separate SSO/retirement checks pass 11. Signed Video transport checks also pass.
The Web webpack production build succeeds, while emitting an existing Next.js
security advisory that remains a separate dependency follow-up.

Mocked Edge journeys at 390px and 1440px verify invalid-link rejection, manual
approval, cancellation without a write, required input, absence of connection
controls, and no automation requests. These use real UI components with fixture
API responses and layout shells. They do not certify live appointments, EHR,
Google meeting usability, migration execution or deployed configuration.
The credential cleanup migration has not been applied and root deployment
configuration has not been changed. No commits, pushes or deployment were made.
