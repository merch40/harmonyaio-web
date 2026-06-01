import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";
import { applySchema, resetDB, getTestEnv } from "./helpers";
import { canonicalJSON } from "../src/canonical";

beforeAll(async () => {
  await applySchema();
});
beforeEach(async () => {
  await resetDB();
});

describe("end-to-end activate -> validate -> release", () => {
  it("admin issues a license, then full lifecycle works and signature verifies", async () => {
    // Admin issues a Pro license.
    const issueRes = await SELF.fetch("https://license.test/admin/license", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": "test-admin-secret" },
      body: JSON.stringify({
        tier: "professional",
        pack_size: 10,
        issued_to_org: "Acme MSP",
        contact_email: "admin@acme.example",
      }),
    });
    expect(issueRes.status).toBe(200);
    const { license_key } = (await issueRes.json()) as { license_key: string };
    expect(license_key).toMatch(/^HRM-PRO-/);

    // Activate.
    const actRes = await SELF.fetch("https://license.test/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ license_key, instance_id: "instance-1" }),
    });
    expect(actRes.status).toBe(200);
    const blob = (await actRes.json()) as Record<string, unknown> & {
      signature: string;
      signing_key_id: string;
    };

    // Verify the signature using the dev public key (injected via vitest binding).
    const e = getTestEnv();
    const pubBytes = b64decode(e.DEV_PUBLIC_KEY_V1);
    const canon = new TextEncoder().encode(canonicalJSON(blob));
    const sigBytes = b64decode(blob.signature);

    // Use @noble/ed25519 in the worker context for verification.
    const ed = await import("@noble/ed25519");
    const ok = await ed.verifyAsync(sigBytes, canon, pubBytes);
    expect(ok).toBe(true);

    // Validate.
    const valRes = await SELF.fetch("https://license.test/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        license_key,
        instance_id: "instance-1",
        telemetry: { tenant_count: 1, agent_count: 5, instrument_count: 10 },
      }),
    });
    expect(valRes.status).toBe(200);

    // Release.
    const relRes = await SELF.fetch("https://license.test/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ license_key, instance_id: "instance-1" }),
    });
    expect(relRes.status).toBe(200);

    // After release, a different instance can bind.
    const act2 = await SELF.fetch("https://license.test/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ license_key, instance_id: "instance-2" }),
    });
    expect(act2.status).toBe(200);

    // Activations audit log captured every step.
    const audit = await e.DB.prepare(
      "SELECT event, result FROM activations WHERE license_key = ?1 ORDER BY id",
    )
      .bind(license_key)
      .all<{ event: string; result: string }>();
    const events = (audit.results ?? []).map((r) => `${r.event}:${r.result}`);
    expect(events).toContain("activate:success");
    expect(events).toContain("validate:success");
    expect(events).toContain("release:success");
  });

  it("rejects /admin/license without the admin secret", async () => {
    const res = await SELF.fetch("https://license.test/admin/license", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: "business", issued_to_org: "X", contact_email: "x@x" }),
    });
    expect(res.status).toBe(401);
  });

  it("/health returns ok", async () => {
    const res = await SELF.fetch("https://license.test/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
