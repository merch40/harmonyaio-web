-- 003: itemized endpoint packs on licenses (JSON array of {size, qty}).
-- Existing deployments created `licenses` via 001 (CREATE TABLE IF NOT EXISTS),
-- which won't pick up the new column, so add it here. Run once per database;
-- re-running errors with "duplicate column name: packs", which is safe to ignore.
ALTER TABLE licenses ADD COLUMN packs TEXT;
