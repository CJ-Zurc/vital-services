ALTER TABLE "payments"
  ADD COLUMN "receiptPdf" BYTEA,
  ADD COLUMN "receiptHash" TEXT;
