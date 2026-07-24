// Unit tests for the signed update-channel resolver.
//
// These generate a throwaway RSA-PSS keypair, sign manifests the same way
// the Harmony publisher does (PS256 over the exact payload bytes,
// base64url envelope), and drive the pure resolver module. Node's WebCrypto
// matches the Workers runtime for everything used here.

import { describe, it, expect, beforeAll } from "vitest";
import {
  decodeBase64Url,
  importPinnedKeys,
  verifyChannelEnvelope,
  selectArtifact,
  resolveLatest,
  ResolverError,
} from "../src/release_resolver.js";
import { PINNED_UPDATE_KEYS } from "../src/update_trust.js";

const KEY_ID = "test-key-2026";
const NOW = Date.parse("2026-07-24T12:00:00Z");

let keyPair;
let pinnedKeys;

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function manifestFixture(overrides = {}) {
  const releaseId = overrides.release_id || "dogfood-1753000000000-abcdef123456";
  return {
    schema_version: 1,
    channel: "dogfood",
    sequence: 1753000000000,
    release_id: releaseId,
    version: "0.1.0-dogfood.6",
    commit: "abcdef1234567890abcdef1234567890abcdef12",
    published_at: "2026-07-24T10:00:00Z",
    expires_at: "2026-07-27T10:00:00Z",
    intent: "upgrade",
    minimum_updater_version: 1,
    artifacts: [
      {
        id: "server-windows-amd64",
        os: "windows",
        arch: "amd64",
        format: "zip",
        path: `v1/releases/${releaseId}/harmony-server-v0.1.0-dogfood.6-windows-amd64.zip`,
        sha256: "a".repeat(64),
        size: 52428800,
      },
      {
        id: "server-linux-amd64",
        os: "linux",
        arch: "amd64",
        format: "tar.gz",
        path: `v1/releases/${releaseId}/harmony-server-v0.1.0-dogfood.6-linux-amd64.tar.gz`,
        sha256: "b".repeat(64),
        size: 51380224,
      },
    ],
    ...overrides,
  };
}

async function signedEnvelope(manifest, { keyId = KEY_ID, tamper = false } = {}) {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const signature = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 },
    keyPair.privateKey,
    payloadBytes,
  );
  const payload = tamper
    ? b64url(new TextEncoder().encode(JSON.stringify({ ...manifest, version: "9.9.9-evil" })))
    : b64url(payloadBytes);
  return JSON.stringify({
    schema_version: 1,
    payload,
    signatures: [{ key_id: keyId, algorithm: "PS256", value: b64url(new Uint8Array(signature)) }],
  });
}

