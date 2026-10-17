CREATE TABLE "profile_revision_projections" (
    "profileId" TEXT NOT NULL PRIMARY KEY,
    "authId" TEXT NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "profile_revision_projections_authId_key" ON "profile_revision_projections"("authId");
CREATE INDEX "integration_deliveries_profile_sync_idx" ON "integration_deliveries"("aggregateId", "destination", "sourceVersion");
