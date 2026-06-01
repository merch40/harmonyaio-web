-- 004: optional external Company ID on licenses (e.g. CRM/accounting DebtorID).
-- Metadata only; not part of the signed blob. Add the column to existing
-- deployments (001 already created the table). Run once per database;
-- re-running errors with "duplicate column name: company_id" (safe to ignore).
ALTER TABLE licenses ADD COLUMN company_id TEXT;
