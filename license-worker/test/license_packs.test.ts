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

  it("force-release frees a bound key for a new instance", async () => {
    const { license_key } = (await (
      await issue(cookie, { tier: "business", issued_to_org: "Mig", contact_email: "m@x.example" })
    ).json()) as { license_key: string };
    expect((await activate(license_key, "inst-old")).status).toBe(200);
    // a different instance cannot bind while inst-old holds it
    expect((await activate(license_key, "inst-new")).status).toBe(409);
    const fr = await SELF.fetch("https://license.test/admin/license/force-release", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ license_key }),
    });
    expect(fr.status).toBe(200);
    expect(((await fr.json()) as { released: number }).released).toBe(1);
    // now the new instance can bind
    expect((await activate(license_key, "inst-new")).status).toBe(200);
  });

  it("force-release requires admin auth", async () => {
    const fr = await SELF.fetch("https://license.test/admin/license/force-release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ license_key: "HRM-BUS-XXXX-YYYY-ZZZZ" }),
    });
    expect(fr.status).toBe(401);
  });
});

describe("subscription term", () => {
  it("monthly term sets expires_at about a month out", async () => {
    const r = await issue(cookie, { tier: "professional", term: "monthly", issued_to_org: "Mo", contact_email: "m@x.example" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { expires_at: string | null };
    expect(body.expires_at).toBeTruthy();
    const days = (Date.parse(body.expires_at as string) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(26);
    expect(days).toBeLessThan(33);
  });

  it("annual term sets expires_at about a year out", async () => {
    const r = await issue(cookie, { tier: "business", term: "annual", issued_to_org: "Yr", contact_email: "y@x.example" });
    const body = (await r.json()) as { expires_at: string };
    const days = (Date.parse(body.expires_at) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(360);
    expect(days).toBeLessThan(372);
  });

  it("perpetual term leaves expires_at null", async () => {
    const r = await issue(cookie, { tier: "business", term: "perpetual", issued_to_org: "Pp", contact_email: "p@x.example" });
    const body = (await r.json()) as { expires_at: string | null };
    expect(body.expires_at).toBeNull();
  });
});

describe("company id", () => {
  it("stores and returns the company id", async () => {
    const r = await issue(cookie, {
      tier: "business",
      issued_to_org: "Acct Co",
      contact_email: "a@acct.example",
      company_id: "DEBTOR-12345",
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { company_id: string | null }).company_id).toBe("DEBTOR-12345");

    const list = await SELF.fetch("https://license.test/admin/licenses", { headers: { cookie } });
    const body = (await list.json()) as {
      licenses: Array<{ issued_to_org: string; company_id: string | null }>;
    };
    const row = body.licenses.find((l) => l.issued_to_org === "Acct Co");
    expect(row?.company_id).toBe("DEBTOR-12345");
  });
});

describe("edit metadata", () => {
  it("updates org, contact email, and company id", async () => {
    const issued = (await (
      await issue(cookie, { tier: "business", issued_to_org: "Old Name", contact_email: "old@x.example", company_id: "OLD-1" })
    ).json()) as { license_key: string };

    const upd = await SELF.fetch("https://license.test/admin/license/update", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        license_key: issued.license_key,
        issued_to_org: "New Name",
        contact_email: "new@x.example",
        company_id: "NEW-9",
      }),
    });
    expect(upd.status).toBe(200);

    const list = await SELF.fetch("https://license.test/admin/licenses", { headers: { cookie } });
    const body = (await list.json()) as {
      licenses: Array<{ license_key: string; issued_to_org: string; contact_email: string; company_id: string | null }>;
    };
    const row = body.licenses.find((l) => l.license_key === issued.license_key);
    expect(row?.issued_to_org).toBe("New Name");
    expect(row?.contact_email).toBe("new@x.example");
    expect(row?.company_id).toBe("NEW-9");
  });

  it("update requires admin auth", async () => {
    const r = await SELF.fetch("https://license.test/admin/license/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ license_key: "HRM-BUS-XXXX-YYYY-ZZZZ", issued_to_org: "x" }),
    });
    expect(r.status).toBe(401);
  });
});

describe("edit packs (upsell)", () => {
  it("adding a pack to a bound license grows it on the next validate", async () => {
    const key = (
      (await (
        await issue(cookie, { tier: "professional", issued_to_org: "Grow Co", contact_email: "g@x.example" })
      ).json()) as { license_key: string }
    ).license_key;

    // Customer activates -> plain Professional caps.
    const first = await activatedCaps(key, "inst-grow");
    expect(first.caps.max_agents_total).toBe(20);
    expect(first.caps.max_devices).toBe(100);

    // Admin adds a 10-pack to the existing key (the upsell).
    const upd = await SELF.fetch("https://license.test/admin/license/update", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ license_key: key, packs: [{ size: 10, qty: 1 }] }),
    });
    expect(upd.status).toBe(200);

    // The same bound instance re-validates -> blob now reflects +10 / +50.
    const reval = await SELF.fetch("https://license.test/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ license_key: key, instance_id: "inst-grow" }),
    });
    expect(reval.status).toBe(200);
    const blob = (await reval.json()) as Blob;
    expect(blob.caps.max_agents_total).toBe(30);
    expect(blob.caps.max_devices).toBe(150);
  });

  it("rejects packs on enterprise", async () => {
    const key = (
      (await (
        await issue(cookie, { tier: "enterprise", issued_to_org: "Ent Co", contact_email: "e@x.example" })
      ).json()) as { license_key: string }
    ).license_key;
    const r = await SELF.fetch("https://license.test/admin/license/update", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ license_key: key, packs: [{ size: 10, qty: 1 }] }),
    });
    expect(r.status).toBe(400);
  });
});
