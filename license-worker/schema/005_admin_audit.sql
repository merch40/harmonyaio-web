-- Independent of licenses: deleting a license must not delete its audit history.
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  actor TEXT NOT NULL,
  session_id TEXT,
  client_ip TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  license_hash TEXT,
  license_hint TEXT,
  before_json TEXT,
  after_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_license ON admin_audit(license_hash, id DESC);
-- A before-image held only inside a D1 batch transaction. A successful batch
-- removes it; a failed batch rolls back the insert. Never exposed through an API.
CREATE TABLE IF NOT EXISTS admin_audit_staging (
  event_id TEXT PRIMARY KEY,
  before_json TEXT
);
