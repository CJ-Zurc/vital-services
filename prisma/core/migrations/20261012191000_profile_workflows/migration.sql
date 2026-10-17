CREATE TABLE "profile_workflows" (
    "id" UUID NOT NULL,
    "actorAuthId" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "targetAuthId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "expectedVersion" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'prepared',
    "receipt" JSONB,
    "prepareOperationId" UUID NOT NULL,
    "commitOperationId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "profile_workflows_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "profile_workflows_kind_check" CHECK ("kind" IN ('patient.onboarding', 'doctor.onboarding', 'doctor.provision', 'doctor.specialty', 'doctor.update')),
    CONSTRAINT "profile_workflows_state_check" CHECK ("state" IN ('prepared', 'committed')),
    CONSTRAINT "profile_workflows_steps_check" CHECK (
        "prepareOperationId" <> "id" AND
        ("state" = 'prepared' AND "receipt" IS NULL AND "commitOperationId" IS NULL OR
         "state" = 'committed' AND "receipt" IS NOT NULL AND "commitOperationId" IS NOT NULL
         AND "commitOperationId" <> "prepareOperationId" AND "commitOperationId" <> "id")
    )
);
CREATE INDEX "profile_workflows_actorAuthId_targetAuthId_state_idx" ON "profile_workflows"("actorAuthId", "targetAuthId", "state");

CREATE TABLE "profile_sync_intents" (
    "id" UUID NOT NULL,
    "profileId" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "destination" TEXT NOT NULL,
    "requestId" UUID NOT NULL,
    "requestHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "profile_sync_intents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "profile_sync_intents_destination_check" CHECK ("destination" IN ('auth-stale', 'ehr-mirror')),
    CONSTRAINT "profile_sync_intents_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "vital_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "profile_sync_intents_requestId_key" ON "profile_sync_intents"("requestId");
CREATE UNIQUE INDEX "profile_sync_intents_profileId_sourceVersion_destination_key" ON "profile_sync_intents"("profileId", "sourceVersion", "destination");
CREATE INDEX "profile_sync_intents_authId_sourceVersion_idx" ON "profile_sync_intents"("authId", "sourceVersion");
