import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";
import { applySchema, resetDB } from "./helpers";

const ADMIN_PW = "test-admin-secret"; // matches vitest.config.ts binding

// Admin sessions are HMAC cookies, not DB rows, so one login survives resetDB
// and is reused across every test (avoids a login fetch + signing per test).
let cookie: string;

beforeAll(async () => {
  await applySchema();
  cookie = await adminLogin();
});
beforeEach(async () => {
  await resetDB();
});

function sessionCookie(res: Response): string {
  const raw =
    (typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie().join("; ")
      : res.headers.get("set-cookie")) ?? "";
  const m = raw.match(/harmony_session=([^;]+)/);
  if (!m) throw new Error("no session cookie: " + raw);
  return "harmony_session=" + m[1];
}

async function adminLogin(): Promise<string> {
  const res = await SELF.fetch("https://license.test/admin/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ADMIN_PW }),
  });
  expect(res.status).toBe(200);
  return sessionCookie(res);
}

async function issue(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch("https://license.test/admin/license", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function activate(key: string, instanceId = "inst-1"): Promise<Response> {
  return SELF.fetch("https://license.test/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ license_key: key, instance_id: instanceId }),
  });
}

interface Caps {
  max_tenants: number;
  max_agents_per_tenant: number;
  max_agents_total: number;
  max_devices: number;
  pack_size: number;
}
interface Blob {
  tier: string;
  caps: Caps;
}

async function activatedCaps(key: string, instanceId = "inst-1"): Promise<Blob> {
  const res = await activate(key, instanceId);
  expect(res.status).toBe(200);
  return (await res.json()) as Blob;
}

describe("corrected tier caps", () => {
  it("professional is the smaller paid tier: 1 tenant, 20 endpoints, 100 devices", async () => {
    const r = await issue(cookie, { tier: "professional", issued_to_org: "Pro", contact_email: "p@x.example" });
    expect(r.status).toBe(200);
    const blob = await activatedCaps(((await r.json()) as { license_key: string }).license_key);
    expect(blob.tier).toBe("professional");
    expect(blob.caps.max_tenants).toBe(1);
    expect(blob.caps.max_agents_total).toBe(20);
    expect(blob.caps.max_devices).toBe(100);
  });

  it("business is the larger paid tier: 5 tenants, 100 endpoints, 500 devices", async () => {
    const r = await issue(cookie, { tier: "business", issued_to_org: "Biz", contact_email: "b@x.example" });
    expect(r.status).toBe(200);
    const blob = await activatedCaps(((await r.json()) as { license_key: string }).license_key);
    expect(blob.tier).toBe("business");
    expect(blob.caps.max_tenants).toBe(5);
    expect(blob.caps.max_agents_total).toBe(100);
    expect(blob.caps.max_devices).toBe(500);
  });

  it("enterprise is unlimited", async () => {
    const r = await issue(cookie, { tier: "enterprise", issued_to_org: "Ent", contact_email: "e@x.example" });
    expect(r.status).toBe(200);
    const blob = await activatedCaps(((await r.json()) as { license_key: string }).license_key);
    expect(blob.caps.max_agents_total).toBe(-1);
    expect(blob.caps.max_devices).toBe(-1);
    expect(blob.caps.max_tenants).toBe(-1);
  });
});

describe("endpoint packs", () => {
  it("Business + 3x20 packs = 160 endpoints and 800 devices", async () => {
    const r = await issue(cookie, {
      tier: "business",
      issued_to_org: "Packed MSP",
      contact_email: "ops@packed.example",
      packs: [{ size: 20, qty: 3 }],
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { license_key: string; pack_endpoints: number };
    expect(body.pack_endpoints).toBe(60);
    const blob = await activatedCaps(body.license_key);
    expect(blob.caps.max_agents_total).toBe(160); // 100 base + 60
    expect(blob.caps.max_devices).toBe(800); // 500 base + 5*60
  });

  it("a 10-pack adds 10 endpoints and 50 devices", async () => {
    const r = await issue(cookie, {
      tier: "professional",
      issued_to_org: "Pro Plus",
      contact_email: "p@plus.example",
      packs: [{ size: 10, qty: 1 }],
    });
    const blob = await activatedCaps(((await r.json()) as { license_key: string }).license_key);
    expect(blob.caps.max_agents_total).toBe(30); // 20 + 10
    expect(blob.caps.max_devices).toBe(150); // 100 + 50
  });

  it("rejects packs on enterprise", async () => {
    const r = await issue(cookie, {
      tier: "enterprise",
      issued_to_org: "Big",
      contact_email: "e@x.example",
      packs: [{ size: 20, qty: 1 }],
    });
    expect(r.status).toBe(400);
  });

  it("rejects an invalid pack size", async () => {
    const r = await issue(cookie, {
      tier: "business",
      issued_to_org: "Bad",
      contact_email: "x@x.example",
      packs: [{ size: 17, qty: 1 }],
    });
    expect(r.status).toBe(400);
  });
});

describe("revoke and remove", () => {
  it("revoke disables the license at validate and re-activate", async () => {
    const { license_key } = (await (
      await issue(cookie, { tier: "business", issued_to_org: "Rev", contact_email: "r@x.example" })
    ).json()) as { license_key: string };
    expect((await activate(license_key)).status).toBe(200);

    const rev = await SELF.fetch("https://license.test/admin/license/revoke", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ license_key, reason: "subscription cancelled" }),
    });
    expect(rev.status).toBe(200);

    const val = await SELF.fetch("https://license.test/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ license_key, instance_id: "inst-1" }),
    });
    expect(val.status).toBe(403);
    expect((await activate(license_key, "inst-2")).status).toBe(403);
  });

  it("remove hard-deletes the license", async () => {
    const { license_key } = (await (
      await issue(cookie, { tier: "professional", issued_to_org: "Del", contact_email: "d@x.example" })
    ).json()) as { license_key: string };

    const rm = await SELF.fetch("https://license.test/admin/license/remove", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ license_key }),
    });
    expect(rm.status).toBe(200);
    expect((await activate(license_key)).status).toBe(403); // gone

    const revGone = await SELF.fetch("https://license.test/admin/license/revoke", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ license_key }),
    });
    expect(revGone.status).toBe(404);
  });

  it("revoke and remove require admin auth", async () => {
    const rev = await SELF.fetch("https://license.test/admin/license/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ license_key: "HRM-BUS-XXXX-YYYY-ZZZZ" }),
    });
    expect(rev.status).toBe(401);
    const rm = await SELF.fetch("https://license.test/admin/license/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ license_key: "HRM-BUS-XXXX-YYYY-ZZZZ" }),
    });
    expect(rm.status).toBe(401);
  });
});
