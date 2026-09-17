import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { applySchema, resetDB, getTestEnv } from "./helpers";
import { issueSessionCookie } from "../src/magic_link";

beforeAll(applySchema);
beforeEach(resetDB);

const key = "HRM-BUS-AUDI-TEST-ABCD";
const headers = { "content-type": "application/json", "x-admin-secret": "test-admin-secret",
  "cf-connecting-ip": "192.0.2.40", "user-agent": "Audit test client" };
async function post(path: string, body: unknown, extra: Record<string, string> = headers) {
  return SELF.fetch("https://license.test" + path, { method: "POST", headers: extra, body: JSON.stringify(body) });
}
async function create() {
  const res = await post("/admin/license", { license_key: key, tier: "business", issued_to_org: "Audit Co",
    contact_email: "audit@example.com", notes: "Initial order" });
  expect(res.status).toBe(200);
}
interface Event {
  id: number; action: string; outcome: string; actor: string; session_id: string | null;
  client_ip: string; license_hint: string | null;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
}
async function events() {
  const res = await SELF.fetch("https://license.test/admin/audit", { headers });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return (await res.json()) as { events: Event[]; next_cursor: number | null };
}

describe("admin audit trail", () => {
  it("records before and after values for every admin license mutation and survives removal", async () => {
    await create();
    expect((await post("/admin/license/update", { license_key: key, notes: "Expanded order", packs: [{ size: 20, qty: 2 }] })).status).toBe(200);
    // Seed a binding without exercising unrelated customer activation telemetry.
    await getTestEnv().DB.prepare("INSERT INTO instances (license_key, instance_id, activated_at, last_seen_at) VALUES (?1, 'server-1', '2026-09-17', '2026-09-17')").bind(key).run();
    const release = await post("/admin/license/force-release", { license_key: key });
    expect((await release.json()) as { released: number }).toMatchObject({ released: 1 });
    expect((await post("/admin/license/revoke", { license_key: key, reason: "Cancelled order" })).status).toBe(200);
    expect((await post("/admin/license/remove", { license_key: key })).status).toBe(200);
    const all = (await events()).events.reverse();
    expect(all.map(e => e.action)).toEqual(["license.created", "license.updated", "license.released", "license.revoked", "license.removed"]);
    expect(all[0].before).toBeNull();
    expect(all[0].after).toMatchObject({ organization: "Audit Co", notes: "Initial order" });
    expect(all[1].before).toMatchObject({ notes: "Initial order", packs: [] });
    expect(all[1].after).toMatchObject({ notes: "Expanded order", packs: [{ size: 20, qty: 2 }], pack_endpoints: 40 });
    expect(all[2].before?.active_bindings).toBe(1);
    expect(all[2].after?.active_bindings).toBe(0);
    expect(all[3].after?.revoked_reason).toBe("Cancelled order");
    expect(all[4].before?.organization).toBe("Audit Co");
    expect(all[4].after).toBeNull();
    expect(all.every(e => e.actor === "shared-admin-api" && e.client_ip === "192.0.2.40")).toBe(true);
    expect(all.every(e => e.license_hint === "…ABCD")).toBe(true);
    expect(JSON.stringify(all)).not.toContain(key);
    expect(await getTestEnv().DB.prepare("SELECT COUNT(*) AS n FROM admin_audit_staging").first("n")).toBe(0);
  });

  it("denies audit access to anonymous and customer sessions and exposes no mutation API", async () => {
    expect((await SELF.fetch("https://license.test/admin/audit")).status).toBe(401);
    const customer = await issueSessionCookie("customer@example.com", getTestEnv());
    expect((await SELF.fetch("https://license.test/admin/audit", { headers: { cookie: customer.split(";")[0] } })).status).toBe(401);
    expect((await post("/admin/audit", {})).status).toBe(404);
  });

  it("correlates login, browser changes and logout without storing credentials", async () => {
    const bad = await post("/admin/auth", { password: "wrong-password-DO-NOT-LOG" });
    expect(bad.status).toBe(401);
    const login = await post("/admin/auth", { password: "test-admin-secret" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const browserHeaders = { "content-type": "application/json", cookie };
    const issued = await post("/admin/license", { tier: "enterprise", issued_to_org: "Browser Co", contact_email: "b@example.com" }, browserHeaders);
    expect(issued.status).toBe(200);
    expect((await post("/admin/logout", {}, browserHeaders)).status).toBe(200);
    const all = (await events()).events.reverse();
    expect(all[0]).toMatchObject({ action: "admin.login", outcome: "denied", actor: "unauthenticated" });
    expect(all[1].session_id).toBeTruthy();
    expect(all.slice(1).map(e => e.session_id)).toEqual(Array(3).fill(all[1].session_id));
    expect(all.slice(1).every(e => e.actor === "shared-admin-browser")).toBe(true);
    const stored = JSON.stringify((await getTestEnv().DB.prepare("SELECT * FROM admin_audit").all()).results);
    expect(stored).not.toContain("test-admin-secret");
    expect(stored).not.toContain("wrong-password-DO-NOT-LOG");
    expect(stored).not.toContain(cookie.slice("harmony_session=".length));
  });

  it("assigns different identifiers to separate logins", async () => {
    await post("/admin/auth", { password: "test-admin-secret" });
    await post("/admin/auth", { password: "test-admin-secret" });
    const all = (await events()).events;
    expect(all[0].session_id).not.toBe(all[1].session_id);
  });

  it("logs a throttled login without trusting forwarded source headers", async () => {
    for (let i = 0; i < 10; i++) await post("/admin/auth", { password: "bad" });
    expect((await post("/admin/auth", { password: "bad" })).status).toBe(429);
    expect((await events()).events[0].outcome).toBe("rate_limited");
    await post("/admin/auth", { password: "bad" }, { "content-type": "application/json", "x-forwarded-for": "spoofed" });
    expect((await events()).events[0].client_ip).toBe("unknown");
  });

  it("rolls back creation, edits and removal if the audit insert fails", async () => {
    await create();
    await getTestEnv().DB.prepare("INSERT INTO instances (license_key, instance_id, activated_at, last_seen_at) VALUES (?1, 'server-1', '2026-09-17', '2026-09-17')").bind(key).run();
    await getTestEnv().DB.prepare("CREATE TRIGGER reject_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END").run();
    try {
      expect((await post("/admin/license", { tier: "business", issued_to_org: "Should roll back", contact_email: "x@example.com" })).status).toBe(500);
      expect((await post("/admin/license/update", { license_key: key, notes: "Should roll back" })).status).toBe(500);
      expect((await post("/admin/license/remove", { license_key: key })).status).toBe(500);
      const db = getTestEnv().DB;
      expect(await db.prepare("SELECT COUNT(*) AS n FROM licenses").first("n")).toBe(1);
      expect(await db.prepare("SELECT notes FROM licenses WHERE license_key = ?1").bind(key).first("notes")).toBe("Initial order");
      expect(await db.prepare("SELECT COUNT(*) AS n FROM instances").first("n")).toBe(1);
      expect(await db.prepare("SELECT COUNT(*) AS n FROM admin_audit").first("n")).toBe(1);
      expect(await db.prepare("SELECT COUNT(*) AS n FROM admin_audit_staging").first("n")).toBe(0);
    } finally {
      await getTestEnv().DB.prepare("DROP TRIGGER reject_audit").run();
    }
  });

  it("paginates older activity without duplicates and validates cursors", async () => {
    const db = getTestEnv().DB;
    await db.batch(Array.from({ length: 55 }, (_, i) => db.prepare(`INSERT INTO admin_audit
      (event_id, occurred_at, action, outcome, actor, client_ip, user_agent)
      VALUES (?1, '2026-09-17', 'admin.login', 'denied', 'unauthenticated', 'unknown', 'test')`).bind("fixture-" + i)));
    const first = await events();
    expect(first.events.length).toBe(50);
    expect(first.next_cursor).toBeTruthy();
    const second = await SELF.fetch("https://license.test/admin/audit?before=" + first.next_cursor, { headers });
    const page = (await second.json()) as { events: Event[]; next_cursor: number | null };
    expect(page.events.length).toBe(5);
    expect(page.next_cursor).toBeNull();
    expect(new Set([...first.events, ...page.events].map(e => e.id)).size).toBe(55);
    expect((await SELF.fetch("https://license.test/admin/audit?before=nope", { headers })).status).toBe(400);
  });
});
