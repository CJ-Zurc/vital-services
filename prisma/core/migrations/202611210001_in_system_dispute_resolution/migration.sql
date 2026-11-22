-- Migration 202611210001: In-System Telemedicine Dispute Resolution & Dedicated Dispute Table
-- what this migration do: Adds in_review and invalid to AppointmentStatus enum, adds reviewHold flag to appointments, and creates dedicated appointment_disputes table.
-- what triggers it: Prisma core migration deploy in vital-services.
-- what does this trigger: Supports native in-system dispute resolution without polluting core appointments table.

-- AlterEnum
ALTER TYPE "AppointmentStatus" ADD VALUE IF NOT EXISTS 'in_review';
ALTER TYPE "AppointmentStatus" ADD VALUE IF NOT EXISTS 'invalid';

-- AlterTable
ALTER TABLE "appointments"
  ADD COLUMN IF NOT EXISTS "reviewHold" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "appointments_reviewHold_idx" ON "appointments"("reviewHold");

-- CreateTable
CREATE TABLE IF NOT EXISTS "appointment_disputes" (
  "id" TEXT NOT NULL,
  "appointmentId" TEXT NOT NULL,
  "traceCaseId" UUID,
  "traceTicketId" UUID,
  "traceTicketNumber" VARCHAR(50),
  "traceDisputeSeq" INTEGER,
  "stage" INTEGER NOT NULL DEFAULT 1,
  "subject" VARCHAR(255) NOT NULL,
  "category" VARCHAR(100) NOT NULL,
  "description" TEXT NOT NULL,
  "rejectionReason" TEXT,
  "proposedOutcomeTag" VARCHAR(32),
  "proposedExplanation" TEXT,
  "acknowledgmentDeadlineAt" TIMESTAMPTZ,
  "resolutionMethod" VARCHAR(50),
  "resolvedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "appointment_disputes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_disputes_appointmentId_key" ON "appointment_disputes"("appointmentId");
CREATE INDEX IF NOT EXISTS "appointment_disputes_appointmentId_idx" ON "appointment_disputes"("appointmentId");
CREATE INDEX IF NOT EXISTS "appointment_disputes_traceCaseId_idx" ON "appointment_disputes"("traceCaseId");
CREATE INDEX IF NOT EXISTS "appointment_disputes_stage_idx" ON "appointment_disputes"("stage");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'appointment_disputes_appointmentId_fkey'
  ) THEN
    ALTER TABLE "appointment_disputes"
      ADD CONSTRAINT "appointment_disputes_appointmentId_fkey"
      FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
