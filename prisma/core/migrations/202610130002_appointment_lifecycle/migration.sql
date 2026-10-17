ALTER TABLE schedules ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE doctor_date_blocks ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE appointments ADD COLUMN "expiryProcessedAt" TIMESTAMP(3);
ALTER TABLE appointments ADD COLUMN "maintenanceDueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX appointment_maintenance_due ON appointments("maintenanceDueAt",status);
ALTER TABLE appointment_billing_intents ADD COLUMN "deliveryStatus" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "deliveryLeaseOwner" TEXT, ADD COLUMN "deliveryLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextDeliveryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "deliveryErrorCode" TEXT;
CREATE INDEX appointment_billing_delivery_due ON appointment_billing_intents("deliveryStatus","nextDeliveryAt","deliveryLeaseUntil");
CREATE TABLE "appointment_workflows" (
  id UUID PRIMARY KEY, "appointmentId" TEXT NOT NULL, "actorAuthId" TEXT NOT NULL, "targetAppointmentId" TEXT,
  kind TEXT NOT NULL, "inputHash" TEXT NOT NULL, "expectedVersion" INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared', receipt JSONB, "prepareOperationId" UUID NOT NULL, "externalStartedAt" TIMESTAMP(3),
  "commitOperationId" UUID, "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT appointment_workflow_appointment FOREIGN KEY ("appointmentId") REFERENCES appointments(id) ON DELETE RESTRICT,
  CONSTRAINT appointment_workflow_version CHECK ("expectedVersion" >= 0)
);
CREATE INDEX appointment_workflow_pending ON appointment_workflows("appointmentId",state);
CREATE UNIQUE INDEX appointment_one_prepared_workflow ON appointment_workflows("appointmentId") WHERE state='prepared';
ALTER TABLE saga_operations
  ADD COLUMN "expectedReplacementVersion" INTEGER,
  ADD COLUMN "billingLineageId" TEXT, ADD COLUMN "associationVersion" INTEGER,
  ADD COLUMN "actorRole" TEXT, ADD COLUMN "correlationId" TEXT,
  ADD COLUMN "reservationId" TEXT, ADD COLUMN "requiredParticipants" JSONB,
  ADD COLUMN "prepareReceipts" JSONB, ADD COLUMN "targetRequest" JSONB,
  ADD COLUMN fence INTEGER NOT NULL DEFAULT 0, ADD COLUMN "ownerLogId" TEXT,
  ADD COLUMN "lastErrorCode" TEXT, ADD COLUMN "completedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX saga_one_active_lineage ON saga_operations("billingLineageId")
  WHERE status NOT IN ('completed','compensated','cancelled','failed');
ALTER TABLE slot_reservations DROP CONSTRAINT IF EXISTS slot_reservations_slotKey_key;
DROP INDEX IF EXISTS "slot_reservations_slotKey_key";
ALTER TABLE slot_reservations ADD COLUMN fence INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "releasedAt" TIMESTAMP(3), ADD COLUMN "consumedAt" TIMESTAMP(3),
  ADD CONSTRAINT slot_reservation_interval CHECK ("endsAt" > "startsAt"),
  ADD CONSTRAINT slot_reservation_fence CHECK (fence > 0);
CREATE UNIQUE INDEX slot_one_reserved_key ON slot_reservations("slotKey") WHERE status='reserved';
CREATE UNIQUE INDEX appointment_one_open_proposal ON appointments("sourceAppointmentId")
  WHERE "sourceAppointmentId" IS NOT NULL AND status IN ('pending','pending_patient_confirmation');
ALTER TABLE doctor_date_blocks ADD CONSTRAINT date_block_interval CHECK ("end_date" >= "start_date");
ALTER TABLE doctor_date_blocks ADD CONSTRAINT date_block_weekday CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6);
ALTER TABLE schedules ADD CONSTRAINT schedule_nonempty_interval CHECK ("endTime"<>"startTime");
ALTER TABLE appointments ADD CONSTRAINT appointment_proposed_interval CHECK ("proposedEndAt" IS NULL OR "proposedEndAt">"scheduledAt");
