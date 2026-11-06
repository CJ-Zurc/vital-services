# Portal consistency v2

Patient code controls use two labeled icon buttons with separate confirmation dialogs. Cancel does not call reissue/withdraw. Existing generation, eligibility and access limits remain enforced. Payment text uses a dark foreground on a neutral panel. Health Records retains Allergies, BMI, Conditions and Files; other clinical records remain stored with their owner and issued documents remain in the dedicated page.

Doctor calendars share the patient three-column structure. Only the calendar header Add Slot opens batch creation; individual existing slots remain editable. Doctor appointment details show summary, complaint, record access, payment, actions, status history and structured assessment in the patient-style full-page order. Pending request preview is removed; Accept opens the dedicated report. Notification entry points use the same report. Admin Patient Monitoring redirects to User Management with the patient filter.

GET /api/patient/doctors/:doctorId/ratings delegates to GET /internal/v1/appointments/doctors/:doctorId/ratings using patient-only appointments.discovery.read bound to that doctor UUID. limit is 1–50 (default 10); cursor is opaque and snapshot-bound. Response data contains doctorId, average, count, anonymous items with rating/submittedAt and pagination metadata. It contains no patient/appointment identities or clinical information. Ratings include completed consultations only. Submission uses the existing appointment feedback endpoint: once per completed paid consultation, checked server-side. No written reviews or database migration were added.

View Ratings opens a modal that lists stars and dates and lets the requesting patient choose an eligible completed consultation. Posting refreshes ratings, eligibility and the profile aggregate. Failed reads remain distinguishable from an empty ratings list. Booking consent uses a short checkbox label and a separate Privacy Policy button; opening the modal does not alter consent. The policy explains pre-acceptance intake review, code-controlled records, withdrawal and deadlines without changing their rules.

No deployment, provider activation, data reset, commit or push is part of this change.

## Verification scope

Paired production builds and TypeScript checks passed. Web regressions passed 329 tests; Services passed 506 with four conditional integration tests skipped. Final focused ratings/feedback/route contracts passed, and the current route inventory contains 163 reviewed routes. Desktop/mobile component browser checks used mocked APIs; they do not establish live signed-transport, payment, clinical-owner, or database integration parity. No live account or database reset was used. The batch verification report and screenshots are in the workspace `outputs/portal-v2-validation.md`.
