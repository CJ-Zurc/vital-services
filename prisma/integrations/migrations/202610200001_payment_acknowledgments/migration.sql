ALTER TABLE invoices ADD COLUMN "acknowledgmentSnapshot" jsonb, ADD COLUMN "acknowledgmentPdf" bytea, ADD COLUMN "acknowledgmentHash" text;
