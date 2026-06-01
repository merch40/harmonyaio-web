// Types matching internal/license/types.go on the Go side.
// Field names and casing are wire-format and must not drift.

export type Tier = "home" | "business" | "professional" | "enterprise";

export interface IssuedTo {
  org_name: string;
  contact_email: string;
}

export interface Caps {
  max_tenants: number;
  max_agents_per_tenant: number;
  max_agents_total: number;
  max_devices: number;
  pack_size: number;
}

export interface Features {
  sso: boolean;
  immutable_logs: boolean;
  automatic_fallback: boolean;
  priority_support: boolean;
  custom_profiles: boolean;
  per_tenant_profiles: boolean;
}

export interface License {
  version: number;
  license_key: string;
  instance_id: string;
  tier: Tier;
  issued_to: IssuedTo;
  issued_at: string;       // RFC 3339, second precision (Z)
  expires_at: string;      // RFC 3339, second precision (Z)
  caps: Caps;
  features: Features;
  profiles_available: string[];
  signature: string;       // base64
  signing_key_id: string;
}

export interface LicenseRow {
  license_key: string;
  tier: Tier;
  pack_size: number;
  issued_to_org: string;
  contact_email: string;
  issued_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  notes: string | null;
}

export interface InstanceRow {
  license_key: string;
  instance_id: string;
  activated_at: string;
  last_seen_at: string;
  released_at: string | null;
  server_version: string | null;
  hostname_hash: string | null;
}

export interface PerTenantStats {
  tenant_id: string;
  managed_endpoints?: number;
  instruments?: number;
  unique_domain_count?: number;
}

export interface TelemetryPayload {
  tenant_count?: number;
  agent_count?: number;
  instrument_count?: number;
  unique_domain_count?: number;
  per_tenant_stats?: PerTenantStats[];
}

export interface ActivateRequest {
  license_key: string;
  instance_id: string;
  server_version?: string;
  hostname_hash?: string;
}

export interface ValidateRequest extends ActivateRequest {
  telemetry?: TelemetryPayload;
}

export interface ReleaseRequest {
  license_key: string;
  instance_id: string;
}

// Worker bindings. Defined in wrangler.toml + secrets.
export interface Env {
  DB: D1Database;
  HARMONY_LICENSE_SIGNING_KEY_V1: string; // base64 ed25519 priv (64 bytes)
  SESSION_SECRET: string;
  ADMIN_SECRET: string;
  BREVO_API_KEY?: string;
}
