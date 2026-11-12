ALTER TABLE "appointments" ADD COLUMN "traceRefundApproved" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "appointments" ADD COLUMN "appealAcknowledgedAt" TIMESTAMPTZ;
