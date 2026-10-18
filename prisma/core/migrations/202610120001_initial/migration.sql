-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "EhrRecordOrigin" AS ENUM ('none', 'preexisting', 'created_by_vital');

-- CreateEnum
CREATE TYPE "AvailabilityType" AS ENUM ('virtual', 'in_person', 'both');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('gcash', 'maya', 'paymongo');

-- CreateEnum
CREATE TYPE "ConsultationType" AS ENUM ('virtual', 'in_person', 'both');

-- CreateEnum
CREATE TYPE "SourceLabel" AS ENUM ('bgh_uhse_record', 'external_patient_submitted');

-- CreateEnum
CREATE TYPE "GrantType" AS ENUM ('booking_consent', 'manual');

-- CreateEnum
CREATE TYPE "AppointmentKind" AS ENUM ('standard', 'follow_up');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('pending', 'approved', 'rejected', 'pending_patient_confirmation', 'pending_payment_verification', 'confirmed', 'rescheduled', 'cancelled', 'completed');

-- CreateEnum
CREATE TYPE "MessageSenderRole" AS ENUM ('patient', 'doctor');

-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('registration', 'booking', 'medical_record');

-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('announcement', 'faq');

-- CreateEnum
CREATE TYPE "TargetPortal" AS ENUM ('patient', 'doctor', 'both');

-- CreateTable
CREATE TABLE "vital_users" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "vital_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vital_patients" (
    "userId" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "profilePic" TEXT,
    "isRecordAvailable" BOOLEAN NOT NULL DEFAULT false,
    "ehrPatientId" TEXT,
    "ehrRecordOrigin" "EhrRecordOrigin" NOT NULL DEFAULT 'none',
    "existingEhrRecordNoticeDismissedAt" TIMESTAMP(3),
    "isOnboardingComplete" BOOLEAN NOT NULL DEFAULT false,
    "emergency_contact_name" TEXT,
    "emergency_contact_relationship" TEXT,
    "emergency_contact_phone" TEXT,

    CONSTRAINT "vital_patients_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "vital_doctors" (
    "userId" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "role" TEXT,
    "title" TEXT,
    "specialty" TEXT,
    "department_external_id" TEXT,
    "department_name" TEXT,
    "prc_license" TEXT,
    "availabilityType" "AvailabilityType",
    "virtualFee" DECIMAL(10,2),
    "inPersonFee" DECIMAL(10,2),
    "starRating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "changedAt" TIMESTAMP(3),
    "bio" TEXT,
    "education" TEXT,
    "isDoctorOnboardingComplete" BOOLEAN NOT NULL DEFAULT false,
    "termsAgreedAt" TIMESTAMP(3),

    CONSTRAINT "vital_doctors_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "vital_admins" (
    "userId" TEXT NOT NULL,
    "authId" TEXT NOT NULL,

    CONSTRAINT "vital_admins_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "hospital_affiliations" (
    "id" TEXT NOT NULL,
    "haId" TEXT,
    "doctorId" TEXT NOT NULL,
    "hospitalName" TEXT NOT NULL,

    CONSTRAINT "hospital_affiliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_qr_codes" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "paymentProvider" "PaymentProvider" NOT NULL,
    "filePath" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doctor_qr_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "slotDate" DATE NOT NULL,
    "startTime" TIME NOT NULL,
    "endTime" TIME NOT NULL,
    "consultationType" "ConsultationType" NOT NULL,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_date_blocks" (
    "id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "weekday" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doctor_date_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_health_records" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "externalRecordId" TEXT,
    "recordType" TEXT,
    "description" TEXT,
    "sourceLabel" TEXT NOT NULL DEFAULT 'external_patient_submitted',
    "recordDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_health_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_records" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "hrecordId" TEXT,
    "recordType" TEXT,
    "sourceLabel" "SourceLabel" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "filePath" TEXT,
    "recordDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_record_access" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "grantType" "GrantType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invoicedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "recordSnapshot" JSONB,
    "recordSnapshotCapturedAt" TIMESTAMP(3),
    "recordSnapshotAppointmentId" TEXT,

    CONSTRAINT "doctor_record_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "scheduleSlotId" TEXT,
    "sourceAppointmentId" TEXT,
    "patientRescheduleCount" INTEGER NOT NULL DEFAULT 0,
    "doctorRescheduleCount" INTEGER NOT NULL DEFAULT 0,
    "appointmentKind" "AppointmentKind" NOT NULL DEFAULT 'standard',
    "followUpOfAppointmentId" TEXT,
    "consultationType" "ConsultationType" NOT NULL DEFAULT 'virtual',
    "status" "AppointmentStatus" NOT NULL DEFAULT 'pending',
    "cancellationReason" TEXT,
    "rejectionReason" TEXT,
    "ehrCaseId" TEXT,
    "ehrCaseCreatedAt" TIMESTAMP(3),
    "followUpFlagged" BOOLEAN NOT NULL DEFAULT false,
    "followUpTimeframe" DATE,
    "doctorConfirmedAt" TIMESTAMP(3),
    "patientConfirmedAt" TIMESTAMP(3),
    "completionDeadlineAt" TIMESTAMP(3),
    "autoCompletedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "paperworkLockedAt" TIMESTAMP(3),
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "proposedEndAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "billingLineageId" TEXT NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_logs" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "changedByRole" TEXT,
    "note" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pre_consultations" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "chiefComplaint" TEXT,
    "opqrst" JSONB,
    "isSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMP(3),

    CONSTRAINT "pre_consultations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consultations" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "sessionStartedAt" TIMESTAMP(3),
    "sessionEndedAt" TIMESTAMP(3),
    "videoResourceId" TEXT,

    CONSTRAINT "consultations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" TEXT NOT NULL,
    "consultId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "note" TEXT,
    "lastSavedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "clinicalFindings" TEXT,
    "diagnosis" TEXT,
    "recommendations" TEXT,
    "status" TEXT,
    "image" TEXT,
    "isFinalized" BOOLEAN NOT NULL DEFAULT false,
    "finalizedAt" TIMESTAMP(3),

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescriptions" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "medicationName" TEXT NOT NULL,
    "dosage" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "medicineLines" JSONB,
    "duration" TEXT,
    "specialInstructions" TEXT,
    "doctorNameSnapshot" TEXT,
    "doctorLicenseSnapshot" TEXT,
    "filePath" TEXT,
    "accessCode" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prescriptionValidityLimit" DATE,

    CONSTRAINT "prescriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medical_certificates" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "purpose" TEXT,
    "diagnosis" TEXT,
    "consultationDate" DATE,
    "restStartDate" DATE,
    "restEndDate" DATE,
    "recommendation" TEXT,
    "remarks" TEXT,
    "doctorNameSnapshot" TEXT,
    "doctorLicenseSnapshot" TEXT,
    "filePath" TEXT,
    "endTime" TIME,
    "accessCode" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medical_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_conversations" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "patientLastReadAt" TIMESTAMP(3),
    "doctorLastReadAt" TIMESTAMP(3),
    "legalHoldAt" TIMESTAMP(3),
    "legalHoldReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "message_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "senderRole" "MessageSenderRole" NOT NULL,
    "clientMessageId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT,
    "starRating" INTEGER NOT NULL,
    "feedback" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "consentType" "ConsentType" NOT NULL,
    "accepted" BOOLEAN NOT NULL,
    "consentedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_content" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "contentType" "ContentType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "targetPortal" "TargetPortal" NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_content_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "appointment_payment_projections" (
    "appointmentId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3),
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_payment_projections_pkey" PRIMARY KEY ("appointmentId")
);

