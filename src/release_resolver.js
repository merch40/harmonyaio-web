// Signed update-channel resolver logic.
//
// Mirrors the verification contract of Harmony-AIO internal/updatechannel:
// a channel pointer is a JSON envelope {schema_version, payload, signatures}
// where payload is the base64url-encoded exact manifest bytes and every
// signature is RSA-PSS (PS256, salt length = hash length) over the SHA-256
// digest of those bytes. At least one signature must match a pinned key.
//
// This module is deliberately pure (no Worker bindings) so it can be unit
// tested outside the Workers runtime.

export const SCHEMA_VERSION = 1;
export const SUPPORTED_UPDATER_VERSION = 1;
export const MAX_ENVELOPE_BYTES = 512 * 1024;
export const MAX_PAYLOAD_BYTES = 256 * 1024;
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000;
export const MAX_MANIFEST_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class ResolverError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function decodeBase64Url(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ResolverError(502, "invalid base64url value");
  }
  let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4 !== 0) normalized += "=";
  let binary;
  try {
    binary = atob(normalized);
  } catch {
    throw new ResolverError(502, "invalid base64url value");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function pemToDer(pem) {
  const body = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// importPinnedKeys turns {keyId: pemString} into {keyId: CryptoKey}.
export async function importPinnedKeys(pinnedPems, subtle = crypto.subtle) {
  const keys = {};
  for (const [keyId, pem] of Object.entries(pinnedPems)) {
    keys[keyId] = await subtle.importKey(
      "spki",
      pemToDer(pem),
      { name: "RSA-PSS", hash: "SHA-256" },
      false,
      ["verify"],
    );
  }
  return keys;
}

function validateManifest(manifest, nowMs) {
  if (manifest.schema_version !== SCHEMA_VERSION) {
    throw new ResolverError(502, "unsupported manifest schema_version");
  }
  if (!NAME_PATTERN.test(manifest.channel || "")) {
    throw new ResolverError(502, "invalid manifest channel");
  }
  if (!Number.isInteger(manifest.sequence) || manifest.sequence <= 0) {
    throw new ResolverError(502, "invalid manifest sequence");
  }
  if (!NAME_PATTERN.test(manifest.release_id || "")) {
    throw new ResolverError(502, "invalid manifest release_id");
  }
  if (!VERSION_PATTERN.test(manifest.version || "")) {
    throw new ResolverError(502, "invalid manifest version");
  }
  if (!COMMIT_PATTERN.test(manifest.commit || "")) {
    throw new ResolverError(502, "invalid manifest commit");
  }
  if (manifest.intent !== "upgrade" && manifest.intent !== "rollback") {
    throw new ResolverError(502, "invalid manifest intent");
  }
  const rollbackFrom = manifest.rollback_from_sequence ?? 0;
  if (manifest.intent === "rollback") {
    if (!Number.isInteger(rollbackFrom) || rollbackFrom <= 0 || rollbackFrom >= manifest.sequence) {
      throw new ResolverError(502, "invalid manifest rollback_from_sequence");
    }
  } else if (rollbackFrom !== 0) {
    throw new ResolverError(502, "upgrade manifest cannot set rollback_from_sequence");
  }
  if (!Number.isInteger(manifest.minimum_updater_version) ||
      manifest.minimum_updater_version <= 0 ||
      manifest.minimum_updater_version > SUPPORTED_UPDATER_VERSION) {
    throw new ResolverError(502, "unsupported manifest minimum_updater_version");
  }
  const published = Date.parse(manifest.published_at || "");
  const expires = Date.parse(manifest.expires_at || "");
  if (!Number.isFinite(published) || !Number.isFinite(expires)) {
    throw new ResolverError(502, "invalid manifest timestamps");
  }
  if (expires <= published || expires - published > MAX_MANIFEST_LIFETIME_MS) {
    throw new ResolverError(502, "invalid manifest lifetime");
  }
  if (published > nowMs + MAX_CLOCK_SKEW_MS) {
    throw new ResolverError(502, "manifest published in the future");
  }
  if (nowMs >= expires) {
    throw new ResolverError(502, "channel manifest has expired");
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0 || manifest.artifacts.length > 16) {
    throw new ResolverError(502, "invalid manifest artifacts");
  }
  const prefix = `v1/releases/${manifest.release_id}/`;
  const seenIds = new Set();
  for (const artifact of manifest.artifacts) {
    if (!NAME_PATTERN.test(artifact.id || "")) {
      throw new ResolverError(502, "invalid artifact id");
    }
    if (seenIds.has(artifact.id)) {
      throw new ResolverError(502, "duplicate artifact id");
    }
    seenIds.add(artifact.id);
    // Path confinement matches internal/updatechannel: exactly the immutable
    // release prefix plus one clean, name-safe filename. Every segment is
    // checked so encoded traversal (%2e%2e), dot segments, empty segments,
    // and shell-hostile filename characters are all rejected.
    if (typeof artifact.path !== "string" || !artifact.path.startsWith(prefix) || artifact.path.includes("\\")) {
      throw new ResolverError(502, "invalid artifact path");
    }
    const remainder = artifact.path.slice(prefix.length);
    if (remainder.includes("/") || !NAME_PATTERN.test(remainder)) {
      throw new ResolverError(502, "invalid artifact path");
    }
    if (!SHA256_PATTERN.test(artifact.sha256 || "")) {
      throw new ResolverError(502, "invalid artifact sha256");
    }
    if (!Number.isInteger(artifact.size) || artifact.size <= 0 || artifact.size > MAX_ARTIFACT_BYTES) {
      throw new ResolverError(502, "invalid artifact size");
    }
  }
}

// verifyChannelEnvelope parses and verifies a channel pointer. Returns
// {manifest, keyId} or throws ResolverError. Unknown key IDs and unknown
// algorithms never weaken the requirement that one pinned key must match.
export async function verifyChannelEnvelope(envelopeText, pinnedKeys, nowMs, subtle = crypto.subtle) {
  if (typeof envelopeText !== "string" || envelopeText.length === 0 || envelopeText.length > MAX_ENVELOPE_BYTES) {
    throw new ResolverError(502, "channel envelope size is outside the allowed range");
  }
  // The length check above counts UTF-16 code units; re-check real bytes so
  // multibyte content cannot exceed the cap threefold.
  if (new TextEncoder().encode(envelopeText).length > MAX_ENVELOPE_BYTES) {
    throw new ResolverError(502, "channel envelope size is outside the allowed range");
  }
  let envelope;
  try {
    envelope = JSON.parse(envelopeText);
  } catch {
    throw new ResolverError(502, "channel envelope is not valid JSON");
  }
  if (envelope.schema_version !== SCHEMA_VERSION) {
    throw new ResolverError(502, "unsupported envelope schema_version");
  }
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length === 0 || envelope.signatures.length > 8) {
    throw new ResolverError(502, "envelope must contain between 1 and 8 signatures");
  }

  const payloadBytes = decodeBase64Url(envelope.payload);
  if (payloadBytes.length === 0 || payloadBytes.length > MAX_PAYLOAD_BYTES) {
    throw new ResolverError(502, "manifest payload size is outside the allowed range");
  }
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    throw new ResolverError(502, "manifest payload is not valid JSON");
  }
  validateManifest(manifest, nowMs);

  for (const signature of envelope.signatures) {
    if (signature.algorithm !== "PS256" || !NAME_PATTERN.test(signature.key_id || "")) {
      continue;
    }
    const key = pinnedKeys[signature.key_id];
    if (!key) continue;
    let signatureBytes;
    try {
      signatureBytes = decodeBase64Url(signature.value);
    } catch {
      continue;
    }
    if (signatureBytes.length === 0 || signatureBytes.length > 1024) continue;
    const ok = await subtle.verify(
      { name: "RSA-PSS", saltLength: 32 },
      key,
      signatureBytes,
      payloadBytes,
    );
    if (ok) {
      return { manifest, keyId: signature.key_id };
    }
  }
  throw new ResolverError(502, "no signature matched a pinned PS256 public key");
}

