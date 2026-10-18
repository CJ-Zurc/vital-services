-- This target history is deployed to fresh VITAL fixtures only. A non-empty old
-- combined payment ledger must fail rather than invent cross-database lineage.
ALTER TABLE "payments"
  ADD COLUMN "billingLineageId" TEXT NOT NULL,
  ADD COLUMN "associationVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "appointmentVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "amountCentavos" BIGINT,
  ADD COLUMN "patientAuthId" TEXT,
  ADD COLUMN "doctorAuthId" TEXT,
  ADD COLUMN "checkoutState" TEXT,
  ADD COLUMN "reviewRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reviewCode" TEXT,
  ADD COLUMN "nextReconcileAt" TIMESTAMP(3),
  ADD COLUMN "reconcileLeaseOwner" TEXT,
  ADD COLUMN "reconcileLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "lastReconciledAt" TIMESTAMP(3),
  ADD COLUMN "reconcileFailures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "payments" ADD CONSTRAINT "payments_snapshot_check" CHECK (
  "associationVersion" >= 1 AND "appointmentVersion" >= 0 AND "reconcileFailures" >= 0
  AND ("amountCentavos" IS NULL OR "amountCentavos" BETWEEN 1 AND 2147483647));
CREATE UNIQUE INDEX "payments_billingLineageId_key" ON "payments"("billingLineageId");
CREATE UNIQUE INDEX "payments_paymentIntentId_key" ON "payments"("paymentIntentId");
CREATE UNIQUE INDEX "payments_paymongoPaymentId_key" ON "payments"("paymongoPaymentId");
CREATE UNIQUE INDEX "payments_refundId_key" ON "payments"("refundId");
CREATE INDEX "payments_nextReconcileAt_reconcileLeaseUntil_idx" ON "payments"("nextReconcileAt", "reconcileLeaseUntil");

ALTER TABLE "payment_operations"
  ADD COLUMN "paymentId" TEXT,
  ADD COLUMN "actorAuthId" TEXT,
  ADD COLUMN "authorizationIntentId" TEXT,
  ADD COLUMN "requestBody" JSONB,
  ADD COLUMN "executionStartedAt" TIMESTAMP(3),
  ADD COLUMN "leaseOwner" TEXT,
  ADD COLUMN "leaseUntil" TIMESTAMP(3),
  ADD COLUMN "firstAttemptAt" TIMESTAMP(3),
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_attempts_check" CHECK ("attempts" >= 0);
CREATE INDEX "payment_operations_paymentId_operationType_idx" ON "payment_operations"("paymentId", "operationType");
CREATE INDEX "payment_operations_status_nextAttemptAt_leaseUntil_idx" ON "payment_operations"("status", "nextAttemptAt", "leaseUntil");

ALTER TABLE "invoices"
  ADD COLUMN "amountCentavos" BIGINT,
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'PHP',
  ADD COLUMN "billingLineageId" TEXT,
  ADD COLUMN "completedIntentId" TEXT;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_snapshot_check" CHECK (
  "currency" = 'PHP' AND ("amountCentavos" IS NULL OR "amountCentavos" BETWEEN 1 AND 2147483647));
CREATE UNIQUE INDEX "invoices_completedIntentId_key" ON "invoices"("completedIntentId");
