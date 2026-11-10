-- AlterEnum
ALTER TYPE "AppointmentStatus" ADD VALUE IF NOT EXISTS 'in_review';
ALTER TYPE "AppointmentStatus" ADD VALUE IF NOT EXISTS 'invalid';
ALTER TYPE "AppointmentStatus" ADD VALUE IF NOT EXISTS 'no_show';

-- AlterTable
ALTER TABLE "appointments"
  ADD COLUMN IF NOT EXISTS "traceTicketId" UUID,
  ADD COLUMN IF NOT EXISTS "traceCaseId" UUID,
  ADD COLUMN IF NOT EXISTS "reviewHold" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "appealReference" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "appealDeadlineAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "disputeReason" TEXT,
  ADD COLUMN IF NOT EXISTS "disputedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "activeDecisionId" UUID,
  ADD COLUMN IF NOT EXISTS "accountingRef" TEXT,
  ADD COLUMN IF NOT EXISTS "accountingRefundIssuedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "doctorProofScreenshotUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "doctorDeliverableType" TEXT,
  ADD COLUMN IF NOT EXISTS "doctorDeliverableRef" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "appointments_appealReference_key" ON "appointments"("appealReference");
CREATE INDEX IF NOT EXISTS "appointments_appealReference_idx" ON "appointments"("appealReference");
CREATE INDEX IF NOT EXISTS "appointments_reviewHold_idx" ON "appointments"("reviewHold");
CREATE INDEX IF NOT EXISTS "appointments_traceCaseId_idx" ON "appointments"("traceCaseId");
