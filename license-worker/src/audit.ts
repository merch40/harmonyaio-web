import type { Env } from "./types";
import { WorkerError } from "./errors";

export interface AuditActor {
  kind: "shared-admin-browser" | "shared-admin-api" | "unauthenticated";
  sessionId: string | null;
}

export async function fingerprint(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

function requestSource(req: Request): [string, string] {
  // Cloudflare supplies this header at the edge. Never trust X-Forwarded-For
  // as the identity of a caller; no edge header means unknown (including local).
  return [(req.headers.get("cf-connecting-ip") || "unknown").slice(0, 64),
    (req.headers.get("user-agent") || "unknown").slice(0, 512)];
}

// Explicit allowlist, deliberately excluding the license key and all auth data.
// Evaluated inside the same transaction as the mutation, not an earlier read.
const SNAPSHOT = `(SELECT json_object(
  'organization', issued_to_org, 'contact_email', contact_email,
  'company_id', company_id, 'tier', tier, 'pack_endpoints', pack_size,
  'packs', json(COALESCE(packs, '[]')), 'notes', notes,
  'expires_at', expires_at, 'revoked_at', revoked_at, 'revoked_reason', revoked_reason,
  'active_bindings', (SELECT COUNT(*) FROM instances WHERE license_key = l.license_key AND released_at IS NULL)
) FROM licenses l WHERE license_key = ?2)`;

export type LicenseAction = "license.created" | "license.updated" | "license.revoked" | "license.removed" | "license.released";

export async function auditMutation(
  req: Request, env: Env, actor: AuditActor, action: LicenseAction,
  key: string, mutations: D1PreparedStatement[],
): Promise<D1Result[]> {
  const id = crypto.randomUUID();
  const hash = await fingerprint(key);
  const [ip, agent] = requestSource(req);
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO admin_audit_staging(event_id, before_json) VALUES (?1, ${SNAPSHOT})`).bind(id, key),
    ...mutations,
    env.DB.prepare(`INSERT INTO admin_audit
      (event_id, occurred_at, action, outcome, actor, session_id, client_ip, user_agent, license_hash, license_hint, before_json, after_json)
      SELECT ?1, ?3, ?4, 'success', ?5, ?6, ?7, ?8, ?9, ?10, before_json, ${SNAPSHOT}
      FROM admin_audit_staging WHERE event_id = ?1`)
      .bind(id, key, new Date().toISOString(), action, actor.kind, actor.sessionId, ip, agent, hash, "…" + key.slice(-4)),
    env.DB.prepare("DELETE FROM admin_audit_staging WHERE event_id = ?1").bind(id),
  ]);
  return result.slice(1, mutations.length + 1);
}

export async function auditAuth(
  req: Request, env: Env, actor: AuditActor,
  action: "admin.login" | "admin.logout", outcome: "success" | "denied" | "rate_limited",
): Promise<void> {
  const [ip, agent] = requestSource(req);
  await env.DB.prepare(`INSERT INTO admin_audit
    (event_id, occurred_at, action, outcome, actor, session_id, client_ip, user_agent)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
    .bind(crypto.randomUUID(), new Date().toISOString(), action, outcome, actor.kind, actor.sessionId, ip, agent).run();
}

interface AuditRow {
  id: number;
  event_id: string;
  occurred_at: string;
  action: string;
  outcome: string;
  actor: string;
  session_id: string | null;
  client_ip: string;
  user_agent: string;
  license_hint: string | null;
  before_json: string | null;
  after_json: string | null;
}

// Call only after the admin auth gate. Cursor pagination keeps older records
// reachable without an unbounded response or silently truncating the history.
export async function listAudit(req: Request, env: Env): Promise<Response> {
  const raw = new URL(req.url).searchParams.get("before");
  const before = raw === null ? Number.MAX_SAFE_INTEGER : Number(raw);
  if (!Number.isSafeInteger(before) || before < 1) throw new WorkerError(400, "bad_request", "invalid audit cursor");
  const { results } = await env.DB.prepare(`SELECT id, event_id, occurred_at, action, outcome, actor,
    session_id, client_ip, user_agent, license_hint, before_json, after_json
    FROM admin_audit WHERE id < ?1 ORDER BY id DESC LIMIT 51`).bind(before).all<AuditRow>();
  const page = results.slice(0, 50);
  const events = page.map(({ before_json, after_json, ...row }) => ({ ...row,
    before: before_json ? JSON.parse(before_json) : null,
    after: after_json ? JSON.parse(after_json) : null,
  }));
  return Response.json({ events, next_cursor: results.length > 50 ? page[page.length - 1].id : null },
    { headers: { "cache-control": "no-store" } });
}