beforeAll(async () => {
  keyPair = await crypto.subtle.generateKey(
    {
      name: "RSA-PSS",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const spki = await crypto.subtle.exportKey("spki", keyPair.publicKey);
  const pem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(spki).toString("base64")}\n-----END PUBLIC KEY-----`;
  pinnedKeys = await importPinnedKeys({ [KEY_ID]: pem });
});

describe("decodeBase64Url", () => {
  it("decodes unpadded base64url", () => {
    const bytes = decodeBase64Url(b64url(new TextEncoder().encode("harmony")));
    expect(new TextDecoder().decode(bytes)).toBe("harmony");
  });
  it("rejects garbage", () => {
    expect(() => decodeBase64Url("!!not-base64!!")).toThrow(ResolverError);
  });
});

describe("production pin", () => {
  it("imports the committed pinned keys", async () => {
    const keys = await importPinnedKeys(PINNED_UPDATE_KEYS);
    expect(Object.keys(keys)).toContain("dogfood-paus-2026-07-f0c52f6c");
  });
});

describe("verifyChannelEnvelope", () => {
  it("accepts a correctly signed, fresh manifest", async () => {
    const envelope = await signedEnvelope(manifestFixture());
    const { manifest, keyId } = await verifyChannelEnvelope(envelope, pinnedKeys, NOW);
    expect(manifest.version).toBe("0.1.0-dogfood.6");
    expect(keyId).toBe(KEY_ID);
  });

  it("rejects a tampered payload", async () => {
    const envelope = await signedEnvelope(manifestFixture(), { tamper: true });
    await expect(verifyChannelEnvelope(envelope, pinnedKeys, NOW)).rejects.toThrow(
      /no signature matched/,
    );
  });

  it("rejects a signature from an unpinned key", async () => {
    const envelope = await signedEnvelope(manifestFixture(), { keyId: "rogue-key" });
    await expect(verifyChannelEnvelope(envelope, pinnedKeys, NOW)).rejects.toThrow(
      /no signature matched/,
    );
  });

  it("rejects an expired manifest", async () => {
    const envelope = await signedEnvelope(manifestFixture());
    const afterExpiry = Date.parse("2026-07-28T10:00:01Z");
    await expect(verifyChannelEnvelope(envelope, pinnedKeys, afterExpiry)).rejects.toThrow(
      /expired/,
    );
  });

  it("rejects a manifest published too far in the future", async () => {
    const envelope = await signedEnvelope(
      manifestFixture({ published_at: "2026-07-24T13:00:00Z", expires_at: "2026-07-27T13:00:00Z" }),
    );
    await expect(verifyChannelEnvelope(envelope, pinnedKeys, NOW)).rejects.toThrow(/future/);
  });

  it("rejects artifacts outside the release's immutable path", async () => {
    const manifest = manifestFixture();
    manifest.artifacts[0].path = "v1/channels/dogfood.json";
    const envelope = await signedEnvelope(manifest);
    await expect(verifyChannelEnvelope(envelope, pinnedKeys, NOW)).rejects.toThrow(
      /artifact path/,
    );
  });

  it("rejects a non-JSON envelope", async () => {
    await expect(verifyChannelEnvelope("not json", pinnedKeys, NOW)).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("rejects artifact paths with subdirectories or encoded traversal", async () => {
    for (const badPath of [
      "v1/releases/dogfood-1753000000000-abcdef123456/sub/evil.tar.gz",
      "v1/releases/dogfood-1753000000000-abcdef123456/%2e%2e%2fevil.tar.gz",
      "v1/releases/dogfood-1753000000000-abcdef123456/",
      "v1/releases/dogfood-1753000000000-abcdef123456/a b.tar.gz",
    ]) {
      const manifest = manifestFixture();
      manifest.artifacts[0].path = badPath;
      const envelope = await signedEnvelope(manifest);
      await expect(verifyChannelEnvelope(envelope, pinnedKeys, NOW), badPath).rejects.toThrow(
        /artifact path/,
      );
    }
  });

  it("rejects invalid intent, duplicate ids, oversize artifacts, and unsupported updater versions", async () => {
    const cases = [
      [manifestFixture({ intent: "sideload" }), /intent/],
      [manifestFixture({ minimum_updater_version: 2 }), /minimum_updater_version/],
      [manifestFixture({ commit: "NOT-HEX" }), /commit/],
    ];
    const dupIds = manifestFixture();
    dupIds.artifacts[1].id = dupIds.artifacts[0].id;
    cases.push([dupIds, /duplicate artifact id/]);
    const oversize = manifestFixture();
    oversize.artifacts[0].size = 513 * 1024 * 1024;
    cases.push([oversize, /artifact size/]);
    for (const [manifest, pattern] of cases) {
      const envelope = await signedEnvelope(manifest);
      await expect(verifyChannelEnvelope(envelope, pinnedKeys, NOW)).rejects.toThrow(pattern);
    }
  });
});

describe("selectArtifact", () => {
  it("selects the tarball for linux and the zip for windows", () => {
    const manifest = manifestFixture();
    expect(selectArtifact(manifest, "linux").format).toBe("tar.gz");
    expect(selectArtifact(manifest, "windows").format).toBe("zip");
  });

  it("404s when the OS has no artifact", () => {
    const manifest = manifestFixture();
    manifest.artifacts = manifest.artifacts.filter((a) => a.os !== "linux");
    try {
      selectArtifact(manifest, "linux");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ResolverError);
      expect(err.status).toBe(404);
    }
  });
});

describe("resolveLatest", () => {
  it("returns the full install contract for a target OS", async () => {
    const envelopeText = await signedEnvelope(manifestFixture());
    const result = await resolveLatest({
      envelopeText,
      os: "linux",
      pinnedKeys,
      updateOrigin: "https://updates.harmonyaio.com",
      nowMs: NOW,
    });
    expect(result).toMatchObject({
      schema: 1,
      channel: "dogfood",
      version: "0.1.0-dogfood.6",
      os: "linux",
      arch: "amd64",
      format: "tar.gz",
      sha256: "b".repeat(64),
      key_id: KEY_ID,
    });
    expect(result.url).toBe(
      "https://updates.harmonyaio.com/v1/releases/dogfood-1753000000000-abcdef123456/harmony-server-v0.1.0-dogfood.6-linux-amd64.tar.gz",
    );
  });

  it("rejects a validly signed manifest served under the wrong channel", async () => {
    const envelopeText = await signedEnvelope(manifestFixture());
    await expect(
      resolveLatest({
        envelopeText,
        os: "linux",
        pinnedKeys,
        updateOrigin: "https://updates.harmonyaio.com",
        expectedChannel: "stable",
        nowMs: NOW,
      }),
    ).rejects.toThrow(/does not match the requested channel/);
  });
});
