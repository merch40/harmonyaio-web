import { WorkerError, badRequest, unauthorized } from "./errors";
import { jsonResponse, safeJSON } from "./activate";
import { nowISO, getLicense, revokeLicense, deleteLicense, forceReleaseLicense } from "./db";
import { getSession, issueSessionCookie, clearSessionCookie } from "./magic_link";
import { checkRateLimit, clientIP } from "./rate_limit";
import type { Env, Pack, Tier } from "./types";

interface AdminIssueRequest {
  tier?: Tier;
  packs?: Pack[];
  issued_to_org?: string;
  contact_email?: string;
  company_id?: string;
  term?: "perpetual" | "monthly" | "annual";
  expires_at?: string | null; // explicit custom date; wins over term
  license_key?: string;
  notes?: string;
}

interface KeyRequest {
  license_key?: string;
  reason?: string;
}

interface AdminUpdateRequest {
  license_key?: string;
  issued_to_org?: string;
  contact_email?: string;
  company_id?: string;
  notes?: string;
  packs?: Pack[];
}

// Tiers that can be issued as a key. "home" is synthetic (no key needed).
const ISSUABLE_TIERS: Tier[] = ["business", "professional", "enterprise"];
const VALID_PACK_SIZES = [10, 20, 50, 100];

// normalizePacks validates an incoming pack list and merges duplicate sizes.
// Throws badRequest on an invalid size or quantity.
function normalizePacks(packs: Pack[] | undefined): Pack[] {
  if (!packs || packs.length === 0) return [];
  const bySize = new Map<number, number>();
  for (const p of packs) {
    const size = Number(p?.size);
    const qty = Number(p?.qty);
    if (!VALID_PACK_SIZES.includes(size)) {
      throw badRequest("pack size must be one of 10, 20, 50, 100");
    }
    if (!Number.isInteger(qty) || qty < 1) {
      throw badRequest("pack qty must be a positive integer");
    }
    bySize.set(size, (bySize.get(size) ?? 0) + qty);
  }
  return [...bySize.entries()].sort((a, b) => a[0] - b[0]).map(([size, qty]) => ({ size, qty }));
}

// requireAdminAuth accepts EITHER the X-Admin-Secret header (server-to-server /
// CI / billing automation) OR an admin session cookie (the /admin web UI).
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

  const packs = normalizePacks(body.packs);
  if (packs.length > 0 && body.tier === "enterprise") {
    throw badRequest("enterprise is unlimited; packs do not apply");
  }
  const packEndpointTotal = packs.reduce((sum, p) => sum + p.size * p.qty, 0);
  const packsJSON = packs.length > 0 ? JSON.stringify(packs) : null;

  const key = body.license_key ?? generateLicenseKey(body.tier);

  // Subscription term -> expiry (the period end). An explicit custom date wins;
  // otherwise compute from the term. Perpetual / unset leaves expiry null.
  let expiresAt: string | null = null;
  if (body.expires_at) {
    expiresAt = body.expires_at;
  } else if (body.term === "monthly") {
    expiresAt = addMonthsISO(1);
  } else if (body.term === "annual") {
    expiresAt = addMonthsISO(12);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO licenses (license_key, tier, pack_size, packs, issued_to_org, contact_email, company_id, issued_at, expires_at, notes)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
      .bind(
        key,
        body.tier,
        packEndpointTotal, // legacy pack_size column now holds total pack endpoints
        packsJSON,
        body.issued_to_org,
        body.contact_email,
        body.company_id?.trim() || null,
        nowISO(),
        expiresAt,
        body.notes ?? null,
      )
      .run();
  } catch (err) {
    throw new WorkerError(409, "bad_request", `failed to insert license: ${(err as Error).message}`);
  }

  return jsonResponse(200, {
    license_key: key,
    tier: body.tier,
    packs,
    pack_endpoints: packEndpointTotal,
    expires_at: expiresAt,
    company_id: body.company_id?.trim() || null,
  });
}

interface LicenseListRow {
  license_key: string;
  tier: string;
  pack_size: number;
  packs: string | null;
  issued_to_org: string;
  contact_email: string;
  company_id: string | null;
  notes: string | null;
  issued_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  active_instances: number;
}

// handleAdminLicensesList returns recent licenses plus a live count of active
// (un-released) instances per key, for the admin console table.
export async function handleAdminLicensesList(req: Request, env: Env): Promise<Response> {
  await requireAdminAuth(req, env);
  const { results } = await env.DB.prepare(
    `SELECT l.license_key, l.tier, l.pack_size, l.packs, l.issued_to_org, l.contact_email, l.company_id, l.notes,
            l.issued_at, l.expires_at, l.revoked_at,
            (SELECT COUNT(*) FROM instances i
              WHERE i.license_key = l.license_key AND i.released_at IS NULL) AS active_instances
       FROM licenses l
      ORDER BY l.issued_at DESC
      LIMIT 200`,
  ).all<LicenseListRow>();
  return jsonResponse(200, { licenses: results ?? [] });
}

