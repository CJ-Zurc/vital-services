# VITAL feedback on the TRACE patient-feedback integration plan

VITAL team reply for TRACE review · 6 November 2026

We agree that TRACE should own the hospital staff workflow for telemedicine cases escalated for doctor-related concerns. VITAL owns the appointment, patient-facing status, and booking workflows. Accounting issues refunds outside the integration and informs VITAL once a refund has been issued.

Reviewed against the [TRACE dispute strategy](https://github.com/Oeubx/TRACE_Backend/blob/514555e/docs/integration/patient-feedback/patient-dispute-resolution-strategy.md) and [patient feedback QR guide](https://github.com/Oeubx/TRACE_Backend/blob/514555e/docs/integration/patient-feedback/trace-patient-qr-guide.md).

## Intake and routing

Once a response from the designated Google Form is flagged for TRACE, it becomes a TRACE case. TRACE owns ticket creation, HR investigation, staff routing, and returning the disposition to VITAL. VITAL Admin handles patient-only reports. The existing general feedback QR and VITAL’s appointment rating remain separate from the dispute workflow. Please confirm how the designated form is identified, since the public QR endpoint can return a historical or default form.

| Case | Proposed handling |
| --- | --- |
| Normal completion or no patient response | VITAL sends the patient a completion notice. The patient can acknowledge or appeal. VITAL auto-completes after the window if completion requirements are met and no review hold is active. |
| Completion appeal | The patient receives an acknowledgment and status updates. VITAL applies the review hold to the verified appointment. A doctor-related concern flagged from the form goes to TRACE. |
| Missing required doctor paperwork | VITAL flags the appointment for review after the deadline. Escalate the doctor-side issue to TRACE. Confirmed failure to provide required paperwork after a visit is eligible for refund review. |
| Patient does not pay | VITAL handles payment expiry and releases the held slot after accounting for any payment in progress. |
| Patient alone does not attend | The doctor reports to VITAL Admin. VITAL handles the private reschedule offer and any final no-show tag. No refund under the agreed policy. |
| Doctor alone does not attend | A flagged report goes to TRACE for HR review. Confirmed doctor absence is eligible for a full refund through Accounting. |
| Both parties do not attend | VITAL records mutual absence with no refund. If the doctor misses the required explanation deadline, TRACE handles that failure separately. The no-refund decision still applies. |
| Technical failure before or during the visit | VITAL handles an agreed reschedule or a patient-side issue. Send doctor-side concerns requiring HR review to TRACE. VITAL Admin investigates unknown fault or a platform outage before assigning responsibility. A missed connection or an absent session timestamp alone does not establish fault. |

## Appointment and refund outcomes

- **In Review** pauses auto-completion once VITAL accepts a review signal for a verified appointment. VITAL checks for an active hold when processing completion. A concern received after completion can still be reviewed as a post-completion report.
- **Invalid** records the appointment disposition. VITAL tracks the refund outcome separately so an invalid appointment can have a no-refund decision.
- **Refund issued** requires an explicit Accounting confirmation. Accounting processes the refund outside the integration, returns the ticket to the admin, and sends VITAL the case reference, issuance date, and a reconciliation reference. VITAL links the confirmation to the appointment and records it once even if the message is retried. A ticket return or closure alone does not confirm issuance.

## Staff access

| Role | Information available |
| --- | --- |
| Authorized VITAL Admin and assigned HR reviewers | Patient display name, concern, case reference, and relevant dispute evidence. |
| Accounting | Case reference, financial disposition, patient display name if needed, and the billing reference required to process or reconcile the refund. Complaint narrative and evidence stay restricted. |
| Patient | Submission receipt and patient-facing status updates through VITAL. |

Keep EHR records, prescriptions, and medical reports out of the dispute workflow. For documentation cases, share a status such as *required report missing*. Restrict evidence through backend permissions as well as the staff interface, including when the ticket moves from HR to Accounting.

## Agreed timing for VITAL

| Event | Timing |
| --- | --- |
| Check-in | Opens 10 minutes before the scheduled start. |
| No-show report | Available 15 minutes after the scheduled start. The timer enables reporting. Staff determine the outcome. |
| Interrupted consultation | Allow 10 minutes to reconnect before offering a report or reschedule. |
| Doctor paperwork or required explanation | Due 24 hours after the scheduled end. Flag overdue cases for review. |
| Patient acknowledgment or appeal | 48 hours from the doctor’s completion submission. Send notice immediately and a reminder with 24 hours remaining. |
| Private reschedule offer | Give the patient 24 hours from when VITAL sends the offer. Schedule the replacement slot after the response window. |
| Advance payment | Cutoff 3 hours before the scheduled start. |
| Complaint acknowledgment | Immediate receipt and a human acknowledgment target of one business day. |

## Items for TRACE and VITAL to confirm

1. **Form-to-ticket handoff.** Who flags the Google Form response, what starts ticket creation, and what identifier links the submission to a VITAL appointment? VITAL should verify the appointment relationship before applying a hold or changing status. Confirm how the patient gets a receipt while that verification is pending.
2. **Review signal and resolution.** Agree on when TRACE sends the review signal, the expected delivery time for appeals near auto-completion, and the outcomes TRACE sends back so VITAL can clear the hold, complete the appointment, or mark it invalid as appropriate.
3. **Service contract.** Agree on the scoped service identity, stable case ID, and retry handling. Test that duplicate submissions and retries create one TRACE ticket per accepted case and record each Accounting confirmation once.
4. **Accounting and evidence access.** Confirm the authorized Accounting action that returns the ticket and emits the refund-issued confirmation. Verify that Accounting cannot retrieve HR evidence through ticket views, attachment links, exports, or the API.
