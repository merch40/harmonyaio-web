import { signLicense } from "./sign";
import { plus30DaysISO } from "./db";
import type { Caps, Features, License, LicenseRow, Pack, Tier } from "./types";

const SIGNING_KEY_ID = "v1";
const SCHEMA_VERSION = 1;

// Each endpoint pack also grants this multiple of its size in device inventory.
// A 10-endpoint pack therefore adds 10 managed endpoints and 50 devices.
const DEVICES_PER_ENDPOINT = 5;

// Base caps per tier, before packs. Ladder: Home < Professional < Business < Enterprise.
// Per-tenant agent caps are unlimited (-1); the org-wide total (max_agents_total) and
// the tenant count are the real constraints. Packs raise the total endpoint and device
// caps only, never the per-tenant cap (the org distributes its capacity across tenants).
export function capsForTier(tier: Tier, _legacyPackSize?: number): Caps {
  void _legacyPackSize; // packs are now itemized on the license, not a single size
  if (tier === "enterprise") {
    return { max_tenants: -1, max_agents_per_tenant: -1, max_agents_total: -1, max_devices: -1, pack_size: 0 };
  }
  if (tier === "business") {
    return { max_tenants: 5, max_agents_per_tenant: -1, max_agents_total: 100, max_devices: 500, pack_size: 0 };
  }
  if (tier === "professional") {
    return { max_tenants: 1, max_agents_per_tenant: -1, max_agents_total: 20, max_devices: 100, pack_size: 0 };
  }
  // home (synthetic; never issued as a key)
  return { max_tenants: 1, max_agents_per_tenant: -1, max_agents_total: 10, max_devices: 50, pack_size: 0 };
}

export function featuresForTier(tier: Tier): Features {
  if (tier === "enterprise") {
    return { sso: true, immutable_logs: true, automatic_fallback: true, priority_support: true, custom_profiles: true, per_tenant_profiles: true };
  }
  if (tier === "business") {
    return { sso: true, immutable_logs: true, automatic_fallback: true, priority_support: false, custom_profiles: true, per_tenant_profiles: true };
  }
  if (tier === "professional") {
    return { sso: true, immutable_logs: true, automatic_fallback: true, priority_support: false, custom_profiles: false, per_tenant_profiles: false };
  }
  return { sso: false, immutable_logs: false, automatic_fallback: false, priority_support: false, custom_profiles: false, per_tenant_profiles: false };
}

// parsePacks reads the licenses.packs JSON column ([{size, qty}, ...]) into a
// validated list. Anything malformed is dropped rather than throwing.
export function parsePacks(raw: string | null | undefined): Pack[] {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((p) => ({ size: Number((p as Pack)?.size), qty: Number((p as Pack)?.qty) }))
    .filter((p) => Number.isInteger(p.size) && p.size > 0 && Number.isInteger(p.qty) && p.qty > 0);
}

// packEndpoints returns the total managed endpoints granted by a pack list.
export function packEndpoints(packs: Pack[]): number {
  return packs.reduce((sum, p) => sum + p.size * p.qty, 0);
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

  const caps = capsForTier(tier);
  const extraEndpoints = packEndpoints(parsePacks(license.packs));
  if (extraEndpoints > 0) {
    if (caps.max_agents_total >= 0) caps.max_agents_total += extraEndpoints;
    if (caps.max_devices >= 0) caps.max_devices += extraEndpoints * DEVICES_PER_ENDPOINT;
    caps.pack_size = extraEndpoints; // informational: total endpoints granted by packs
  }

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
    caps,
    features: featuresForTier(tier),
    profiles_available: ["*"],
    signature: "",
    signing_key_id: SIGNING_KEY_ID,
  };

  blob.signature = await signLicense(blob, privKeyB64);
  return blob;
}
