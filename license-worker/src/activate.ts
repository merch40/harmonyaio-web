import { WorkerError, badRequest } from "./errors";
import { buildLicenseBlob } from "./blob";
import {
  getActiveInstance,
  getInstance,
  getLicense,
  logActivation,
  releaseOtherInstanceBindings,
  upsertInstance,
} from "./db";
import { enforceRateLimits, clientIP } from "./rate_limit";
import type { ActivateRequest, Env } from "./types";

export async function handleActivate(req: Request, env: Env): Promise<Response> {
  const body = (await safeJSON(req)) as ActivateRequest | null;
  if (!body || !body.license_key || !body.instance_id) {
    throw badRequest("license_key and instance_id are required");
  }
  await enforceRateLimits(env.DB, req, "activate", body.license_key, 60);

  const license = await getLicense(env.DB, body.license_key);
  if (!license) {
    await logActivation(env.DB, {
      license_key: body.license_key,
      instance_id: body.instance_id,
      event: "activate",
      result: "rejected",
      reason: "not_found",
      client_ip: clientIP(req),
      user_agent: req.headers.get("user-agent"),
    });
    throw new WorkerError(403, "license_rejected", "license key not found");
  }
  if (license.revoked_at) {
    await logActivation(env.DB, {
      license_key: body.license_key,
      instance_id: body.instance_id,
      event: "activate",
      result: "rejected",
      reason: license.revoked_reason ?? "revoked",
    });
    throw new WorkerError(403, "license_revoked", license.revoked_reason ?? "license revoked");
  }
  if (license.expires_at && license.expires_at < new Date().toISOString()) {
    await logActivation(env.DB, {
      license_key: body.license_key,
      instance_id: body.instance_id,
      event: "activate",
      result: "rejected",
      reason: "expired",
    });
    throw new WorkerError(403, "license_expired", "license expired, renew at harmonyaio.com/account");
  }

  // Binding decision: any other instance currently active blocks us.
  const active = await getActiveInstance(env.DB, license.license_key);
  if (active && active.instance_id !== body.instance_id) {
    await logActivation(env.DB, {
      license_key: body.license_key,
      instance_id: body.instance_id,
      event: "activate",
      result: "rejected",
      reason: "instance_mismatch",
    });
    throw new WorkerError(409, "instance_mismatch", "license already active on another server, release it first");
  }

  await upsertInstance(env.DB, {
    license_key: license.license_key,
    instance_id: body.instance_id,
    server_version: body.server_version,
    hostname_hash: body.hostname_hash,
  });

  // In-place key swap (e.g. a tier upgrade where the operator hits Apply without
  // releasing first): free any other key this same server was still bound to, so
  // the old key doesn't linger as a stale "Bound" binding.
  const releasedKeys = await releaseOtherInstanceBindings(
    env.DB,
    body.instance_id,
    license.license_key,
  );
  for (const releasedKey of releasedKeys) {
    await logActivation(env.DB, {
      license_key: releasedKey,
      instance_id: body.instance_id,
      event: "release",
      result: "success",
      reason: "auto-released: server activated " + license.license_key,
    });
  }

  const blob = await buildLicenseBlob(
    license,
    body.instance_id,
    env.HARMONY_LICENSE_SIGNING_KEY_V1,
  );

  await logActivation(env.DB, {
    license_key: body.license_key,
    instance_id: body.instance_id,
    event: "activate",
    result: "success",
    client_ip: clientIP(req),
    user_agent: req.headers.get("user-agent"),
  });

  return jsonResponse(200, blob);
}

export async function safeJSON(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
