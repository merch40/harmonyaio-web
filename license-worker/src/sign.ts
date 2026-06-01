import * as ed from "@noble/ed25519";
import { canonicalJSON } from "./canonical";
import type { License } from "./types";

// Decodes a base64-encoded ed25519 private key. Accepts both the 64-byte
// "standard" Go format (seed || pubkey) and the 32-byte raw seed.
export function decodePrivateKey(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (out.length === 64) return out.slice(0, 32); // strip pubkey suffix
  if (out.length === 32) return out;
  throw new Error(`signing key wrong length ${out.length}, want 32 or 64`);
}

export async function signLicense(license: License, privKeyB64: string): Promise<string> {
  const seed = decodePrivateKey(privKeyB64);
  const canon = canonicalJSON(license);
  const msg = new TextEncoder().encode(canon);
  const sig = await ed.signAsync(msg, seed);
  return base64Encode(sig);
}

function base64Encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
