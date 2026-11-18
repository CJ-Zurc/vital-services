ALTER TYPE "AppointmentStatus" ADD VALUE IF NOT EXISTS 'no_show';
CREATE TABLE appointment_booking_acknowledgments (
  "appointmentId" TEXT PRIMARY KEY REFERENCES appointments(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reference TEXT NOT NULL UNIQUE,
  snapshot JSONB NOT NULL,
  "protectedPdf" JSONB,
  "pdfHash" TEXT,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supersededBy" TEXT REFERENCES appointments(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
