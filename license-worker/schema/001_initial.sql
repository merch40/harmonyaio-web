-- Harmony license worker D1 schema (sprint-licensing-brief §5).

CREATE TABLE IF NOT EXISTS licenses (
  license_key    TEXT PRIMARY KEY,
  tier           TEXT NOT NULL,
  pack_size      INTEGER NOT NULL DEFAULT 1,
  packs          TEXT,
  issued_to_org  TEXT NOT NULL,
  contact_email  TEXT NOT NULL,
  issued_at      TEXT NOT NULL,
  expires_at     TEXT,
  revoked_at     TEXT,
  revoked_reason TEXT,
  notes          TEXT
);

CREATE TABLE IF NOT EXISTS instances (
  license_key    TEXT NOT NULL,
  instance_id    TEXT NOT NULL,
  activated_at   TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  released_at    TEXT,
  server_version TEXT,
  hostname_hash  TEXT,
  PRIMARY KEY (license_key, instance_id),
  FOREIGN KEY (license_key) REFERENCES licenses(license_key)
);

CREATE TABLE IF NOT EXISTS activations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key   TEXT NOT NULL,
  instance_id   TEXT,
  event         TEXT NOT NULL,
  result        TEXT NOT NULL,
  reason        TEXT,
  client_ip     TEXT,
  user_agent    TEXT,
  occurred_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry (
  license_key         TEXT NOT NULL,
  instance_id         TEXT NOT NULL,
  reported_at         TEXT NOT NULL,
  tenant_count        INTEGER,
  agent_count         INTEGER,
  instrument_count    INTEGER,
  unique_domain_count INTEGER,
  payload_json        TEXT,
  PRIMARY KEY (license_key, instance_id, reported_at)
);

CREATE TABLE IF NOT EXISTS release_cooldowns (
  license_key            TEXT PRIMARY KEY,
  last_force_release_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS magic_links (
  token       TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_instances_active ON instances(license_key) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_activations_license ON activations(license_key, occurred_at);
CREATE INDEX IF NOT EXISTS idx_telemetry_license ON telemetry(license_key, reported_at);
