import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";
import { applySchema, resetDB, getTestEnv } from "./helpers";

beforeAll(async () => {
  await applySchema();
});
beforeEach(async () => {
  await resetDB();
});

const ADMIN_PW = "test-admin-secret"; // matches vitest.config.ts binding

// Extract the harmony_session cookie value from a Set-Cookie response header,
// formatted ready to send back as a Cookie request header.
function sessionCookie(res: Response): string {
  const raw =
    (typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie().join("; ")
      : res.headers.get("set-cookie")) ?? "";
  const m = raw.match(/harmony_session=([^;]+)/);
  if (!m) throw new Error("no session cookie in response: " + raw);
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

describe("admin console", () => {
  it("serves the admin page HTML unauthenticated", async () => {
    const res = await SELF.fetch("https://license.test/admin");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(await res.text()).toContain("Harmony License");
  });

  it("reports no admin session without a cookie", async () => {
    const res = await SELF.fetch("https://license.test/admin/session");
    expect(res.status).toBe(200);
    expect((await res.json()) as { admin: boolean }).toEqual({ admin: false });
  });

  it("rejects login with the wrong password", async () => {
    const res = await SELF.fetch("https://license.test/admin/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    });
    expect(res.status).toBe(401);
  });

  it("logs in with the admin secret and reports an admin session", async () => {
    const cookie = await adminLogin();
    const res = await SELF.fetch("https://license.test/admin/session", {
      headers: { cookie },
    });
    expect((await res.json()) as { admin: boolean }).toEqual({ admin: true });
  });

  it("issues a license via the session cookie (no x-admin-secret header)", async () => {
    const cookie = await adminLogin();
    const res = await SELF.fetch("https://license.test/admin/license", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        tier: "professional",
        pack_size: 50,
        issued_to_org: "Cookie Co",
        contact_email: "ops@cookie.example",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { license_key: string; pack_size: number };
    expect(body.license_key).toMatch(/^HRM-PRO-/);
    expect(body.pack_size).toBe(50);
  });

  it("issues an enterprise license", async () => {
    const cookie = await adminLogin();
    const res = await SELF.fetch("https://license.test/admin/license", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        tier: "enterprise",
        issued_to_org: "Big Corp",
        contact_email: "it@bigcorp.example",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { license_key: string; tier: string };
    expect(body.license_key).toMatch(/^HRM-ENT-/);
    expect(body.tier).toBe("enterprise");
  });

  it("lists issued licenses with an active-instance count", async () => {
    const cookie = await adminLogin();
    await SELF.fetch("https://license.test/admin/license", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ tier: "business", issued_to_org: "List Co", contact_email: "a@list.example" }),
    });
    const res = await SELF.fetch("https://license.test/admin/licenses", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { licenses: Array<{ issued_to_org: string; active_instances: number }> };
    const row = body.licenses.find((l) => l.issued_to_org === "List Co");
    expect(row).toBeTruthy();
    expect(row?.active_instances).toBe(0);
  });

  it("rejects the list endpoint without an admin session", async () => {
    const res = await SELF.fetch("https://license.test/admin/licenses");
    expect(res.status).toBe(401);
  });

  it("does NOT grant admin to a regular (non-admin) customer session", async () => {
    // Drive the customer magic-link flow to mint a non-admin session.
    const email = "customer@example.com";
    await SELF.fetch("https://license.test/auth/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const token = await getTestEnv()
      .DB.prepare("SELECT token FROM magic_links WHERE email = ?1 ORDER BY rowid DESC LIMIT 1")
      .bind(email)
      .first<{ token: string }>();
    expect(token?.token).toBeTruthy();

    const verifyRes = await SELF.fetch(
      "https://license.test/auth/verify?token=" + encodeURIComponent(token!.token),
    );
    expect(verifyRes.status).toBe(200);
    const customerCookie = sessionCookie(verifyRes);

    // A valid customer session must NOT pass the admin gate.
    const sess = await SELF.fetch("https://license.test/admin/session", {
      headers: { cookie: customerCookie },
    });
    expect((await sess.json()) as { admin: boolean }).toEqual({ admin: false });

    const issue = await SELF.fetch("https://license.test/admin/license", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: customerCookie },
      body: JSON.stringify({ tier: "business", issued_to_org: "Sneaky", contact_email: "s@x.example" }),
    });
    expect(issue.status).toBe(401);
  });
});
