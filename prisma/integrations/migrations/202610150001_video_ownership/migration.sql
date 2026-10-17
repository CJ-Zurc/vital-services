ALTER TABLE google_meet_oauth_states
 ADD COLUMN "operationId" UUID UNIQUE, ADD COLUMN state TEXT NOT NULL DEFAULT 'prepared',
 ADD COLUMN "executionStartedAt" TIMESTAMP(3), ADD COLUMN "callbackHash" TEXT, ADD COLUMN outcome TEXT;
ALTER TABLE google_meet_generations
 ADD COLUMN "commandHash" TEXT, ADD COLUMN "executionLeaseOwner" TEXT,
 ADD COLUMN "executionLeaseUntil" TIMESTAMP(3), ADD COLUMN "reservedWorkflowId" TEXT,
 ADD COLUMN "failureCode" TEXT;
ALTER TABLE video_resources
 ADD COLUMN "providerOriginAppointmentId" TEXT, ADD COLUMN "associationVersion" INTEGER NOT NULL DEFAULT 1 CHECK ("associationVersion">0),
 ADD COLUMN "preparedWorkflowId" TEXT, ADD COLUMN "retiredAt" TIMESTAMP(3);
CREATE UNIQUE INDEX video_provider_space_unique ON video_resources("googleSpaceName") WHERE "googleSpaceName" IS NOT NULL;
ALTER TABLE meet_generation_quotas ADD CONSTRAINT meet_generation_quota_bound CHECK ("attemptsStarted" BETWEEN 0 AND 2);
CREATE TABLE "video_operations" (
 id UUID PRIMARY KEY, "operationId" UUID NOT NULL, "actorAuthId" TEXT NOT NULL, action TEXT NOT NULL, "resourceId" TEXT NOT NULL,
 "requestHash" TEXT NOT NULL CHECK ("requestHash" ~ '^[a-f0-9]{64}$'),
 state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','executing','completed','unknown','failed')),
 "executionStartedAt" TIMESTAMP(3), "leaseOwner" TEXT, "leaseUntil" TIMESTAMP(3),
 "resultMetadata" JSONB, "failureCode" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX video_operations_due ON video_operations(state,"leaseUntil");
CREATE UNIQUE INDEX video_operation_command_unique ON video_operations("actorAuthId","operationId");
CREATE TABLE "video_workflow_holds" (
 "workflowId" TEXT PRIMARY KEY, "sourceAppointmentId" TEXT NOT NULL, "targetAppointmentId" TEXT NOT NULL,
 "doctorId" TEXT NOT NULL, "expectedSourceVersion" INTEGER NOT NULL, "expectedTargetVersion" INTEGER NOT NULL,
 "billingLineageId" TEXT NOT NULL, "associationVersion" INTEGER NOT NULL CHECK ("associationVersion">0),
 "selectionHash" TEXT NOT NULL CHECK ("selectionHash" ~ '^[a-f0-9]{64}$'),
 "resourceId" TEXT REFERENCES video_resources(id), "resourceVersion" INTEGER,
 "freezeToken" TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','finalized','acknowledged','aborted')),
 receipt JSONB NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX video_workflow_target_prepared ON video_workflow_holds("targetAppointmentId") WHERE state='prepared';
CREATE INDEX video_workflow_due ON video_workflow_holds(state,"expiresAt");
CREATE TABLE "video_association_holds" (
 "operationId" TEXT PRIMARY KEY, "billingLineageId" TEXT NOT NULL, "sourceAppointmentId" TEXT NOT NULL,
 "replacementAppointmentId" TEXT NOT NULL, "requestHash" TEXT NOT NULL,
 "expectedSourceVersion" INTEGER NOT NULL, "expectedReplacementVersion" INTEGER NOT NULL,
 "associationVersion" INTEGER NOT NULL, "videoResourceId" TEXT REFERENCES video_resources(id), "videoResourceVersion" INTEGER,
 "freezeToken" TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','finalized','aborted')),
 receipt JSONB NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "finalizedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX video_association_lineage_prepared ON video_association_holds("billingLineageId") WHERE state='prepared';
CREATE INDEX video_association_due ON video_association_holds("billingLineageId",state);
