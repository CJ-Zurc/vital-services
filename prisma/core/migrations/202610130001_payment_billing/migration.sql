ALTER TABLE "appointments" ADD COLUMN "associationVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_association_version_check" CHECK ("associationVersion" >= 1);
DROP INDEX "appointment_payment_projections_paymentId_key";
ALTER TABLE "appointment_payment_projections"
  ADD COLUMN "billingLineageId" TEXT,
  ADD COLUMN "associationVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "reviewRequired" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "appointment_payment_projections_paymentId_idx" ON "appointment_payment_projections"("paymentId");

CREATE TABLE "appointment_billing_quotes" (
  "billingLineageId" TEXT NOT NULL PRIMARY KEY,
  "appointmentId" TEXT NOT NULL,
  "patientAuthId" TEXT NOT NULL,
  "doctorAuthId" TEXT NOT NULL,
  "consultationType" TEXT NOT NULL,
  "amountCentavos" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'PHP',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "appointment_billing_quotes_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "appointment_billing_quotes_amount_check" CHECK ("amountCentavos" BETWEEN 1 AND 2147483647),
  CONSTRAINT "appointment_billing_quotes_currency_check" CHECK ("currency" = 'PHP'),
  CONSTRAINT "appointment_billing_quotes_consultation_check" CHECK ("consultationType" IN ('virtual', 'in_person'))
);
CREATE TABLE "appointment_billing_intents" (
  "id" UUID NOT NULL PRIMARY KEY,
  "appointmentId" TEXT NOT NULL,
  "billingLineageId" TEXT NOT NULL,
  "appointmentVersion" INTEGER NOT NULL,
  "associationVersion" INTEGER NOT NULL,
  "actorAuthId" TEXT NOT NULL,
  "operationId" UUID NOT NULL,
  "requestHash" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'checkout',
  "state" TEXT NOT NULL DEFAULT 'prepared',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "committedAt" TIMESTAMP(3),
  "ownerLogId" TEXT,
  "ownerOperationId" TEXT,
  "replacementAppointmentId" TEXT,
  "expectedPaymentVersion" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "appointment_billing_intents_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "appointment_billing_intents_billingLineageId_fkey" FOREIGN KEY ("billingLineageId") REFERENCES "appointment_billing_quotes"("billingLineageId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "appointment_billing_intents_ownerLogId_fkey" FOREIGN KEY ("ownerLogId") REFERENCES "appointment_logs"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "appointment_billing_intents_kind_check" CHECK ("kind" IN ('checkout', 'expire', 'refund', 'reassociate', 'complete')),
  CONSTRAINT "appointment_billing_intents_state_check" CHECK ("state" IN ('prepared', 'committed')),
  CONSTRAINT "appointment_billing_intents_version_check" CHECK ("appointmentVersion" >= 0 AND "associationVersion" >= 1 AND ("expectedPaymentVersion" IS NULL OR "expectedPaymentVersion" >= 0)),
  CONSTRAINT "appointment_billing_intents_hash_check" CHECK ("requestHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "appointment_billing_intents_commit_check" CHECK (
    ("kind" = 'checkout' AND "state" = 'prepared' AND "committedAt" IS NULL AND "ownerLogId" IS NULL)
    OR ("kind" <> 'checkout' AND "state" = 'committed' AND "committedAt" IS NOT NULL AND "ownerLogId" IS NOT NULL))
);
CREATE UNIQUE INDEX "appointment_billing_intents_actorAuthId_operationId_key" ON "appointment_billing_intents"("actorAuthId", "operationId");
CREATE INDEX "appointment_billing_intents_appointmentId_appointmentVersion_kind_idx" ON "appointment_billing_intents"("appointmentId", "appointmentVersion", "kind");
