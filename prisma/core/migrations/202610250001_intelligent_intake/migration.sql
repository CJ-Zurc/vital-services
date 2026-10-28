-- Operational AI ownership stays in vital_core. No legacy analytics import.
CREATE TABLE "ai_intake_drafts" (
 id UUID PRIMARY KEY, "patientAuthId" TEXT NOT NULL, "sessionBinding" TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 0, payload JSONB NOT NULL, analysis JSONB, confirmation JSONB,
 "confirmedAt" TIMESTAMPTZ, "ageYears" INTEGER, sandbox BOOLEAN NOT NULL DEFAULT FALSE, "expiresAt" TIMESTAMPTZ NOT NULL, "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE("patientAuthId","sessionBinding"), CHECK (version>=0), CHECK (length("sessionBinding")=64)
);
CREATE INDEX ai_intake_drafts_expiry ON ai_intake_drafts("expiresAt");
CREATE TABLE "ai_jobs" (
 id UUID PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('interactive','submission','clusters')),
 "resourceId" TEXT NOT NULL, "sourceVersion" INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','running','completed','failed','stale')), "leaseUntil" TIMESTAMPTZ, "leaseOwner" UUID,
 "availableAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), attempts INTEGER NOT NULL DEFAULT 0, "errorCode" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 "completedAt" TIMESTAMPTZ, UNIQUE(kind,"resourceId","sourceVersion")
);
CREATE INDEX ai_jobs_pending ON ai_jobs(status,kind,"createdAt");
CREATE TABLE "ai_submissions" (
 id UUID PRIMARY KEY, "appointmentId" TEXT NOT NULL UNIQUE REFERENCES appointments(id), "patientAuthId" TEXT NOT NULL,
 "intakeVersion" INTEGER NOT NULL, "submittedAt" TIMESTAMPTZ NOT NULL, "reportDate" DATE NOT NULL,
 "expiresAt" TIMESTAMPTZ NOT NULL, "ageYears" INTEGER, payload JSONB NOT NULL, concepts JSONB,
 analysis JSONB, features JSONB, "sourceHash" TEXT NOT NULL, "processedHash" TEXT,
 status TEXT NOT NULL DEFAULT 'pending', "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 "approvedBrief" TEXT, "approvedBy" TEXT, "approvedAt" TIMESTAMPTZ, "approvedHash" TEXT,
 "synthetic" BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX ai_submissions_report ON ai_submissions("reportDate","expiresAt");
ALTER TABLE pre_consultations ADD COLUMN "aiSubmissionId" UUID REFERENCES ai_submissions(id);
CREATE INDEX pre_consultations_ai_submission ON pre_consultations("aiSubmissionId");
CREATE TABLE "ai_daily_aggregates" ("date" DATE PRIMARY KEY,payload JSONB NOT NULL,"computedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),"expiresAt" TIMESTAMPTZ NOT NULL);
CREATE TABLE "ai_cluster_versions" (id TEXT PRIMARY KEY,"inputHash" TEXT NOT NULL UNIQUE,payload JSONB NOT NULL,"createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),"expiresAt" TIMESTAMPTZ NOT NULL);
CREATE TABLE "ai_cluster_labels" ("versionId" TEXT NOT NULL REFERENCES ai_cluster_versions(id) ON DELETE CASCADE,"clusterId" TEXT NOT NULL,label TEXT NOT NULL,"reviewerAuthId" TEXT NOT NULL,"reviewedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY("versionId","clusterId"));
CREATE TABLE "ai_settings" (id TEXT PRIMARY KEY,"activatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW());

-- Non-clinical, expiring logout tombstones prevent an in-flight first save from recreating a deleted draft.
CREATE TABLE "ai_intake_sessions" ("patientAuthId" TEXT NOT NULL,"sessionBinding" TEXT NOT NULL,"revokedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),"expiresAt" TIMESTAMPTZ NOT NULL,PRIMARY KEY("patientAuthId","sessionBinding"));
