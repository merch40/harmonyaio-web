import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";
import { applySchema, insertProLicense, resetDB, getTestEnv } from "./helpers";

beforeAll(async () => {
  await applySchema();
});
beforeEach(async () => {
  await resetDB();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`https://license.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /release", () => {
  it("releases an active binding and is idempotent", async () => {
    await insertProLicense("HRM-PRO-RLSE-0001-AAAA");
    await post("/activate", { license_key: "HRM-PRO-RLSE-0001-AAAA", instance_id: "i1" });
    const a = await post("/release", { license_key: "HRM-PRO-RLSE-0001-AAAA", instance_id: "i1" });
    expect(a.status).toBe(200);
    const b = await post("/release", { license_key: "HRM-PRO-RLSE-0001-AAAA", instance_id: "i1" });
    expect(b.status).toBe(200);
  });

  it("ignores releases for unknown instances (idempotent)", async () => {
    await insertProLicense("HRM-PRO-RLSE-0002-AAAA");
    const res = await post("/release", { license_key: "HRM-PRO-RLSE-0002-AAAA", instance_id: "ghost" });
    expect(res.status).toBe(200);
  });
});

describe("POST /force-release", () => {
  it("requires a session cookie", async () => {
    const res = await post("/force-release", { license_key: "HRM-X", instance_id: "i1" });
    expect(res.status).toBe(401);
  });

  it("respects the 30-day cooldown", async () => {
    await insertProLicense("HRM-PRO-FRCE-0001-AAAA");
    await post("/activate", { license_key: "HRM-PRO-FRCE-0001-AAAA", instance_id: "i1" });

    // Seed cooldown 1 day ago to simulate recent force-release.
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    const e = getTestEnv();
    await e.DB.prepare(
      "INSERT INTO release_cooldowns (license_key, last_force_release_at) VALUES (?1, ?2)",
    )
      .bind("HRM-PRO-FRCE-0001-AAAA", oneDayAgo)
      .run();

    // Mint a session cookie (bypass magic-link to keep this test fast).
    const cookie = await mintCookie("owner@example.com");

    const res = await SELF.fetch("https://license.test/force-release", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ license_key: "HRM-PRO-FRCE-0001-AAAA", instance_id: "i1" }),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; next_allowed_at?: string } };
    expect(body.error.code).toBe("force_release_cooldown");
    expect(body.error.next_allowed_at).toBeTruthy();
  });
});

// Mint a session cookie using the same algorithm as src/magic_link.ts.
async function mintCookie(email: string): Promise<string> {
  const e = getTestEnv();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const json = JSON.stringify({ email, exp });
  const body = b64url(new TextEncoder().encode(json));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(e.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const value = `${body}.${b64url(new Uint8Array(sig))}`;
  return `harmony_session=${value}`;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
