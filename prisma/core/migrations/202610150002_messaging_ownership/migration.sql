ALTER TABLE message_conversations
  ADD COLUMN "purgedAt" TIMESTAMP(3);
ALTER TABLE message_conversations ADD CONSTRAINT message_conversations_purge_receipts_check
  CHECK ("purgedAt" IS NULL OR ("patientLastReadAt" IS NULL AND "doctorLastReadAt" IS NULL AND "legalHoldAt" IS NULL));
CREATE INDEX message_conversations_createdAt_id_idx ON message_conversations("createdAt",id);

CREATE TABLE "message_legal_holds" (
  id UUID PRIMARY KEY,
  "conversationId" TEXT NOT NULL REFERENCES message_conversations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "reasonCode" TEXT NOT NULL CHECK ("reasonCode" IN ('legal_request','investigation','records_review')),
  "protectedReference" JSONB NOT NULL,
  "placedByAuthId" TEXT NOT NULL,
  "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "releasedByAuthId" TEXT,
  "releasedAt" TIMESTAMP(3),
  CONSTRAINT message_legal_holds_release_check CHECK (("releasedByAuthId" IS NULL)=("releasedAt" IS NULL))
);
CREATE UNIQUE INDEX message_legal_holds_one_active_idx ON message_legal_holds("conversationId") WHERE "releasedAt" IS NULL;
CREATE INDEX message_legal_holds_conversationId_placedAt_idx ON message_legal_holds("conversationId","placedAt");

CREATE TABLE "message_purges" (
  "conversationId" TEXT PRIMARY KEY REFERENCES message_conversations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "purgedAt" TIMESTAMP(3) NOT NULL,
  "expiredAt" TIMESTAMP(3) NOT NULL,
  "removedMessages" INTEGER NOT NULL CHECK ("removedMessages">=0),
  version INTEGER NOT NULL CHECK (version>0)
);

CREATE TABLE "message_retention_scans" (
  id TEXT PRIMARY KEY CHECK (id='messaging-retention'),
  "afterId" TEXT,
  "upperId" TEXT,
  "scanStartedAt" TIMESTAMP(3),
  "lastCompletedAt" TIMESTAMP(3),
  "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" TEXT,
  "leaseUntil" TIMESTAMP(3),
  scanned INTEGER NOT NULL DEFAULT 0 CHECK (scanned>=0),
  eligible INTEGER NOT NULL DEFAULT 0 CHECK (eligible>=0),
  purged INTEGER NOT NULL DEFAULT 0 CHECK (purged>=0),
  CONSTRAINT message_retention_scans_lease_check CHECK (("leaseOwner" IS NULL)=("leaseUntil" IS NULL))
);
INSERT INTO message_retention_scans(id) VALUES ('messaging-retention');

CREATE TABLE "messaging_eligibility_sources" (
  "appointmentId" TEXT PRIMARY KEY,
  "sourceVersion" INTEGER NOT NULL CHECK ("sourceVersion">=0),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
