// Helpers for vitest-pool-workers. Schema is inlined; secrets come from
// bindings injected by vitest.config.ts so no host fs access happens
// inside the worker runtime.
import { env } from "cloudflare:test";

export interface TestEnv {
  DB: D1Database;
  HARMONY_LICENSE_SIGNING_KEY_V1: string;
  SESSION_SECRET: string;
  ADMIN_SECRET: string;
  DEV_PUBLIC_KEY_V1: string;
}

export function getTestEnv(): TestEnv {
  return env as unknown as TestEnv;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS licenses (
  license_key    TEXT PRIMARY KEY,
  tier           TEXT NOT NULL,
  pack_size      INTEGER NOT NULL DEFAULT 1,
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
  PRIMARY KEY (license_key, instance_id)
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
`;

export async function applySchema(): Promise<void> {
  const e = getTestEnv();
  const stmts = SCHEMA_SQL.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const s of stmts) {
    await e.DB.prepare(s).run();
  }
}

export async function resetDB(): Promise<void> {
  const e = getTestEnv();
  for (const t of [
    "rate_limits",
    "magic_links",
    "release_cooldowns",
    "telemetry",
    "activations",
    "instances",
    "licenses",
  ]) {
    await e.DB.prepare(`DELETE FROM ${t}`).run().catch(() => {});
  }
}

export async function insertProLicense(licenseKey = "HRM-PRO-TEST-0001-AAAA"): Promise<void> {
  const e = getTestEnv();
  await e.DB.prepare(
    `INSERT INTO licenses (license_key, tier, pack_size, issued_to_org, contact_email, issued_at, expires_at)
     VALUES (?1, 'professional', 10, 'Test Org', 'tester@example.com', '2026-01-01T00:00:00Z', NULL)`,
  )
    .bind(licenseKey)
    .run();
}

export async function insertExpiredLicense(licenseKey = "HRM-BUS-EXPI-RED-AAAA"): Promise<void> {
  const e = getTestEnv();
  await e.DB.prepare(
    `INSERT INTO licenses (license_key, tier, pack_size, issued_to_org, contact_email, issued_at, expires_at)
     VALUES (?1, 'business', 1, 'Expired Org', 'old@example.com', '2024-01-01T00:00:00Z', '2024-12-31T00:00:00Z')`,
  )
    .bind(licenseKey)
    .run();
}

export async function insertRevokedLicense(licenseKey = "HRM-BUS-REVO-KED-AAAA"): Promise<void> {
  const e = getTestEnv();
  await e.DB.prepare(
    `INSERT INTO licenses (license_key, tier, pack_size, issued_to_org, contact_email, issued_at, expires_at, revoked_at, revoked_reason)
     VALUES (?1, 'business', 1, 'Revoked Org', 'rev@example.com', '2026-01-01T00:00:00Z', NULL, '2026-04-01T00:00:00Z', 'chargeback')`,
  )
    .bind(licenseKey)
    .run();
}
