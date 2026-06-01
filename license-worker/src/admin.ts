import { WorkerError, badRequest, unauthorized } from "./errors";
import { jsonResponse, safeJSON } from "./activate";
import { nowISO } from "./db";
import { getSession, issueSessionCookie, clearSessionCookie } from "./magic_link";
import { checkRateLimit, clientIP } from "./rate_limit";
import type { Env, Tier } from "./types";

interface AdminIssueRequest {
  tier?: Tier;
  pack_size?: number;
  issued_to_org?: string;
  contact_email?: string;
  expires_at?: string | null;
  license_key?: string;
  notes?: string;
}

// Tiers that can be issued as a key. "home" is synthetic (no key needed).
const ISSUABLE_TIERS: Tier[] = ["business", "professional", "enterprise"];

// requireAdminAuth accepts EITHER the X-Admin-Secret header (server-to-server /
// CI / scripts) OR an admin session cookie (the /admin web UI). Throws 401
// otherwise. Keeping the header path means existing automation is unaffected.
export async function requireAdminAuth(req: Request, env: Env): Promise<void> {
  const provided = req.headers.get("x-admin-secret");
  if (provided && env.ADMIN_SECRET && secureEq(provided, env.ADMIN_SECRET)) return;
  const session = await getSession(req, env);
  if (session?.admin) return;
  throw unauthorized("admin secret missing or wrong");
}

export async function handleAdminIssue(req: Request, env: Env): Promise<Response> {
  await requireAdminAuth(req, env);

  const body = (await safeJSON(req)) as AdminIssueRequest | null;
  if (!body) throw badRequest("body required");
  if (!body.tier || !ISSUABLE_TIERS.includes(body.tier)) {
    throw badRequest("tier must be business, professional, or enterprise");
  }
  if (!body.issued_to_org || !body.contact_email) {
    throw badRequest("issued_to_org and contact_email are required");
  }

  let packSize = 1;
  if (body.tier === "professional") {
    packSize = body.pack_size ?? 10;
    if (![10, 20, 50, 100].includes(packSize)) {
      throw badRequest("pack_size must be one of 10, 20, 50, 100 for professional");
    }
  } else if (body.tier === "enterprise") {
    packSize = 0; // unlimited; pack_size is not meaningful for enterprise
  }

  const key = body.license_key ?? generateLicenseKey(body.tier);

  try {
    await env.DB.prepare(
      `INSERT INTO licenses (license_key, tier, pack_size, issued_to_org, contact_email, issued_at, expires_at, notes)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(
        key,
        body.tier,
        packSize,
        body.issued_to_org,
        body.contact_email,
        nowISO(),
        body.expires_at ?? null,
        body.notes ?? null,
      )
      .run();
  } catch (err) {
    throw new WorkerError(409, "bad_request", `failed to insert license: ${(err as Error).message}`);
  }

  return jsonResponse(200, { license_key: key, tier: body.tier, pack_size: packSize });
}

interface LicenseListRow {
  license_key: string;
  tier: string;
  pack_size: number;
  issued_to_org: string;
  contact_email: string;
  issued_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  active_instances: number;
}

// handleAdminLicensesList returns the most recent licenses plus a live count of
// active (un-released) instances per key, for the admin console table.
export async function handleAdminLicensesList(req: Request, env: Env): Promise<Response> {
  await requireAdminAuth(req, env);
  const { results } = await env.DB.prepare(
    `SELECT l.license_key, l.tier, l.pack_size, l.issued_to_org, l.contact_email,
            l.issued_at, l.expires_at, l.revoked_at,
            (SELECT COUNT(*) FROM instances i
              WHERE i.license_key = l.license_key AND i.released_at IS NULL) AS active_instances
       FROM licenses l
      ORDER BY l.issued_at DESC
      LIMIT 200`,
  ).all<LicenseListRow>();
  return jsonResponse(200, { licenses: results ?? [] });
}

// ---------------- admin session (password login) ----------------
//
// The web UI authenticates with the same ADMIN_SECRET, exchanged once for an
// HMAC session cookie (admin flag). The raw secret only crosses the wire at
// login; subsequent calls use the cookie. No new secret needs provisioning.

export async function handleAdminAuth(req: Request, env: Env): Promise<Response> {
  const ip = clientIP(req);
  if (!(await checkRateLimit(env.DB, `admin-auth:ip:${ip}`, 10))) {
    throw new WorkerError(429, "rate_limited", "too many login attempts, slow down");
  }
  const body = (await safeJSON(req)) as { password?: string } | null;
  const password = body?.password ?? "";
  if (!env.ADMIN_SECRET || !secureEq(password, env.ADMIN_SECRET)) {
    throw unauthorized("invalid admin password");
  }
  const cookie = await issueSessionCookie("admin", env, true);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": cookie },
  });
}

export async function handleAdminSession(req: Request, env: Env): Promise<Response> {
  const session = await getSession(req, env);
  return jsonResponse(200, { admin: session?.admin === true });
}

export async function handleAdminLogout(_req: Request, _env: Env): Promise<Response> {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": clearSessionCookie() },
  });
}

function generateLicenseKey(tier: Tier): string {
  const prefix = tier === "professional" ? "PRO" : tier === "enterprise" ? "ENT" : "BUS";
  return `HRM-${prefix}-${randGroup()}-${randGroup()}-${randGroup()}`;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, no padding
function randGroup(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 4; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function secureEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
