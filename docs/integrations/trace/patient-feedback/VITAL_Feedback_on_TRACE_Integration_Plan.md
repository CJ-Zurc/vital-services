# VITAL feedback on the TRACE patient-feedback integration plan

VITAL team reply for TRACE review · Updated 9 November 2026

We agree that TRACE should own the hospital staff workflow for telemedicine cases escalated for doctor-related concerns. VITAL owns the appointment, patient-facing status, and booking workflows. Accounting issues refunds outside the integration and informs VITAL once a refund has been issued.

Reviewed against the revised [TRACE dispute strategy](https://github.com/Oeubx/TRACE_Backend/blob/0158628/docs/integration/patient-feedback/patient-dispute-resolution-strategy.md) and [patient feedback QR guide](https://github.com/Oeubx/TRACE_Backend/blob/0158628/docs/integration/patient-feedback/trace-patient-qr-guide.md).

## Intake and routing

Once a response from the designated Google Form is flagged for TRACE, it becomes a TRACE case. TRACE owns ticket creation, HR investigation, staff routing, and returning the disposition to VITAL. VITAL Admin handles patient-only reports. The existing general feedback QR and VITAL’s appointment rating remain separate from the dispute workflow. Please confirm how the designated form is identified, since the public QR endpoint can return a historical or default form.

| Case | Proposed handling |
| --- | --- |
| Normal completion or no patient response | VITAL sends the patient a completion notice. The patient can acknowledge or appeal. VITAL auto-completes after the window if completion requirements are met and no review hold is active. |
| Completion appeal | The patient selects **Start appeal** on their signed-in VITAL appointment. VITAL verifies ownership and places the appointment on hold immediately. The patient then has 24 hours to submit the designated form. A doctor-related concern flagged from the form goes to TRACE. |
| Missing required doctor paperwork | VITAL flags the appointment for review after the deadline. Escalate the doctor-side issue to TRACE. Confirmed failure to provide required paperwork after a visit is eligible for refund review. |
| Patient does not pay | VITAL handles payment expiry and releases the held slot after accounting for any payment in progress. |
| Patient alone does not attend | The doctor reports to VITAL Admin. VITAL handles the private reschedule offer and any final no-show tag. No refund under the agreed policy. |
| Doctor alone does not attend | A flagged report goes to TRACE for HR review. Confirmed doctor absence is eligible for a full refund through Accounting. |
| Both parties do not attend | VITAL records mutual absence with no refund. If the doctor misses the required explanation deadline, TRACE handles that failure separately. The no-refund decision still applies. |
| Technical failure before or during the visit | VITAL handles an agreed reschedule or a patient-side issue. Send doctor-side concerns requiring HR review to TRACE. VITAL Admin investigates unknown fault or a platform outage before assigning responsibility. A missed connection or an absent session timestamp alone does not establish fault. |

## Appointment and refund outcomes

- **In Review** pauses auto-completion as soon as VITAL accepts **Start appeal** before the original 48-hour deadline. VITAL checks for an active hold when processing completion. A concern received after completion can still be reviewed as a post-completion report.
- **Form deadline** is 24 hours from the accepted appeal start. A timely form submission keeps the hold in place while the case is reviewed. Use Google's first submission timestamp so delivery delays do not count against the patient. Before releasing an abandoned hold, verify that no timely submission is pending. If none exists, resume the original completion deadline and run the normal completion checks if it has passed.
- **Invalid** records the appointment disposition. VITAL tracks the refund outcome separately so an invalid appointment can have a no-refund decision.
- **Refund issued** requires an explicit Accounting confirmation. Accounting processes the refund outside the integration, returns the ticket to the admin, and sends VITAL the case reference, issuance date, and a reconciliation reference. VITAL links the confirmation to the appointment and records it once even if the message is retried. A ticket return or closure alone does not confirm issuance.

VITAL automatically applies authenticated final TRACE dispositions for the active case. VITAL checks the case and appointment state and applies each decision once. Conflicting, stale, or unsupported decisions go to VITAL Admin for review. Generic ticket closure carries no appointment instruction.

| TRACE disposition | VITAL action |
| --- | --- |
| Appointment invalidated | Mark the appointment **Invalid** and clear the hold. Record any Accounting confirmation separately. |
| Appeal dismissed | Clear the hold and resume the original completion deadline. Run normal completion checks if the deadline has passed. |
| Reschedule agreed | Start VITAL’s rescheduling workflow. Validate the replacement slot and any required confirmations before changing the booking. |

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
| Appeal form submission | 24 hours from VITAL accepting **Start appeal**. |
| Private reschedule offer | Give the patient 24 hours from when VITAL sends the offer. Schedule the replacement slot after the response window. |
| Advance payment | Cutoff 3 hours before the scheduled start. |
| Complaint acknowledgment | Immediate receipt and a human acknowledgment target of one business day. |

## VITAL implementation checklist

1. **Web and patient status.** Add the signed-in **Start appeal** action, show the exact form deadline and a way to reopen the form, and surface the appeal receipt, status updates, and confirmed refund status.
2. **Appointment and case state.** Verify ownership and eligibility, then record the appeal and hold atomically so an accepted appeal cannot race auto-completion. Issue a short-lived, single-use reference tied to the patient and appointment. Prefill only that reference. Preserve the original completion deadline.
3. **Form reconciliation.** Accept an authenticated TRACE message with the appeal reference, designated form ID, response ID, and first submission timestamp. Deduplicate deliveries and resolve the appointment from VITAL’s own reference. Reconcile pending submissions before expiring a hold. If verification is unavailable, keep the hold pending reconciliation.
4. **Disposition and Accounting intake.** Validate the authenticated sender, active case link, current appointment state, and event identity before applying a final disposition. Handle Accounting’s refund-issued confirmation as a separate operation. Record audit history and deliver patient notifications through the existing notification flow.
5. **Lifecycle timing.** Implement the agreed timing table in VITAL. Keep patient-only reports, payment expiry, and private rescheduling in VITAL. Coordinate timer changes across the interactive and background completion paths.
6. **Verification.** Cover the appeal-versus-completion race, late delivery of a timely form response, abandoned appeals, duplicate or stale dispositions, unavailable replacement slots, and duplicate Accounting confirmation.

## VITAL proposals for TRACE to confirm

| Decision | VITAL proposal | Please confirm |
| --- | --- | --- |
| Form receipt and ticket routing | TRACE reads the designated Google Form and sends VITAL a verified submission receipt before staff triage. The receipt carries the appeal reference, form ID, response ID, and first submission timestamp. A designated TRACE intake reviewer then flags doctor-related concerns for ticket creation. TRACE owns the flagged case. Patient-only concerns go to VITAL Admin. | Which TRACE role flags responses, how receipts are delivered and retried, and how VITAL can verify that no timely response is pending before releasing an abandoned hold. |
| Final disposition | An authorized TRACE reviewer sends an explicit **Invalidate**, **Dismiss**, or **Reschedule agreed** disposition. VITAL applies valid final dispositions automatically. VITAL Admin reviews stale, conflicting, or unsupported decisions. | Which TRACE roles can finalize each outcome, which case and decision identifiers VITAL receives, and how TRACE submits a correction that references the earlier decision. |
| Accounting confirmation | Use a restricted **Confirm Refund Issued** action after Accounting pays externally. The action returns the ticket to the admin and sends VITAL the case ID, issuance date, and reconciliation reference. VITAL updates the refund record separately from the appointment. | The Accounting role, return-to-admin behavior, and confirmation delivery and retry contract. Verify evidence restrictions across ticket views, attachment links, exports, and APIs. |

Agree on scoped service identities and stable event identifiers for these handoffs. Retries should create one TRACE ticket per flagged case, apply each final disposition once, and record each refund confirmation once. TRACE should use an explicit schema migration or a dedicated case-link table with a uniqueness constraint for the stable case ID.

## Corrections requested in the TRACE draft

- Keep patient-only no-shows with VITAL Admin. Remove the automatic TRACE Clinic Scheduling assignment for that case.
- Treat a missing session-start timestamp as one signal for HR review. Use the available attendance and incident evidence before confirming doctor absence.
- Start the 24-hour private reschedule response window when VITAL sends the offer. Set the replacement slot after the window. Include the immediate receipt and one-business-day human acknowledgment target.
