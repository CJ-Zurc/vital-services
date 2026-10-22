# S6-011–S6-014 appointment revisions

Core owns appointment ratings, complaints, calendar blocks and reschedule quotas. Web is a session-authorized BFF; Auth owns names and Central Notification owns inbox persistence/templates. These are capstone development/testing workflows. Thirty minutes is the agreed custom-booking default, not a confirmed BGH policy.

## Ratings and booking

Patient feedback POST accepts only `expectedVersion` and integer `rating` 1–5. A completed owned appointment, current verified payment and no unresolved financial review/transfer are required. Existing appointment uniqueness, row/calendar locks and command journals preserve the first submission and stable retries. Comments remain historical database data and are excluded from new writes and every rating response. Discovery returns average/count only, calculated from completed appointments and valid ratings. The owning patient receives `rating` and `canRate`; `GET /internal/v1/appointments/admin/doctors/:authId/ratings?page=1&pageSize=10` requires current Core admin membership and returns a bounded page for Web identity enrichment.

New custom bookings compute start +30 minutes, including next-day rollover, and reject a supplied different end. Published schedules retain their original interval. Booking complaint text is optional, trimmed empty to null, maximum 2,000 characters; OPQRST, consent, identity and emergency-contact requirements remain enforced.

## Complaint correction

`GET /internal/v1/appointments/:id/chief-complaint?offset=0` permits only the owning patient or assigned doctor and pages 20 history entries. `POST` to the same path requires the assigned doctor, a signed command, expected appointment version and nonempty complaint <=2,000 characters. Eligible states are pending/approved/confirmed, before the existing paperwork deadline/lock and doctor confirmation. Active approval/video/saga work prevents corrections. The update increments the appointment version, retains previous/current text plus doctor/time in `chief_complaint_history`, and journals/publishes references only. OPQRST, EHR complaints, issued documents and existing immutable snapshots are unchanged. Approval refuses an empty complaint before creating an EHR case.

## Calendar review and atomic batches

`GET /internal/v1/date-blocks/preview?selection=<JSON>` and `POST /internal/v1/date-blocks/batch` are doctor-only. Selection is Range (inclusive, <=366 calendar days), Custom (<=100 dates, normalized unique/sorted) or existing Weekly. Preview returns selected/already-blocked dates, existing appointment count, reservation status and a calendar fingerprint. Batch accepts the same selection/fingerprint under the doctor calendar lock and a stable command UUID. Changed appointments, blocks or holds require another review; active holds prevent saving. The whole batch commits or rolls back. Existing appointments remain scheduled. Range/individual/weekly rules use `doctor_date_blocks`; existing availability checks reject new bookings/reschedules across every touched Manila date, including overnight intervals.

## Reschedule quotas and notifications

Future successful replacements enforce patient one, doctor three, combined four across the replacement chain. Historical counters are retained, proposal and acceptance/pivot recheck the limits, and only the durable successful pivot increments the recorded initiator. Rejections, cancellations and compensation consume nothing. New follow-up consultations start their own counts. Appointment logs now retain initiating/accepting actor and original/replacement schedule metadata.

Proposed, declined and completed reschedules publish metadata-only `vital.notification.requested` intents with deterministic event/request IDs. Successful-reschedule intent is in the same Core transaction that marks saga finalization complete. Worker delivery retries independently and cannot reverse the committed appointment. Templates are `appointment.reschedule_proposed`, `appointment.reschedule_declined` and `appointment.rescheduled`.

Central contracts through Gateway are `GET /notifications/vital/inbox?limit=20&offset=0` and `PATCH /notifications/vital/:uuid/read`. Both require trusted Gateway identity and receipt-backed VITAL recipient scoping. Unread counts include VITAL only; repeated reads preserve the original read timestamp. Web exposes `/api/notifications` and `/api/notifications/:uuid/read`, removes recipient IDs and constructs role-owned appointment links. Dashboard notification composition reuses this reader while retaining its existing response shape. No email, SMS or browser push is added.

## Migration and verification

Core migration `202610210001_s6_appointment_revisions` adds complaint history, actor/reschedule log metadata and a new-write rating range check. Historical feedback is retained. No EHR/Integrations schema change or new environment variable is needed. The existing separate tools image and deployment lock/migration/readiness sequence apply this migration before schema-dependent API/worker/Web startup; a failed migration stops deployment. Rebuilds never reset databases.

Maintained source tests are registered in the workspace catalog. Full-stack Auth/Gateway/Core/broker/payment/video/Records acceptance and genuine multi-connection PostgreSQL concurrency remain live gates when Docker is unavailable. Temporary in-memory PostgreSQL tests verify actual Prisma fresh/upgrade/repeat migrations and SQL; they do not certify the deployed stack.


## Local workflow boundary

The browser-facing complaint, rating, calendar and bell APIs are same-origin
VITAL Web handlers. Their signed private Services calls bypass Gateway; Gateway
is retained for the distinct Auth, EHR and central Notification service calls.
Gateway does not need new VITAL BFF entries for these local routes. Existing
ownership, role, concurrency and financial/clinical rules remain authoritative.
