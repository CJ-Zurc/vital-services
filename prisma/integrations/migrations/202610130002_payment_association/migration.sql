ALTER TABLE payments ADD COLUMN "providerOriginAppointmentId" TEXT;
UPDATE payments SET "providerOriginAppointmentId"="appointmentId" WHERE "checkoutSessionId" IS NOT NULL;
CREATE TABLE "payment_association_holds" (
  "operationId" TEXT PRIMARY KEY, "billingLineageId" TEXT NOT NULL,
  "sourceAppointmentId" TEXT NOT NULL, "replacementAppointmentId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL, "expectedSourceVersion" INTEGER NOT NULL,
  "expectedReplacementVersion" INTEGER NOT NULL, "associationVersion" INTEGER NOT NULL,
  "paymentId" TEXT, "paymentVersion" INTEGER, "freezeToken" TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared', receipt JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL, "finalizedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT payment_hold_state CHECK (state IN ('prepared','finalized','aborted')),
  CONSTRAINT payment_hold_association CHECK ("associationVersion">0),
  CONSTRAINT payment_hold_resource FOREIGN KEY ("paymentId") REFERENCES payments(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX payment_one_active_hold ON payment_association_holds("billingLineageId") WHERE state='prepared';
CREATE INDEX payment_hold_lineage_state ON payment_association_holds("billingLineageId",state);
