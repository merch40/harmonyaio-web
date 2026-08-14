// Unit tests for the signup health probe. The probe takes an injectable
// fetch so no network is involved.

import { describe, it, expect } from "vitest";
import { probeSignup } from "../src/signup_health.js";

const ENV = { BREVO_API_KEY: "key", BREVO_LIST_ID: "6" };

function fetchReturning(status) {
  return async () => new Response("{}", { status });
}

describe("probeSignup", () => {
  it("fails with not_configured when either env var is missing", async () => {
    expect(await probeSignup({}, fetchReturning(200))).toEqual({ ok: false, reason: "not_configured" });
    expect(await probeSignup({ BREVO_API_KEY: "key" }, fetchReturning(200))).toEqual({ ok: false, reason: "not_configured" });
    expect(await probeSignup({ BREVO_LIST_ID: "6" }, fetchReturning(200))).toEqual({ ok: false, reason: "not_configured" });
  });

  it("fails with bad_list_id for a non-numeric list id", async () => {
    // "#6" is what the Brevo UI displays; only "6" is valid.
    const env = { BREVO_API_KEY: "key", BREVO_LIST_ID: "#6" };
    expect(await probeSignup(env, fetchReturning(200))).toEqual({ ok: false, reason: "bad_list_id" });
  });

  it("passes when Brevo accepts the key and list", async () => {
    let requested;
    const fetchImpl = async (url, init) => {
      requested = { url, headers: init.headers };
      return new Response("{}", { status: 200 });
    };
    expect(await probeSignup(ENV, fetchImpl)).toEqual({ ok: true });
    expect(requested.url).toBe("https://api.brevo.com/v3/contacts/lists/6");
    expect(requested.headers["api-key"]).toBe("key");
  });

  it("maps auth failures (deactivated/revoked key) to brevo_auth", async () => {
    expect(await probeSignup(ENV, fetchReturning(401))).toEqual({ ok: false, reason: "brevo_auth" });
    expect(await probeSignup(ENV, fetchReturning(403))).toEqual({ ok: false, reason: "brevo_auth" });
  });

  it("maps a missing list to list_missing", async () => {
    expect(await probeSignup(ENV, fetchReturning(404))).toEqual({ ok: false, reason: "list_missing" });
  });

  it("maps other statuses and network errors distinctly", async () => {
    expect(await probeSignup(ENV, fetchReturning(500))).toEqual({ ok: false, reason: "brevo_status_500" });
    const throwing = async () => { throw new Error("boom"); };
    expect(await probeSignup(ENV, throwing)).toEqual({ ok: false, reason: "brevo_unreachable" });
  });
});
