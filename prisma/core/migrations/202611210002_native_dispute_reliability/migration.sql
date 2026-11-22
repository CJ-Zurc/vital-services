ALTER TABLE appointments ADD COLUMN "disputeAuthorizationId" text, ADD COLUMN "disputeDecisionId" uuid;
ALTER TABLE appointment_disputes
  ADD COLUMN "reporterAuthId" text,
  ADD COLUMN "originalStatus" text,
  ADD COLUMN "originalCompletionDeadlineAt" timestamptz,
  ADD COLUMN "stateVersion" integer NOT NULL DEFAULT 0,
  ADD COLUMN "decisionId" uuid,
  ADD COLUMN "outcomeAppliedDecisionId" uuid,
  ADD COLUMN "resolutionAvailableAt" timestamptz,
  ADD COLUMN "deliveryStatus" text NOT NULL DEFAULT 'needs_review',
  ADD COLUMN "refundApproved" boolean NOT NULL DEFAULT false,
  ADD COLUMN "faultClassification" text,
  ADD COLUMN "refundIssuedAt" timestamptz,
  ADD COLUMN "refundReference" text,
  ADD COLUMN "rescheduleGranted" boolean NOT NULL DEFAULT false,
  ADD COLUMN "rescheduleConsumedAt" timestamptz,
  ADD COLUMN "evidenceIds" jsonb NOT NULL DEFAULT '[]';

CREATE TABLE trace_dispute_deliveries (
  id uuid PRIMARY KEY, "reportId" text NOT NULL REFERENCES appointment_disputes(id),
  kind text NOT NULL, payload jsonb NOT NULL, "correlationId" uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  "nextAttemptAt" timestamptz NOT NULL DEFAULT now(), "leaseUntil" timestamptz,
  "leaseOwner" uuid, result jsonb, "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trace_dispute_due ON trace_dispute_deliveries(status,"nextAttemptAt");
CREATE TABLE trace_dispute_inbox (
  "eventId" uuid PRIMARY KEY, "reportId" text NOT NULL, hash text NOT NULL,
  result jsonb NOT NULL, "receivedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trace_dispute_responses (
  id uuid PRIMARY KEY, "reportId" text NOT NULL REFERENCES appointment_disputes(id),
  "decisionId" uuid NOT NULL, action text NOT NULL, reason text,
  "acceptedAt" timestamptz NOT NULL, status text NOT NULL DEFAULT 'pending',
  UNIQUE ("reportId","decisionId")
);
CREATE TABLE trace_dispute_timeouts (
  id uuid PRIMARY KEY, "reportId" text NOT NULL REFERENCES appointment_disputes(id),
  "decisionId" uuid NOT NULL, "confirmedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("reportId","decisionId")
);
CREATE TABLE trace_dispute_reviews (
  id uuid PRIMARY KEY, "reportId" text NOT NULL REFERENCES appointment_disputes(id),
  "decisionId" uuid, reason text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
  "resolvedAt" timestamptz, UNIQUE("reportId","decisionId",reason)
);
CREATE TABLE trace_dispute_evidence (
  id uuid PRIMARY KEY, "appointmentId" text NOT NULL REFERENCES appointments(id),
  "reporterAuthId" text NOT NULL, "reportId" text REFERENCES appointment_disputes(id),
  title text NOT NULL, "mimeType" text NOT NULL, "contentHash" text NOT NULL,
  "byteLength" integer NOT NULL CHECK("byteLength" BETWEEN 1 AND 10485760),
  "storageKey" text NOT NULL, status text NOT NULL DEFAULT 'quarantined',
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
-- Historical records have no verified native identity/decision chain. Queue review without guessing links.
INSERT INTO trace_dispute_reviews(id,"reportId","decisionId",reason)
SELECT gen_random_uuid(),id,"decisionId",'legacy_dispute_identity_or_decision_review'
FROM appointment_disputes WHERE "reporterAuthId" IS NULL OR (stage>=4 AND "decisionId" IS NULL);
