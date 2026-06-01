import { signLicense } from "./sign";
import { plus30DaysISO } from "./db";
import type { Caps, Features, License, LicenseRow, Tier } from "./types";

const SIGNING_KEY_ID = "v1";
const SCHEMA_VERSION = 1;

export function capsForTier(tier: Tier, packSize: number): Caps {
  if (tier === "enterprise") {
    return { max_tenants: -1, max_agents_per_tenant: -1, max_agents_total: -1, max_devices: -1, pack_size: 0 };
  }
  if (tier === "professional") {
    return { max_tenants: 5, max_agents_per_tenant: 100, max_agents_total: -1, max_devices: 500, pack_size: packSize };
  }
  if (tier === "business") {
    return { max_tenants: 1, max_agents_per_tenant: 20, max_agents_total: 20, max_devices: 100, pack_size: 1 };
  }
  // home
  return { max_tenants: 1, max_agents_per_tenant: 10, max_agents_total: 10, max_devices: 50, pack_size: 1 };
}

export function featuresForTier(tier: Tier): Features {
  if (tier === "enterprise") {
    return { sso: true, immutable_logs: true, automatic_fallback: true, priority_support: true, custom_profiles: true, per_tenant_profiles: true };
  }
  if (tier === "professional") {
    return { sso: true, immutable_logs: true, automatic_fallback: true, priority_support: false, custom_profiles: true, per_tenant_profiles: true };
  }
  if (tier === "business") {
    return { sso: true, immutable_logs: true, automatic_fallback: true, priority_support: false, custom_profiles: false, per_tenant_profiles: false };
  }
  return { sso: false, immutable_logs: false, automatic_fallback: false, priority_support: false, custom_profiles: false, per_tenant_profiles: false };
}

export async function buildLicenseBlob(
  license: LicenseRow,
  instanceId: string,
  privKeyB64: string,
  opts: { issuedAt?: string; expiresAt?: string } = {},
): Promise<License> {
  const tier = license.tier as Tier;
  const issuedAt = opts.issuedAt ?? license.issued_at;
  const expiresAt = opts.expiresAt ?? plus30DaysISO();

  const blob: License = {
    version: SCHEMA_VERSION,
    license_key: license.license_key,
    instance_id: instanceId,
    tier,
    issued_to: {
      org_name: license.issued_to_org,
      contact_email: license.contact_email,
    },
    issued_at: issuedAt,
    expires_at: expiresAt,
    caps: capsForTier(tier, license.pack_size),
    features: featuresForTier(tier),
    profiles_available: ["*"],
    signature: "",
    signing_key_id: SIGNING_KEY_ID,
  };

  blob.signature = await signLicense(blob, privKeyB64);
  return blob;
}
