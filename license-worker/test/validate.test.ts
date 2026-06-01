import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";
import { applySchema, insertProLicense, resetDB, getTestEnv } from "./helpers";

beforeAll(async () => {
  await applySchema();
});
beforeEach(async () => {
  await resetDB();
});

async function post(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://license.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /validate", () => {
  it("rolls expiry and inserts a telemetry row", async () => {
    await insertProLicense("HRM-PRO-VLDT-0001-AAAA");
    await post("/activate", { license_key: "HRM-PRO-VLDT-0001-AAAA", instance_id: "i1" });

    const res = await post("/validate", {
      license_key: "HRM-PRO-VLDT-0001-AAAA",
      instance_id: "i1",
      server_version: "0.14.3",
      telemetry: {
        tenant_count: 3,
        agent_count: 42,
        instrument_count: 99,
        unique_domain_count: 2,
        per_tenant_stats: [{ tenant_id: "t1", managed_endpoints: 5 }],
      },
    });
    expect(res.status).toBe(200);
    const blob = (await res.json()) as { expires_at: string };
    expect(blob.expires_at).toMatch(/^20\d\d-/);

    const e = getTestEnv();
    const row = await e.DB.prepare(
      "SELECT tenant_count, agent_count, instrument_count FROM telemetry WHERE license_key = ?1 AND instance_id = ?2",
    )
      .bind("HRM-PRO-VLDT-0001-AAAA", "i1")
      .first<{ tenant_count: number; agent_count: number; instrument_count: number }>();
    expect(row).toBeTruthy();
    expect(row?.tenant_count).toBe(3);
    expect(row?.agent_count).toBe(42);
    expect(row?.instrument_count).toBe(99);
  });

  it("returns 409 when called from a non-bound instance", async () => {
    await insertProLicense("HRM-PRO-VLDT-0001-AAAA");
    await post("/activate", { license_key: "HRM-PRO-VLDT-0001-AAAA", instance_id: "i1" });
    const res = await post("/validate", { license_key: "HRM-PRO-VLDT-0001-AAAA", instance_id: "iX" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("instance_mismatch");
  });

  it("returns 403 for unknown key (no grace at the network layer)", async () => {
    const res = await post("/validate", { license_key: "HRM-NONEX", instance_id: "i1" });
    expect(res.status).toBe(403);
  });
});
