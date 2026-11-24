CREATE TABLE appointment_ehr_lifecycle (
  "appointmentId" TEXT PRIMARY KEY REFERENCES appointments(id),
  "diagnosisId" uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('ready','pending','synced','needs_attention')),
  payload jsonb, receipt jsonb, attempts integer NOT NULL DEFAULT 0,
  "lastError" text, "syncedAt" timestamptz,
  "availableAt" timestamptz NOT NULL DEFAULT NOW(),
  "updatedAt" timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX appointment_ehr_delivery_due ON appointment_ehr_lifecycle("availableAt") WHERE state='pending';
ALTER TABLE appointment_workflows ADD COLUMN "ehrFollowUpId" uuid;
ALTER TABLE appointment_workflows ADD COLUMN "ehrPlanStartedAt" TIMESTAMPTZ;
ALTER TABLE appointment_workflows ADD COLUMN "ehrFollowUpInstructions" JSONB;
