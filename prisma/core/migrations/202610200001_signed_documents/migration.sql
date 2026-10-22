CREATE TABLE "doctor_signatures" (
 id uuid PRIMARY KEY, "doctorAuthId" text NOT NULL, "operationId" uuid NOT NULL,
 "inputHash" text NOT NULL, "contentHash" text NOT NULL, "protectedPayload" jsonb NOT NULL,
 "scanEvidence" jsonb NOT NULL, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT doctor_signatures_operation_key UNIQUE ("doctorAuthId","operationId")
);
ALTER TABLE vital_doctors ADD COLUMN "s2License" text, ADD COLUMN "s2ValidFrom" date,
 ADD COLUMN "s2ValidUntil" date, ADD COLUMN "signatureAssetId" uuid REFERENCES doctor_signatures(id) ON DELETE RESTRICT;
ALTER TABLE vital_doctors ADD CONSTRAINT doctor_s2_dates CHECK ("s2ValidFrom" IS NULL OR "s2ValidUntil" IS NULL OR "s2ValidFrom" <= "s2ValidUntil");
UPDATE vital_doctors SET "isDoctorOnboardingComplete"=false;
ALTER TABLE vital_doctors DROP COLUMN title;
ALTER TABLE records_documents ADD COLUMN "supersedesId" uuid REFERENCES records_documents(id) ON DELETE RESTRICT, ADD COLUMN "correctionReason" text;
CREATE UNIQUE INDEX records_documents_one_replacement ON records_documents("supersedesId");
