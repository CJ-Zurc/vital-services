ALTER TABLE appointment_workflows
 ADD COLUMN "videoSelectionHash" TEXT CHECK ("videoSelectionHash" IS NULL OR "videoSelectionHash" ~ '^[a-f0-9]{64}$'),
 ADD COLUMN "videoTargetVersion" INTEGER CHECK ("videoTargetVersion" IS NULL OR "videoTargetVersion">=0),
 ADD COLUMN "videoProcessingState" TEXT NOT NULL DEFAULT 'pending' CHECK ("videoProcessingState" IN ('pending','prepared','finalized','blocked')),
 ADD COLUMN "videoReceipt" JSONB,
 ADD COLUMN "videoCorrelationId" TEXT;
CREATE INDEX appointment_video_workflow_due ON appointment_workflows(state,"videoProcessingState");
DROP INDEX IF EXISTS "consultations_videoResourceId_key";
ALTER TABLE consultations ADD COLUMN "videoResourceVersion" INTEGER CHECK ("videoResourceVersion" IS NULL OR "videoResourceVersion">=0);
CREATE INDEX "consultations_videoResourceId_idx" ON consultations("videoResourceId");
