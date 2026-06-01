import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";
import { applySchema, insertProLicense, insertExpiredLicense, insertRevokedLicense, resetDB } from "./helpers";

beforeAll(async () => {
  await applySchema();
});
beforeEach(async () => {
  await resetDB();
});

async function activate(body: unknown): Promise<Response> {
  return SELF.fetch("https://license.test/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /activate", () => {
  it("happy path: binds instance and returns signed blob", async () => {
    await insertProLicense("HRM-PRO-AAAA-BBBB-CCCC");
    const res = await activate({
      license_key: "HRM-PRO-AAAA-BBBB-CCCC",
      instance_id: "instance-alpha",
      server_version: "0.14.2",
      hostname_hash: "abc",
    });
    expect(res.status).toBe(200);
    const blob = (await res.json()) as Record<string, unknown>;
    expect(blob.tier).toBe("professional");
    expect(blob.signing_key_id).toBe("v1");
    expect(typeof blob.signature).toBe("string");
    expect((blob.signature as string).length).toBeGreaterThan(0);
    expect(blob.instance_id).toBe("instance-alpha");
  });

  it("idempotent re-activation on the same instance returns a fresh blob", async () => {
    await insertProLicense("HRM-PRO-AAAA-BBBB-CCCC");
    const a = await activate({ license_key: "HRM-PRO-AAAA-BBBB-CCCC", instance_id: "i1" });
    const b = await activate({ license_key: "HRM-PRO-AAAA-BBBB-CCCC", instance_id: "i1" });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it("returns 409 instance_mismatch when bound to a different active instance", async () => {
    await insertProLicense("HRM-PRO-AAAA-BBBB-CCCC");
    const a = await activate({ license_key: "HRM-PRO-AAAA-BBBB-CCCC", instance_id: "i1" });
    expect(a.status).toBe(200);
    const b = await activate({ license_key: "HRM-PRO-AAAA-BBBB-CCCC", instance_id: "i2" });
    expect(b.status).toBe(409);
    const body = (await b.json()) as { error: { code: string } };
    expect(body.error.code).toBe("instance_mismatch");
  });

  it("rebinds when previous instance has been released", async () => {
    await insertProLicense("HRM-PRO-AAAA-BBBB-CCCC");
    await activate({ license_key: "HRM-PRO-AAAA-BBBB-CCCC", instance_id: "i1" });
    const rel = await SELF.fetch("https://license.test/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ license_key: "HRM-PRO-AAAA-BBBB-CCCC", instance_id: "i1" }),
    });
    expect(rel.status).toBe(200);
    const b = await activate({ license_key: "HRM-PRO-AAAA-BBBB-CCCC", instance_id: "i2" });
    expect(b.status).toBe(200);
  });

  it("returns 403 license_rejected for unknown key", async () => {
    const res = await activate({ license_key: "HRM-NOPE", instance_id: "i1" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("license_rejected");
  });

  it("returns 403 license_revoked for revoked key", async () => {
    await insertRevokedLicense("HRM-BUS-REVO-KED-AAAA");
    const res = await activate({ license_key: "HRM-BUS-REVO-KED-AAAA", instance_id: "i1" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("license_revoked");
  });

  it("returns 403 license_expired for expired key", async () => {
    await insertExpiredLicense("HRM-BUS-EXPI-RED-AAAA");
    const res = await activate({ license_key: "HRM-BUS-EXPI-RED-AAAA", instance_id: "i1" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("license_expired");
  });

  it("returns 400 on missing fields", async () => {
    const res = await activate({});
    expect(res.status).toBe(400);
  });
});
