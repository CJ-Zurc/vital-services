CREATE TABLE "appointment_access" (
  "appointmentId" TEXT PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE ON UPDATE CASCADE,
  reference VARCHAR(8) NOT NULL,
  "patientId" TEXT NOT NULL,
  "doctorId" TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  digest TEXT,
  ciphertext JSONB,
  attempts INTEGER NOT NULL DEFAULT 0,
  "consumedAt" TIMESTAMPTZ,
  "revokedAt" TIMESTAMPTZ,
  "grantUntil" TIMESTAMPTZ,
  "grantedAt" TIMESTAMPTZ,
  "identityValues" JSONB,
  "ageYears" INTEGER,
  sex TEXT,
  "consentVersion" TEXT NOT NULL DEFAULT 'appointment-sharing-v1',
  "consentedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (reference ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$'),
  CHECK (attempts BETWEEN 0 AND 5)
);
-- Reschedule replacement rows deliberately share a reference. Distinct bookings
-- acquire a globally unique root reference in this registry.
CREATE TABLE "appointment_references" (reference VARCHAR(8) PRIMARY KEY, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "appointment_access_attempts" (
  id BIGSERIAL PRIMARY KEY, "appointmentId" TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "doctorId" TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('redeem','reissue')),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "appointment_access_attempts_doctor_time" ON "appointment_access_attempts" ("doctorId","createdAt");
CREATE INDEX "appointment_access_attempts_booking_time" ON "appointment_access_attempts" ("appointmentId","createdAt");
CREATE TABLE "appointment_intake_briefs" (
 "appointmentId" TEXT PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "intakeVersion" INTEGER NOT NULL DEFAULT 1, "sourceHash" TEXT NOT NULL,
 summary JSONB NOT NULL, "approvedText" TEXT, "approvedHash" TEXT,
 "approvedBy" TEXT, "approvedAt" TIMESTAMPTZ,
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