// selectArtifact picks the server artifact for a target OS.
export function selectArtifact(manifest, os) {
  const format = os === "windows" ? "zip" : "tar.gz";
  const artifact = manifest.artifacts.find(
    (candidate) => candidate.os === os && candidate.arch === "amd64" && candidate.format === format,
  );
  if (!artifact) {
    throw new ResolverError(404, `channel release has no ${os}/amd64 server artifact`);
  }
  return artifact;
}

// resolveLatest is the full resolver pipeline against already-fetched
// channel bytes. index.js wires it to fetch() and the pinned key set.
// expectedChannel binds the signed manifest to the channel that was
// requested: a validly signed envelope copied from another channel's
// pointer (cross-channel substitution by whoever can write the bucket)
// is rejected, matching the installed updater's behavior.
export async function resolveLatest({ envelopeText, os, pinnedKeys, updateOrigin, expectedChannel, nowMs, subtle }) {
  const { manifest, keyId } = await verifyChannelEnvelope(envelopeText, pinnedKeys, nowMs, subtle);
  if (expectedChannel && manifest.channel !== expectedChannel) {
    throw new ResolverError(502, "signed manifest channel does not match the requested channel");
  }
  const artifact = selectArtifact(manifest, os);
  return {
    schema: 1,
    channel: manifest.channel,
    version: manifest.version,
    release_id: manifest.release_id,
    sequence: manifest.sequence,
    published_at: manifest.published_at,
    expires_at: manifest.expires_at,
    intent: manifest.intent,
    os: artifact.os,
    arch: artifact.arch,
    format: artifact.format,
    url: `${updateOrigin}/${artifact.path}`,
    sha256: artifact.sha256,
    size: artifact.size,
    key_id: keyId,
  };
}
