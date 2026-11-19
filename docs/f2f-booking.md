# Face-to-face appointment booking

In-person appointments use VITAL for booking and visit outcomes. Acceptance
confirms the visit directly and stores an encrypted booking acknowledgment
snapshot. Checkout, payment verification, video preparation and EHR case
creation are bypassed. Virtual appointments retain their existing workflow.

The assigned doctor sees the patient's identity after acceptance. Submitted
intake remains readable. In-person appointments do not grant clinical-record,
consultation-code, prescription or certificate access.

Only the assigned doctor records Completed from the scheduled start or No-Show
after the scheduled end. Overnight intervals use Philippine time. Pending
reschedules block both actions. An unresolved visit remains Confirmed and shows
an overdue indicator. Completion does not require a patient acknowledgment or
a payment record. A completed visit permits one anonymous stars-only rating.

Cancellation and rescheduling retain their existing timing and quotas.
In-person reschedule acceptance commits locally under the calendar lock,
confirms the replacement and supersedes the original acknowledgment atomically.

## Booking acknowledgment API

GET /api/{patient|doctor}/appointments/{id}/booking-acknowledgment
returns metadata. GET on its /file child returns a private PDF. Each route checks
current membership and appointment ownership. Web delegates with signed
appointments.booking-acknowledgment.read authority to matching Appointment
owner routes, independently of payment flags.

The snapshot contains the patient and doctor names resolved through Auth,
reference, schedule, issue date and BGH 1 location. It excludes clinical and
payment content. Snapshot and cached PDF bytes are encrypted with the existing
appointment payload keys. Rendering happens on demand under a document lock
and caches the first successful PDF with a SHA-256 hash, so retrying a failed
render does not repeat acceptance. Prior snapshots survive rescheduling.
The current appointment status appears in the portal beside the document.

POST /internal/v1/appointments/{id}/approve-in-person is doctor-only and
accepts expectedVersion and confirmConflicts. POST /internal/v1/appointments/{id}/no-show
is doctor-only and accepts expectedVersion. Browser No-Show is PATCH
/api/doctor/appointments/{id}/no-show. Complete uses the existing completion route.
All writes use existing signed command IDs, version checks and calendar locks.

No-Show is persisted in appointment logs and published as vital.appointment.no_show.
Its audit uses the existing completion_acknowledged contract. Booking PDF reads
use the existing document.accessed audit contract. Completion notifications use
appointment_completed. To remain compatible with the existing central
Notification service, No-Show uses its appointment_expired notification template;
VITAL resolves the current authorized appointment status and presents No-Show
copy in the inbox. No-show conversations retain history with sending closed.

## Deployment and verification

Apply Core migration 202611180001_f2f_booking before starting the matching API
and worker. The migration adds the no_show enum value and the encrypted document
table. Grant runtime DML through the existing tools provisioning flow. Deploy
compatible Web and Services builds together. Auth profile lookup credentials,
appointment encryption keys, PDF fonts and BGH branding must be configured.

Development data may be reset by the deployment operator. This change does not
rewrite historical financial data or deploy/reset a database. UHSE EHR is outside
this change. Mocked regression and browser checks do not establish live Auth,
database migration or central-notification delivery acceptance.
