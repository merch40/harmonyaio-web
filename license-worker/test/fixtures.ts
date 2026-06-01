// Test fixtures shared across unit + integration tests.
// No filesystem access here; vitest.config.ts loads dev.secrets.json
// at config time and exposes the keys via worker bindings.
import type { License, LicenseRow } from "../src/types";

export const FIXED_LICENSE: License = {
  version: 1,
  license_key: "HRM-PRO-PA00-DOGF-OOD1",
  instance_id: "00000000-0000-4000-8000-000000000000",
  tier: "professional",
  issued_to: {
    org_name: "Professional Advantage",
    contact_email: "beau@professionaladvantage.com",
  },
  issued_at: "2026-05-01T00:00:00Z",
  expires_at: "2026-05-31T00:00:00Z",
  caps: {
    max_tenants: 100,
    max_agents_per_tenant: -1,
    max_agents_total: -1,
    max_devices: -1,
    pack_size: 100,
  },
  features: {
    sso: true,
    immutable_logs: true,
    automatic_fallback: true,
    priority_support: true,
    custom_profiles: true,
    per_tenant_profiles: true,
  },
  profiles_available: ["*"],
  signature: "ignored-by-canonical",
  signing_key_id: "v1",
};

// Captured byte-for-byte from `go run ./external/harmony-license-worker/scripts/gen-canonical-fixture`
// against internal/license/canonical.go.  If this string drifts from the
// Go output, signature verification will silently fail at runtime.
export const EXPECTED_CANONICAL =
  '{"caps":{"max_agents_per_tenant":-1,"max_agents_total":-1,"max_devices":-1,"max_tenants":100,"pack_size":100},' +
  '"expires_at":"2026-05-31T00:00:00Z",' +
  '"features":{"automatic_fallback":true,"custom_profiles":true,"immutable_logs":true,"per_tenant_profiles":true,"priority_support":true,"sso":true},' +
  '"instance_id":"00000000-0000-4000-8000-000000000000",' +
  '"issued_at":"2026-05-01T00:00:00Z",' +
  '"issued_to":{"contact_email":"beau@professionaladvantage.com","org_name":"Professional Advantage"},' +
  '"license_key":"HRM-PRO-PA00-DOGF-OOD1",' +
  '"profiles_available":["*"],' +
  '"signing_key_id":"v1",' +
  '"tier":"professional",' +
  '"version":1}';

export const SAMPLE_LICENSE_ROW: LicenseRow = {
  license_key: "HRM-PRO-PA00-DOGF-OOD1",
  tier: "professional",
  pack_size: 100,
  packs: null,
  issued_to_org: "Professional Advantage",
  contact_email: "beau@professionaladvantage.com",
  issued_at: "2026-05-01T00:00:00Z",
  expires_at: null,
  revoked_at: null,
  revoked_reason: null,
  notes: null,
};
