CREATE TABLE "chief_complaint_history" (
  "id" TEXT PRIMARY KEY,
  "appointmentId" TEXT NOT NULL REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "previousText" TEXT,
  "currentText" TEXT,
  "doctorAuthId" TEXT NOT NULL,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appointmentVersion" INTEGER NOT NULL
);
CREATE INDEX "chief_complaint_history_appointmentId_changedAt_idx" ON "chief_complaint_history"("appointmentId", "changedAt");
-- Existing historical entries are preserved; enforce the range on new writes.
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_rating_range" CHECK ("starRating" BETWEEN 1 AND 5) NOT VALID;

ALTER TABLE "appointment_logs" ADD COLUMN "changedByAuthId" TEXT, ADD COLUMN "rescheduleDetails" JSONB;
