// Thin D1 helpers. Each function is single-purpose and prepared so the
// query plan caches well at the edge.

import type { LicenseRow, InstanceRow } from "./types";

export function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function plus30DaysISO(): string {
  const d = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function getLicense(db: D1Database, key: string): Promise<LicenseRow | null> {
  const row = await db
    .prepare("SELECT * FROM licenses WHERE license_key = ?1")
    .bind(key)
    .first<LicenseRow>();
  return row ?? null;
}

export async function getInstance(
  db: D1Database,
  licenseKey: string,
  instanceId: string,
): Promise<InstanceRow | null> {
  const row = await db
    .prepare("SELECT * FROM instances WHERE license_key = ?1 AND instance_id = ?2")
    .bind(licenseKey, instanceId)
    .first<InstanceRow>();
  return row ?? null;
}

export async function getActiveInstance(
  db: D1Database,
  licenseKey: string,
): Promise<InstanceRow | null> {
  const row = await db
    .prepare(
      "SELECT * FROM instances WHERE license_key = ?1 AND released_at IS NULL LIMIT 1",
    )
    .bind(licenseKey)
    .first<InstanceRow>();
  return row ?? null;
}

export async function upsertInstance(
  db: D1Database,
  row: {
    license_key: string;
    instance_id: string;
    server_version?: string;
    hostname_hash?: string;
  },
): Promise<void> {
  const now = nowISO();
  await db
    .prepare(
      `INSERT INTO instances (license_key, instance_id, activated_at, last_seen_at, released_at, server_version, hostname_hash)
       VALUES (?1, ?2, ?3, ?3, NULL, ?4, ?5)
       ON CONFLICT(license_key, instance_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         released_at = NULL,
         server_version = excluded.server_version,
         hostname_hash = excluded.hostname_hash`,
    )
    .bind(
      row.license_key,
      row.instance_id,
      now,
      row.server_version ?? null,
      row.hostname_hash ?? null,
    )
    .run();
}

export async function touchInstance(
  db: D1Database,
  licenseKey: string,
  instanceId: string,
  serverVersion?: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE instances SET last_seen_at = ?3, server_version = COALESCE(?4, server_version)
       WHERE license_key = ?1 AND instance_id = ?2`,
    )
    .bind(licenseKey, instanceId, nowISO(), serverVersion ?? null)
    .run();
}

export async function releaseInstance(
  db: D1Database,
  licenseKey: string,
  instanceId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE instances SET released_at = ?3
       WHERE license_key = ?1 AND instance_id = ?2 AND released_at IS NULL`,
    )
    .bind(licenseKey, instanceId, nowISO())
    .run();
}

export async function logActivation(
  db: D1Database,
  args: {
    license_key: string;
    instance_id?: string | null;
    event: "activate" | "validate" | "release" | "force_release";
    result: "success" | "rejected";
    reason?: string | null;
    client_ip?: string | null;
    user_agent?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO activations (license_key, instance_id, event, result, reason, client_ip, user_agent, occurred_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      args.license_key,
      args.instance_id ?? null,
      args.event,
      args.result,
      args.reason ?? null,
      args.client_ip ?? null,
      args.user_agent ?? null,
      nowISO(),
    )
    .run();
}

export async function recordTelemetry(
  db: D1Database,
  args: {
    license_key: string;
    instance_id: string;
    tenant_count?: number;
    agent_count?: number;
    instrument_count?: number;
    unique_domain_count?: number;
    payload_json?: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO telemetry
       (license_key, instance_id, reported_at, tenant_count, agent_count, instrument_count, unique_domain_count, payload_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      args.license_key,
      args.instance_id,
      nowISO(),
      args.tenant_count ?? null,
      args.agent_count ?? null,
      args.instrument_count ?? null,
      args.unique_domain_count ?? null,
      args.payload_json ?? null,
    )
    .run();
}

export async function getCooldown(
  db: D1Database,
  licenseKey: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT last_force_release_at FROM release_cooldowns WHERE license_key = ?1")
    .bind(licenseKey)
    .first<{ last_force_release_at: string }>();
  return row?.last_force_release_at ?? null;
}

export async function upsertCooldown(db: D1Database, licenseKey: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO release_cooldowns (license_key, last_force_release_at)
       VALUES (?1, ?2)
       ON CONFLICT(license_key) DO UPDATE SET last_force_release_at = excluded.last_force_release_at`,
    )
    .bind(licenseKey, nowISO())
    .run();
}

export async function listActiveInstancesForEmail(
  db: D1Database,
  email: string,
): Promise<InstanceRow[]> {
  const res = await db
    .prepare(
      `SELECT i.* FROM instances i
       JOIN licenses l ON l.license_key = i.license_key
       WHERE l.contact_email = ?1 AND i.released_at IS NULL
       ORDER BY i.activated_at DESC`,
    )
    .bind(email)
    .all<InstanceRow>();
  return res.results ?? [];
}
