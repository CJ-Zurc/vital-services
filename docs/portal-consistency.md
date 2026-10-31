# Portal consistency and clinical review

Doctor Accept opens `/doctor/dashboard/appointment-request/:appointmentId`. Reading the submitted complaint and structured intake does not accept a request. Confirm acceptance sends the displayed appointment version through the existing approval workflow. Changed versions must be reviewed again. Patient names are masked before consultation-code authorization; clinical language and messages no longer use an English word allowlist. Missing identity masking metadata continues to fail closed. Hospital record access remains code-controlled.

The shared patient/doctor appointment summary displays identity/reference, status, date, time and consultation mode. Schedule details omit the activity timeline. Reschedule allowances appear only when proposing a reschedule. Both account menus contain Profile and Settings; patient Settings uses the existing password API. Only the Messages floating launcher is shown. VITAL health-record loading does not initialize a camera; record owner authentication and authorization still apply. Keep EHR `FACE_RECOGNITION_ENABLED=false` for this deployment.

## Batch slot creation

Doctor-only POST `/api/doctor/schedule/preview` and `/api/doctor/schedule/batch` delegate to `/internal/v1/schedules/preview` and `/internal/v1/schedules/batch` with signed `appointments.schedule.write`, bound to the doctor's Auth ID. Both require a UUID Idempotency-Key and same-origin browser request. Body: `{selection, times:[{startTime,endTime}], consultationType, isPublished}`. Selection supports range, custom and weekly as before. Ranges span at most 366 days; custom selection allows 100 distinct dates; time rows are limited to 10 and expansion to 1,000 slots.

Preview returns `{slots, conflicts}`; batch returns `{slotIds, createdCount, conflicts}`. Conflicts contain date, start/end time and a safe code. A conflict creates zero slots. Retrying the same batch key returns its stored outcome; after resolving a conflict submit a new key. Server commit rechecks schedules, appointments and active reservations under the doctor calendar lock. Times use Asia/Manila and overnight ends. The entire selection and audit outbox writes commit together or roll back. Batch creation cannot expand the doctor's configured care modes.

Date-block routes return 410. Old blocks no longer restrict discovery or calendar writes. Existing individual slot editing/deletion remains available. No old block data migration or database reset is performed by this change.

## Admin dashboard and rollout

`/admin/dashboard` combines operational cards/charts and version-2 symptom analytics; `/admin/dashboard/analytics` redirects there. Operational failures do not hide symptom panels. The symptom route uses from/to dates, not the legacy limit query or current-batch endpoint. Aggregates below five remain suppressed.

Enable `VITAL_AI_ENABLED=true` and `VITAL_AI_ANALYTICS_ENABLED=true` in both Web and Services to activate symptom analytics. The existing private intelligence runtime, worker and model/key configuration described in intelligence/configuration documentation must be provisioned together. Patient assistant and staff sandbox flags remain independent. No feature is activated or deployment restarted by these source edits. Deploy paired Web/Services versions and retain appointment-code and encryption keys. BGH Analytics AIMS/EHR operations are unchanged.
