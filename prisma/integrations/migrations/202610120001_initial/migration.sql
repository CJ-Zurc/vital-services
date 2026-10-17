-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('gcash', 'maya', 'paymongo');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('unpaid', 'pending', 'pending_verification', 'approved', 'paid', 'failed', 'rejected', 'refund_pending', 'refunded', 'refund_failed', 'non_refundable');

-- CreateEnum
CREATE TYPE "PaymentOperationStatus" AS ENUM ('pending', 'completed', 'failed', 'unknown');

-- CreateTable
CREATE TABLE "google_meet_connections" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "googleSubject" TEXT,
    "email" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "refreshLease" TEXT,
    "refreshLeaseUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_meet_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_meet_oauth_states" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "bindingHash" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "returnTo" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_meet_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_meet_generations" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "connectionRevision" INTEGER NOT NULL,
    "requestId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'creating',
    "spaceName" TEXT,
    "meetingUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAppointmentId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "billingLineageId" TEXT NOT NULL,
    "providerAttemptStartedAt" TIMESTAMP(3),

    CONSTRAINT "google_meet_generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "paymentProvider" "PaymentProvider" NOT NULL,
    "providerMode" TEXT NOT NULL DEFAULT 'sandbox',
    "proofFilePath" TEXT,
    "referenceNumber" TEXT,
    "amount" DECIMAL(10,2),
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "status" "PaymentStatus" NOT NULL DEFAULT 'unpaid',
    "checkoutSessionId" TEXT,
    "checkoutUrl" TEXT,
    "paymentIntentId" TEXT,
    "paymongoPaymentId" TEXT,
    "refundId" TEXT,
    "refundReason" TEXT,
    "refundEligible" BOOLEAN,
    "latestWebhookEventId" TEXT,
    "rejectionReason" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "refundRequestedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_operations" (
    "id" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "operationType" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "PaymentOperationStatus" NOT NULL DEFAULT 'pending',
    "providerId" TEXT,
    "result" JSONB,
    "error" TEXT,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "filePath" TEXT,
    "patientName" TEXT,
    "doctorName" TEXT,
    "consultationDate" DATE,
    "service" TEXT,
    "paymentMethod" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "producer" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "aggregateVersion" INTEGER NOT NULL,
    "correlationId" TEXT NOT NULL,
    "causationId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox_events" (
    "consumerId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_events_pkey" PRIMARY KEY ("consumerId","eventId")
);

-- CreateTable
CREATE TABLE "command_operations" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" JSONB,
    "errorCode" TEXT,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "command_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_resources" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "billingLineageId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT NOT NULL DEFAULT 'gmeet',
    "meetingUrl" TEXT,
    "normalizedMeetingUrl" TEXT,
    "meetingUrlHash" TEXT,
    "validationStatus" TEXT NOT NULL,
    "googleSpaceName" TEXT,
    "generationId" TEXT,
    "linkGeneratedAt" TIMESTAMP(3),
    "linkSavedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meet_generation_quotas" (
    "doctorId" TEXT NOT NULL,
    "billingLineageId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "attemptsStarted" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meet_generation_quotas_pkey" PRIMARY KEY ("doctorId","billingLineageId","purpose")
);

-- CreateTable
CREATE TABLE "saga_participants" (
    "operationId" TEXT NOT NULL,
    "participant" TEXT NOT NULL,
    "sourceAppointmentId" TEXT NOT NULL,
    "replacementAppointmentId" TEXT NOT NULL,
    "expectedVersion" INTEGER NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt" TIMESTAMP(3),

    CONSTRAINT "saga_participants_pkey" PRIMARY KEY ("operationId","participant")
);

-- CreateTable
CREATE TABLE "integration_deliveries" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "receiptId" TEXT,
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "google_meet_connections_doctorId_key" ON "google_meet_connections"("doctorId");

-- CreateIndex
CREATE INDEX "google_meet_oauth_states_expiresAt_idx" ON "google_meet_oauth_states"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "google_meet_generations_claimedAppointmentId_key" ON "google_meet_generations"("claimedAppointmentId");

-- CreateIndex
CREATE INDEX "google_meet_generations_createdAt_idx" ON "google_meet_generations"("createdAt");

-- CreateIndex
CREATE INDEX "google_meet_generations_doctorId_createdAt_idx" ON "google_meet_generations"("doctorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "google_meet_generations_doctorId_requestId_key" ON "google_meet_generations"("doctorId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_appointmentId_key" ON "payments"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_checkoutSessionId_key" ON "payments"("checkoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_latestWebhookEventId_key" ON "payments"("latestWebhookEventId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_operations_operationKey_key" ON "payment_operations"("operationKey");

-- CreateIndex
CREATE INDEX "payment_operations_status_updatedAt_idx" ON "payment_operations"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_paymentId_key" ON "invoices"("paymentId");

-- CreateIndex
CREATE INDEX "outbox_events_status_nextAttemptAt_leaseUntil_idx" ON "outbox_events"("status", "nextAttemptAt", "leaseUntil");

-- CreateIndex
CREATE INDEX "outbox_events_producer_aggregateId_aggregateVersion_idx" ON "outbox_events"("producer", "aggregateId", "aggregateVersion");

-- CreateIndex
CREATE INDEX "command_operations_status_leaseUntil_idx" ON "command_operations"("status", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "command_operations_actorId_operationId_key" ON "command_operations"("actorId", "operationId");

-- CreateIndex
CREATE UNIQUE INDEX "video_resources_appointmentId_key" ON "video_resources"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "video_resources_meetingUrlHash_key" ON "video_resources"("meetingUrlHash");

-- CreateIndex
CREATE UNIQUE INDEX "video_resources_generationId_key" ON "video_resources"("generationId");

-- CreateIndex
CREATE INDEX "video_resources_doctorId_billingLineageId_idx" ON "video_resources"("doctorId", "billingLineageId");

-- CreateIndex
CREATE INDEX "saga_participants_status_preparedAt_idx" ON "saga_participants"("status", "preparedAt");

-- CreateIndex
CREATE INDEX "integration_deliveries_status_nextAttemptAt_leaseUntil_idx" ON "integration_deliveries"("status", "nextAttemptAt", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "integration_deliveries_destination_requestId_key" ON "integration_deliveries"("destination", "requestId");

-- AddForeignKey
ALTER TABLE "google_meet_generations" ADD CONSTRAINT "google_meet_generations_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "google_meet_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
