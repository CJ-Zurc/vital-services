# VITAL–TRACE native dispute agreement

Updated 22 November 2026. Status: implemented source revision; coordinated deployment acceptance pending. Authoritative routes, payloads, checks and rollout dependencies are in [changes and verification](VITAL_TRACE_Implementation_Changes_and_Verification.md). See the [execution plan](VITAL_TRACE_In_System_Dispute_Execution_Plan.md) and [historical Google Forms ledger](../trace-integration-changes.md).

## Scope and responsibilities

Telemedicine appointment disputes originate inside VITAL and pass through BGH API Gateway in both directions. General ratings/suggestions retain their separate flow. Google Forms and form sync are retired for native disputes. Services owns appointment eligibility, trusted identity, holds, durable delivery and valid outcomes; Web owns the patient BFF/UI; TRACE owns Admin approval, investigation, resolution and its ticket; Gateway owns verified cross-system service transport. Accounting issues approved refunds externally.

## Agreed patient workflow

1. Eligible appointment details show a red **Report an issue** action with an exclamation icon and explanatory text. The modal gathers subject, description, a plain-language concern and up to five optional report-specific files. Opening/cancelling has no appointment effect.
2. After patient confirmation, VITAL atomically verifies ownership, telemedicine/current-state eligibility, records the report, original completion deadline, hold and delivery intent. Display **Dispute Sent** on local durable success. Gateway/TRACE outages retry in the background with the same report ID.
3. Any TRACE Admin may approve or reject a review-ready report. Record that Admin and time. Approval creates one ticket and assigns the approving Admin initially. Rejection records its reason/action before ticket creation, restores original completion checks, and shows **Your dispute was rejected** with the reason, configured BGH phone/address and Close. Contact values remain pending. No VITAL resubmission follows rejection.
4. Investigation and staff/Accounting routing comprise **Dispute in Process**. Ordinary staff completion cannot finalize the patient proposal. TRACE Admin must review and tag **Reschedule**, **Invalidate** or **Complete**, with an explanation and fresh decision identity.
5. **Completed** means that proposal is available in VITAL. VITAL records availability and the 72-hour response deadline; TRACE stores that receipt before automatic-resolution eligibility.
6. The original patient acknowledges or selects **Issue Not Resolved** with a reason. VITAL durably records a pending response; TRACE verifies original Auth creator, appointment/case/decision and trusted acceptance time. Only confirmed acceptance becomes **Acknowledged**.
7. Rejection records the patient's reason on the ticket timeline, clears completion/proposal/deadline, reopens the ticket and returns Stage 3 while retaining the appointment hold. Renewed Admin review and a fresh decision are required for Stage 4 and a new countdown.
8. After 72 hours without a timely response, TRACE obtains VITAL's locked timeout confirmation before atomically resolving and queuing its event. Display **Automatically Resolved** separately from actual patient acknowledgment. Missing confirmation preserves the unresolved case.

## Data and identity

The patient submits `subject`, `description`, `complaint_type` and optional new report evidence. TRACE Admin chooses official category/subcategory UUIDs, priority and routing. Patient concerns are not fault findings. VITAL derives `report_id`, appointment/patient/doctor IDs, Auth `reporter_auth_id`, UTC submission time and correlation metadata. A VITAL patient record ID is not an Auth account ID. The native schema uses report ID for retries; the old appeal reference is compatibility storage only. No TRACE staff account is required for the reporting patient.

## Appointment, privacy and refund rules

- Preserve the original 48-hour completion deadline through review. Rejection/dismissal or a confirmed Complete releases the hold to existing payment/clinical checks; elapsed review time is not added to the original deadline. An elapsed deadline runs those checks immediately.
- Doctor absence can be reported from scheduled start +15 minutes without prior doctor completion. Finalized appointments and rejected reports use the BGH contact process.
- Confirmed Reschedule grants one published-slot replacement outside ordinary patient quotas. The patient chooses and the doctor approves through the existing paid reschedule coordinator. Failed/declined attempts retain authorization; committed replacement consumes it. Keep the hold and create Admin follow-up when automatic resolution has no selected slot.
- Invalidation, refund approval and actual external issuance remain separate. Refund approval requires an explicit doctor-fault finding. Mutual absence remains no refund, with any doctor conduct concern handled separately. Payment records the external receipt idempotently without issuing another refund.
- Share explicit report evidence and necessary identifiers. Never automatically transmit EHR records or appointment uploads. Accounting receives the financial projection; narrative, comments and evidence remain restricted. Doctors receive no dispute-management access.
- Each correction references the active predecessor with a new decision ID. Stale events are ignored, duplicate events recover their result, and incompatible or irreversible transitions require VITAL Admin review.

## Activation

The exact source contract is documented in the linked handoff. Keep `VITAL_TRACE_DISPUTES_ENABLED=false` until all process configuration, additive migrations, TRACE Frontend changes and paired Gateway/mTLS acceptance are verified. This source revision is not a live deployment approval.
