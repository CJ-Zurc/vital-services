ALTER TABLE appointments ADD COLUMN "recordsBlockCode" TEXT;

CREATE TABLE "records_workflows" (
 id UUID PRIMARY KEY, "actorAuthId" TEXT NOT NULL,
 "patientId" TEXT NOT NULL REFERENCES vital_patients("userId"),
 "doctorId" TEXT NOT NULL REFERENCES vital_doctors("userId"),
 "appointmentId" TEXT REFERENCES appointments(id), "expectedVersion" INTEGER NOT NULL CHECK ("expectedVersion">=0),
 "associationVersion" INTEGER, "ehrPatientId" TEXT NOT NULL, "ehrCaseId" TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('snapshot','prescription','medical-certificate')),
 "inputHash" TEXT NOT NULL CHECK("inputHash" ~ '^[a-f0-9]{64}$'), recovery BOOLEAN NOT NULL DEFAULT FALSE,
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','committed','abandoned')),
 "prepareOperationId" UUID NOT NULL, "commitOperationId" UUID, "receiptMetadata" JSONB,
 "resourceId" UUID, "expiresAt" TIMESTAMP(3) NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX records_workflows_actor_state ON records_workflows("actorAuthId",state,"expiresAt");

CREATE TABLE "records_snapshots" (
 id UUID PRIMARY KEY, "workflowId" UUID NOT NULL UNIQUE REFERENCES records_workflows(id),
 "appointmentId" TEXT NOT NULL REFERENCES appointments(id),
 "patientId" TEXT NOT NULL REFERENCES vital_patients("userId"),
 "doctorId" TEXT NOT NULL REFERENCES vital_doctors("userId"),
 "appointmentVersion" INTEGER NOT NULL, "associationVersion" INTEGER NOT NULL,
 "ehrPatientId" TEXT NOT NULL, "ehrCaseId" TEXT NOT NULL,
 "sourceHash" TEXT NOT NULL CHECK("sourceHash" ~ '^[a-f0-9]{64}$'),
 "normalizationVersion" INTEGER NOT NULL DEFAULT 1, "protectedPayload" JSONB NOT NULL,
 "receiptMetadata" JSONB NOT NULL, "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX records_snapshots_episode_time ON records_snapshots("appointmentId","capturedAt");
CREATE TABLE "records_episode_grants" (
 "appointmentId" TEXT PRIMARY KEY REFERENCES appointments(id),
 "patientId" TEXT NOT NULL REFERENCES vital_patients("userId"), "doctorId" TEXT NOT NULL REFERENCES vital_doctors("userId"),
 "associationVersion" INTEGER NOT NULL, "appointmentVersion" INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('prepared','live','historical','revoked','transferring')),
 "snapshotId" UUID REFERENCES records_snapshots(id), "frozenSnapshotId" UUID REFERENCES records_snapshots(id),
 "paperworkCutoffAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX records_grants_parties ON records_episode_grants("doctorId","patientId",status);
CREATE TABLE "records_episode_freezes" (
 "appointmentId" TEXT PRIMARY KEY REFERENCES appointments(id), "snapshotId" UUID NOT NULL REFERENCES records_snapshots(id),
 "patientId" TEXT NOT NULL REFERENCES vital_patients("userId"), "protectedPayload" JSONB NOT NULL,
 "cutoffAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "records_file_assets" (
 id UUID PRIMARY KEY, "patientId" TEXT NOT NULL REFERENCES vital_patients("userId"),
 "appointmentId" TEXT REFERENCES appointments(id), kind TEXT NOT NULL CHECK(kind IN ('upload','prescription','medical-certificate')),
 version INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'quarantine' CHECK(state IN ('quarantine','processing','ready','rejected')),
 "protectedPayload" JSONB NOT NULL, "objectKey" TEXT NOT NULL UNIQUE, "publishedKey" TEXT UNIQUE,
 "contentHash" TEXT, "publishedHash" TEXT, "mimeType" TEXT NOT NULL, "byteLength" BIGINT NOT NULL CHECK("byteLength">=0 AND "byteLength"<=10485760),
 "scanEvidence" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX records_assets_patient_state ON records_file_assets("patientId",state,"createdAt");
CREATE TABLE "records_documents" (
 id UUID PRIMARY KEY, "patientId" TEXT NOT NULL REFERENCES vital_patients("userId"),
 "doctorId" TEXT NOT NULL REFERENCES vital_doctors("userId"), "appointmentId" TEXT REFERENCES appointments(id),
 kind TEXT NOT NULL CHECK(kind IN ('prescription','medical-certificate')), "accessCode" TEXT NOT NULL UNIQUE,
 "protectedPayload" JSONB NOT NULL, "assetId" UUID NOT NULL UNIQUE REFERENCES records_file_assets(id),
 "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX records_documents_patient_time ON records_documents("patientId","issuedAt",id);
CREATE INDEX records_documents_doctor_episode ON records_documents("doctorId","appointmentId");
CREATE TABLE "record_operations" (
 "preparedArtifact" JSONB,
 id UUID PRIMARY KEY, "resourceId" UUID NOT NULL REFERENCES records_file_assets(id), "actorAuthId" TEXT NOT NULL,
 "patientId" TEXT NOT NULL REFERENCES vital_patients("userId"), kind TEXT NOT NULL CHECK(kind IN ('artifact','upload')),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','completed','blocked','rejected')),
 version INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, "leaseOwner" TEXT, "leaseUntil" TIMESTAMP(3),
 "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "errorCode" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX record_operations_due ON record_operations(state,"nextAttemptAt","leaseUntil");
CREATE TABLE "records_artifact_capacity" (
 id SMALLINT PRIMARY KEY CHECK (id=1),
 "operationId" UUID UNIQUE REFERENCES record_operations(id), "operationFence" INTEGER,
 "leaseOwner" TEXT, "leaseUntil" TIMESTAMP(3),
 CHECK (("operationId" IS NULL AND "operationFence" IS NULL AND "leaseOwner" IS NULL AND "leaseUntil" IS NULL)
   OR ("operationId" IS NOT NULL AND "operationFence" IS NOT NULL AND "operationFence">0 AND "leaseOwner" IS NOT NULL AND "leaseUntil" IS NOT NULL))
);
INSERT INTO records_artifact_capacity (id) VALUES (1);
CREATE TABLE "records_snapshot_assets" (
 "snapshotId" UUID NOT NULL REFERENCES records_snapshots(id), "assetId" UUID NOT NULL REFERENCES records_file_assets(id),
 PRIMARY KEY("snapshotId","assetId")
);

CREATE FUNCTION vital_records_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable_records_evidence'; END $$;
CREATE TRIGGER immutable_record_snapshots BEFORE UPDATE OR DELETE ON records_snapshots FOR EACH ROW EXECUTE FUNCTION vital_records_immutable();
CREATE TRIGGER immutable_record_documents BEFORE UPDATE OR DELETE ON records_documents FOR EACH ROW EXECUTE FUNCTION vital_records_immutable();
CREATE TRIGGER immutable_episode_freezes BEFORE UPDATE OR DELETE ON records_episode_freezes FOR EACH ROW EXECUTE FUNCTION vital_records_immutable();
CREATE TRIGGER immutable_snapshot_assets BEFORE UPDATE OR DELETE ON records_snapshot_assets FOR EACH ROW EXECUTE FUNCTION vital_records_immutable();

ALTER TABLE notes ADD COLUMN "protectedPayload" JSONB, ADD COLUMN "snapshotId" UUID REFERENCES records_snapshots(id);
ALTER TABLE reports ADD COLUMN "protectedPayload" JSONB, ADD COLUMN "snapshotId" UUID REFERENCES records_snapshots(id);