-- CreateTable
CREATE TABLE "saga_operations" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceAppointmentId" TEXT NOT NULL,
    "replacementAppointmentId" TEXT,
    "actorAuthId" TEXT NOT NULL,
    "expectedSourceVersion" INTEGER NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'preparing',
    "pivotCommittedAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saga_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slot_reservations" (
    "id" TEXT NOT NULL,
    "slotKey" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',

    CONSTRAINT "slot_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vital_users_authId_key" ON "vital_users"("authId");

-- CreateIndex
CREATE UNIQUE INDEX "vital_patients_authId_key" ON "vital_patients"("authId");

-- CreateIndex
CREATE UNIQUE INDEX "vital_patients_ehrPatientId_key" ON "vital_patients"("ehrPatientId");

-- CreateIndex
CREATE UNIQUE INDEX "vital_doctors_authId_key" ON "vital_doctors"("authId");

-- CreateIndex
CREATE UNIQUE INDEX "vital_admins_authId_key" ON "vital_admins"("authId");

-- CreateIndex
CREATE UNIQUE INDEX "schedules_doctorId_slotDate_startTime_endTime_key" ON "schedules"("doctorId", "slotDate", "startTime", "endTime");

-- CreateIndex
CREATE INDEX "doctor_date_blocks_doctor_id_start_date_end_date_idx" ON "doctor_date_blocks"("doctor_id", "start_date", "end_date");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_record_access_doctorId_patientId_key" ON "doctor_record_access"("doctorId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_ehrCaseId_key" ON "appointments"("ehrCaseId");

-- CreateIndex
CREATE INDEX "appointments_followUpOfAppointmentId_idx" ON "appointments"("followUpOfAppointmentId");

-- CreateIndex
CREATE INDEX "appointments_completionDeadlineAt_idx" ON "appointments"("completionDeadlineAt");

-- CreateIndex
CREATE UNIQUE INDEX "pre_consultations_appointmentId_key" ON "pre_consultations"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "consultations_appointmentId_key" ON "consultations"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "consultations_videoResourceId_key" ON "consultations"("videoResourceId");

-- CreateIndex
CREATE UNIQUE INDEX "reports_appointmentId_key" ON "reports"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "prescriptions_accessCode_key" ON "prescriptions"("accessCode");

-- CreateIndex
CREATE INDEX "prescriptions_patientId_idx" ON "prescriptions"("patientId");

-- CreateIndex
CREATE INDEX "prescriptions_doctorId_idx" ON "prescriptions"("doctorId");

-- CreateIndex
CREATE INDEX "prescriptions_appointmentId_idx" ON "prescriptions"("appointmentId");

-- CreateIndex
CREATE INDEX "prescriptions_issuedAt_idx" ON "prescriptions"("issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "medical_certificates_accessCode_key" ON "medical_certificates"("accessCode");

-- CreateIndex
CREATE INDEX "medical_certificates_patientId_idx" ON "medical_certificates"("patientId");

-- CreateIndex
CREATE INDEX "medical_certificates_doctorId_idx" ON "medical_certificates"("doctorId");

-- CreateIndex
CREATE INDEX "medical_certificates_appointmentId_idx" ON "medical_certificates"("appointmentId");

-- CreateIndex
CREATE INDEX "medical_certificates_generatedAt_idx" ON "medical_certificates"("generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "message_conversations_appointmentId_key" ON "message_conversations"("appointmentId");

-- CreateIndex
CREATE INDEX "appointment_messages_conversationId_createdAt_id_idx" ON "appointment_messages"("conversationId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "appointment_messages_senderUserId_createdAt_idx" ON "appointment_messages"("senderUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_messages_conversationId_senderUserId_clientMess_key" ON "appointment_messages"("conversationId", "senderUserId", "clientMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_appointmentId_key" ON "feedback"("appointmentId");

-- CreateIndex
CREATE INDEX "feedback_doctorId_idx" ON "feedback"("doctorId");

-- CreateIndex
CREATE INDEX "outbox_events_status_nextAttemptAt_leaseUntil_idx" ON "outbox_events"("status", "nextAttemptAt", "leaseUntil");

-- CreateIndex
CREATE INDEX "outbox_events_producer_aggregateId_aggregateVersion_idx" ON "outbox_events"("producer", "aggregateId", "aggregateVersion");

-- CreateIndex
CREATE INDEX "command_operations_status_leaseUntil_idx" ON "command_operations"("status", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "command_operations_actorId_operationId_key" ON "command_operations"("actorId", "operationId");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_payment_projections_paymentId_key" ON "appointment_payment_projections"("paymentId");

-- CreateIndex
CREATE INDEX "saga_operations_status_nextAttemptAt_leaseUntil_idx" ON "saga_operations"("status", "nextAttemptAt", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "slot_reservations_slotKey_key" ON "slot_reservations"("slotKey");

-- CreateIndex
CREATE UNIQUE INDEX "slot_reservations_operationId_key" ON "slot_reservations"("operationId");

-- CreateIndex
CREATE INDEX "slot_reservations_doctorId_startsAt_endsAt_idx" ON "slot_reservations"("doctorId", "startsAt", "endsAt");

-- AddForeignKey
ALTER TABLE "vital_patients" ADD CONSTRAINT "vital_patients_userId_fkey" FOREIGN KEY ("userId") REFERENCES "vital_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vital_doctors" ADD CONSTRAINT "vital_doctors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "vital_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vital_admins" ADD CONSTRAINT "vital_admins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "vital_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hospital_affiliations" ADD CONSTRAINT "hospital_affiliations_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "vital_doctors"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_qr_codes" ADD CONSTRAINT "doctor_qr_codes_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "vital_doctors"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "vital_doctors"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_date_blocks" ADD CONSTRAINT "doctor_date_blocks_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "vital_doctors"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_health_records" ADD CONSTRAINT "external_health_records_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "vital_patients"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_records" ADD CONSTRAINT "health_records_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "vital_patients"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_record_access" ADD CONSTRAINT "doctor_record_access_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "vital_doctors"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_record_access" ADD CONSTRAINT "doctor_record_access_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "vital_patients"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "vital_patients"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "vital_doctors"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_scheduleSlotId_fkey" FOREIGN KEY ("scheduleSlotId") REFERENCES "schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_sourceAppointmentId_fkey" FOREIGN KEY ("sourceAppointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_followUpOfAppointmentId_fkey" FOREIGN KEY ("followUpOfAppointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_logs" ADD CONSTRAINT "appointment_logs_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_consultations" ADD CONSTRAINT "pre_consultations_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_consultId_fkey" FOREIGN KEY ("consultId") REFERENCES "consultations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "vital_doctors"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "vital_doctors"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "vital_patients"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "vital_doctors"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_certificates" ADD CONSTRAINT "medical_certificates_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_certificates" ADD CONSTRAINT "medical_certificates_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "vital_patients"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_certificates" ADD CONSTRAINT "medical_certificates_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "vital_doctors"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_conversations" ADD CONSTRAINT "message_conversations_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_messages" ADD CONSTRAINT "appointment_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "message_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_messages" ADD CONSTRAINT "appointment_messages_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "vital_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "vital_patients"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "vital_patients"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_content" ADD CONSTRAINT "system_content_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "vital_admins"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_payment_projections" ADD CONSTRAINT "appointment_payment_projections_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
