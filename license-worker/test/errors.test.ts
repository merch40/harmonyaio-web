import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";
import { SELF } from "cloudflare:test";
import worker from "../src/index";
import { applySchema, resetDB, getTestEnv } from "./helpers";
import type { Env } from "../src/types";

beforeAll(async () => {
  await applySchema();
});
beforeEach(async () => {
  await resetDB();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const SENTINEL = "D1_ERROR: SENTINEL-internal-detail no such table: licenses_secret_v2";

// A D1 binding that throws on any use, so an unexpected failure is controlled
// and no test database row is touched.
function throwingDB(thrown: unknown): D1Database {
  return new Proxy({} as D1Database, {
    get() {
      throw thrown;
    },
  });
}

function envWithDB(db: D1Database): Env {
  return { ...(getTestEnv() as unknown as Env), DB: db };
}

function validateRequest(): Request {
  return new Request("https://license.test/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ license_key: "HRM-PRO-ERRS-0001-AAAA", instance_id: "i1" }),
  });
}

describe("unexpected exceptions", () => {
  it.each([
    ["an Error", new Error(SENTINEL)],
    ["a non-Error object with a message", { message: SENTINEL }],
    ["a string", SENTINEL],
  ])("returns a generic 500 for %s and logs the original server-side", async (_label, thrown) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await worker.fetch(validateRequest(), envWithDB(throwingDB(thrown)));

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/json");
    const text = await res.text();
    expect(text).not.toContain("SENTINEL");
    expect(text).not.toContain("licenses_secret_v2");
    expect(JSON.parse(text)).toEqual({ error: { code: "internal_error", reason: "internal error" } });
    expect(logged).toHaveBeenCalledWith("unhandled error", thrown);
  });
});

describe("intentional WorkerError responses keep their contract", () => {
  it("unknown route is 404 not_found with the route in the reason", async () => {
    const res = await SELF.fetch("https://license.test/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", reason: "no route for GET /does-not-exist" },
    });
  });

  it("missing fields on /validate is 400 bad_request", async () => {
    const res = await SELF.fetch("https://license.test/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "bad_request", reason: "license_key and instance_id are required" },
    });
  });

  it("admin issuance without the admin secret is 401 unauthorized", async () => {
    const res = await SELF.fetch("https://license.test/admin/license", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: "professional", issued_to_org: "Acme", contact_email: "a@acme.example" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", reason: "admin secret missing or wrong" },
    });
  });

  it("unknown license on /validate is 403 license_rejected", async () => {
    const res = await worker.fetch(validateRequest(), getTestEnv() as unknown as Env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "license_rejected", reason: "license key not found" },
    });
  });
});