// revoke + remove. Admin-gated, and the X-Admin-Secret header path makes them
// safe to call from a billing system (e.g. on subscription cancellation).
export async function handleAdminRevoke(req: Request, env: Env): Promise<Response> {
  await requireAdminAuth(req, env);
  const body = (await safeJSON(req)) as KeyRequest | null;
  const key = body?.license_key?.trim();
  if (!key) throw badRequest("license_key required");
  const existing = await getLicense(env.DB, key);
  if (!existing) throw new WorkerError(404, "not_found", "license not found");
  await revokeLicense(env.DB, key, body?.reason?.trim() || "revoked");
  return jsonResponse(200, { ok: true, license_key: key, revoked: true });
}

export async function handleAdminRemove(req: Request, env: Env): Promise<Response> {
  await requireAdminAuth(req, env);
  const body = (await safeJSON(req)) as KeyRequest | null;
  const key = body?.license_key?.trim();
  if (!key) throw badRequest("license_key required");
  const existing = await getLicense(env.DB, key);
  if (!existing) throw new WorkerError(404, "not_found", "license not found");
  await deleteLicense(env.DB, key);
  return jsonResponse(200, { ok: true, license_key: key, removed: true });
}

// handleAdminForceRelease unbinds a license from its current instance with no
// cooldown, so the key can re-activate on a new server. Admin-only.
export async function handleAdminForceRelease(req: Request, env: Env): Promise<Response> {
  await requireAdminAuth(req, env);
  const body = (await safeJSON(req)) as KeyRequest | null;
  const key = body?.license_key?.trim();
  if (!key) throw badRequest("license_key required");
  const existing = await getLicense(env.DB, key);
  if (!existing) throw new WorkerError(404, "not_found", "license not found");
  const released = await forceReleaseLicense(env.DB, key);
  return jsonResponse(200, { ok: true, license_key: key, released });
}

// handleAdminUpdate edits a license's metadata (org, contact, company id, notes)
// and its endpoint packs. PATCH semantics: only fields present in the body are
// changed. Editing packs is how an upsell ("add a 10-pack") lands on an existing
// key: the next /validate rebuilds the blob from this row, so the customer's
// server grows on its next re-check. Tier and expiry stay re-issue territory.
export async function handleAdminUpdate(req: Request, env: Env): Promise<Response> {
  await requireAdminAuth(req, env);
  const body = (await safeJSON(req)) as AdminUpdateRequest | null;
  const key = body?.license_key?.trim();
  if (!key) throw badRequest("license_key required");
  const existing = await getLicense(env.DB, key);
  if (!existing) throw new WorkerError(404, "not_found", "license not found");

  const org = body?.issued_to_org !== undefined ? body.issued_to_org.trim() : existing.issued_to_org;
  const email = body?.contact_email !== undefined ? body.contact_email.trim() : existing.contact_email;
  if (!org || !email) throw badRequest("organization and contact email are required");
  const companyId = body?.company_id !== undefined ? body.company_id.trim() || null : existing.company_id;
  const notes = body?.notes !== undefined ? body.notes.trim() || null : existing.notes;

  // Packs: when present, re-itemize and fold into the stored totals. Enterprise
  // is unlimited, so packs never apply there.
  let packsJSON = existing.packs;
  let packEndpointTotal = existing.pack_size;
  if (body?.packs !== undefined) {
    const packs = normalizePacks(body.packs);
    if (packs.length > 0 && existing.tier === "enterprise") {
      throw badRequest("enterprise is unlimited; packs do not apply");
    }
    packsJSON = packs.length > 0 ? JSON.stringify(packs) : null;
    packEndpointTotal = packs.reduce((sum, p) => sum + p.size * p.qty, 0);
  }

  await env.DB.prepare(
    `UPDATE licenses SET issued_to_org = ?2, contact_email = ?3, company_id = ?4, notes = ?5, packs = ?6, pack_size = ?7 WHERE license_key = ?1`,
  )
    .bind(key, org, email, companyId, notes, packsJSON, packEndpointTotal)
    .run();
  return jsonResponse(200, { ok: true, license_key: key, packs: packsJSON ? (JSON.parse(packsJSON) as Pack[]) : [] });
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

// addMonthsISO returns now + n calendar months (UTC, second precision), clamped
// to the last valid day of the target month (e.g. Jan 31 + 1 month -> Feb 28).
// This is the exclusive subscription period end; a license is valid while
// now < expires_at, so a monthly term bought on the 1st runs through the end of
// the month and lapses on the same day next month.
function addMonthsISO(months: number): string {
  const d = new Date();
  const day = d.getUTCDate();
  d.setUTCDate(1); // avoid day-overflow while shifting the month
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
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
