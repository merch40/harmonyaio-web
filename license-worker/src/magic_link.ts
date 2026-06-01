import { WorkerError, badRequest, unauthorized } from "./errors";
import { jsonResponse, safeJSON } from "./activate";
import { nowISO } from "./db";
import type { Env } from "./types";

const SESSION_TTL_HOURS = 24;
const MAGIC_LINK_TTL_MINUTES = 15;
const SESSION_COOKIE = "harmony_session";

export interface Session {
  email: string;
  exp: number; // unix seconds
  admin?: boolean;
}

// ---------------- request flow ----------------

export async function handleAuthRequest(req: Request, env: Env): Promise<Response> {
  const body = (await safeJSON(req)) as { email?: string } | null;
  const email = body?.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw badRequest("email required");
  }

  const token = randomToken();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

  await env.DB.prepare(
    "INSERT INTO magic_links (token, email, expires_at) VALUES (?1, ?2, ?3)",
  )
    .bind(token, email, expiresAt)
    .run();

  // Brevo integration deferred per §17. Log so dev users can copy the link.
  const link = `https://license.harmonyaio.com/auth/verify?token=${token}`;
  console.log(`[magic-link] email=${email} link=${link} expires_at=${expiresAt}`);

  return jsonResponse(200, { ok: true });
}

// ---------------- verify flow ----------------

export async function handleAuthVerify(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) throw badRequest("missing token");

  const row = await env.DB.prepare(
    "SELECT email, expires_at, consumed_at FROM magic_links WHERE token = ?1",
  )
    .bind(token)
    .first<{ email: string; expires_at: string; consumed_at: string | null }>();

  if (!row) throw unauthorized("invalid token");
  if (row.consumed_at) throw unauthorized("token already used");
  if (row.expires_at < new Date().toISOString()) throw unauthorized("token expired");

  await env.DB.prepare("UPDATE magic_links SET consumed_at = ?2 WHERE token = ?1")
    .bind(token, nowISO())
    .run();

  const cookie = await issueSessionCookie(row.email, env);
  return new Response(JSON.stringify({ ok: true, email: row.email }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": cookie,
    },
  });
}

// ---------------- session signing ----------------

export async function issueSessionCookie(email: string, env: Env, admin = false): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_HOURS * 3600;
  const payload: Session = admin ? { email, exp, admin: true } : { email, exp };
  const value = await signSession(payload, env.SESSION_SECRET);
  // SameSite=Lax so the magic-link redirect from email carries the cookie.
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_HOURS * 3600}`;
}

// clearSessionCookie expires the session cookie (used by admin logout).
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// getSession returns the verified session or null (non-throwing) — for endpoints
// that branch on auth state rather than rejecting outright (e.g. /admin/session).
export async function getSession(req: Request, env: Env): Promise<Session | null> {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const match = cookieHeader.split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!match) return null;
  const value = match.slice(SESSION_COOKIE.length + 1);

  const session = await verifySession(value, env.SESSION_SECRET);
  if (!session) return null;
  if (session.exp < Math.floor(Date.now() / 1000)) return null;
  return session;
}

export async function requireSession(req: Request, env: Env): Promise<Session> {
  const session = await getSession(req, env);
  if (!session) throw unauthorized("invalid session");
  return session;
}

async function signSession(payload: Session, secret: string): Promise<string> {
  const json = JSON.stringify(payload);
  const body = b64urlEncode(new TextEncoder().encode(json));
  const sig = await hmacSHA256(secret, body);
  return `${body}.${sig}`;
}

async function verifySession(token: string, secret: string): Promise<Session | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacSHA256(secret, body);
  if (!constantTimeEq(sig, expected)) return null;
  try {
    const json = new TextDecoder().decode(b64urlDecode(body));
    return JSON.parse(json) as Session;
  } catch {
    return null;
  }
}

async function hmacSHA256(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64urlEncode(new Uint8Array(sig));
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64urlEncode(bytes);
}
