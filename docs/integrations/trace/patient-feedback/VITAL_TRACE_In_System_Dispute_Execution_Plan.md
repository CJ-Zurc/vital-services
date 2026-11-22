# VITAL–TRACE native dispute execution plan and source map

Updated 22 November 2026. Implemented source revision; deployment remains disabled. See the [agreement](VITAL_Feedback_on_TRACE_Integration_Plan.md) and [contract, verification and rollout ledger](VITAL_TRACE_Implementation_Changes_and_Verification.md).

## Source responsibilities

| Owner | Main source locations |
|---|---|
| Services | `src/eda/modules/appointment/native-dispute.ts`, `dispute-delivery.ts`, `dispute-evidence.ts`, `dispute-reschedule.ts`; appointment/saga/maintenance owners; `src/eda/modules/payment/dispute-refund.ts`; signed `native-dispute-router.ts`. |
| Web | `lib/eda/dispute-bff.ts`, `lib/dispute-contract.ts`, actual `mode-policy.ts`, `app/integrations/v1/trace-disputes/[action]/route.ts`, report modal and native tracker; Admin follow-up page. |
| TRACE | `app/modules/patient_form/native_dispute.py`, `dispute_access.py`, staff dispute router, ticket/comment adapters and native outbox/scheduler integration. |
| Gateway | `app/middleware/dispute_integration.py`, dedicated settings, authority-header stripping. |

## Stage and outcome rules

| Stage | Advance condition |
|---|---|
| 1 Dispute Sent | Patient confirms and VITAL durably records the report plus hold. |
| 2 Dispute Approved or Rejected | TRACE Admin decides; identity/time recorded. Approval assigns that Admin; rejection has a persisted action and patient reason. |
| 3 Dispute in Process | Staff investigation or patient rejection of a proposal. No active countdown after rejection. |
| 4 Completed | Admin-reviewed proposal is recorded as available in VITAL. |
| 5 Acknowledged / Automatically Resolved | Confirmed original-patient acceptance or separately identified coordinated timeout. |

Stages do not substitute for appointment outcomes. Complete resumes the original deadline and payment/clinical checks. Invalidate uses appointment/Records ownership and separates Accounting issuance. Reschedule uses one reviewed authorization through the normal paid replacement coordinator, with patient slot choice and doctor approval. Failed attempts preserve the grant; pivot consumes it without changing ordinary quotas. Incompatible corrections create an Admin follow-up.

## Sequence

```mermaid
sequenceDiagram
    participant P as Patient in VITAL
    participant W as VITAL Web
    participant V as VITAL Services
    participant G as BGH API Gateway
    participant T as TRACE Backend
    participant A as TRACE Admin
    P->>W: Confirm report and optional report evidence
    W->>V: Owned command over private mTLS and signed assertion
    V->>V: Atomic report, original deadline, hold and delivery intent
    V-->>P: Stage 1 Dispute Sent
    V->>G: Worker delivers stable native report ID
    G->>T: Verified VITAL service context
    T->>T: Intake; wait for every declared evidence file
    A->>T: Approve or reject
    alt Rejected
      T->>G: Rejection snapshot and action
      G->>W: Verified TRACE callback
      W->>V: Signed callback through private mTLS
      V->>V: Release hold and resume original completion checks
      V-->>P: Rejection modal, reason, pending configured BGH contacts
    else Approved
      T->>T: One ticket; approving Admin is initial assignee
      T-->>V: Stage 2 then Stage 3 snapshots through Gateway/Web
      A->>T: Review and propose explicit tag with fresh decision
      T->>G: Stage 4 event; no countdown yet
      G->>W: Verified callback
      W->>V: Store proposal under appointment lock
      V->>V: Availability = server receipt; deadline = availability +72h
      V-->>T: Stored availability/deadline receipt through Web/Gateway
      V-->>P: Resolution details and countdown
      alt Patient responds in time
        P->>V: Via authenticated BFF; persist pending response
        V->>G: Stable response operation and acceptance timestamp
        G->>T: Original-patient response
        alt Issue Not Resolved
          T->>T: Reason comment; Open ticket; clear completion/countdown
          T-->>V: Stage 3 through Gateway/Web; retain hold
          Note over A,T: Renewed Admin review and decision required
        else Accepted
          T->>T: Resolve ticket and enqueue confirmation together
          T-->>V: Stage 5 patient_acknowledged through Gateway/Web
          V->>V: Apply eligible outcome once through owners
        end
      else No timely response
        T->>G: Ask for timeout confirmation
        G->>W: Verified service request
        W->>V: Lock same appointment and active decision
        V-->>T: Timely pending response blocks; otherwise timeout receipt
        T->>T: Recheck version; atomic auto-resolution and outbox
        T-->>V: Stage 5 auto_resolved_72h through Gateway/Web
        V->>V: Eligible outcome or retained reschedule hold/Admin follow-up
      end
    end
```

Transport arrows abbreviated from TRACE to Services always traverse Gateway → Web → private mTLS Services; there is no native direct callback. Durable outbox/inbox and reconciliation recover lost acknowledgments, stale snapshots and process crashes. Full field definitions and authorization allowlists are in the handoff.

## Verification and rollout order

1. Apply additive Core and TRACE migrations in isolated owner databases. Regenerate Prisma clients and runtime grants. Retain history; review legacy identities rather than infer them.
2. Run owner regression suites, type/build and migration checks. Record exact results and pre-existing/infrastructure-dependent failures in the handoff.
3. Supply directional Gateway secrets, service actor ID, trusted downstream URLs, Web/API mTLS assertion material and Records/TRACE storage/scanner configuration through deployment management.
4. TRACE Frontend owner wires the Admin queue, action/evidence views, fault determination, resolution/correction fields and financial-only confirmation control. Hospital phone/address are still pending.
5. Run paired isolated Gateway/mTLS acceptance for the listed retries, ownership, time races, financial/clinical checks and replacement cases. Keep every feature flag disabled until evidence is recorded.
6. Enable the same native flag across all owners together and monitor pending deliveries, holds, patient responses, availability receipts and Admin follow-up items.
