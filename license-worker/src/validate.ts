import { WorkerError, badRequest } from "./errors";
import { buildLicenseBlob } from "./blob";
import {
  getActiveInstance,
  getInstance,
  getLicense,
  logActivation,
  recordTelemetry,
  touchInstance,
} from "./db";
import { enforceRateLimits, clientIP } from "./rate_limit";
import { jsonResponse, safeJSON } from "./activate";
import type { Env, ValidateRequest } from "./types";

export async function handleValidate(req: Request, env: Env): Promise<Response> {
  const body = (await safeJSON(req)) as ValidateRequest | null;
  if (!body || !body.license_key || !body.instance_id) {
    throw badRequest("license_key and instance_id are required");
  }
  await enforceRateLimits(env.DB, req, "validate", body.license_key, 60);

  const license = await getLicense(env.DB, body.license_key);
  if (!license) {
    await logActivation(env.DB, {
      license_key: body.license_key,
      instance_id: body.instance_id,
      event: "validate",
      result: "rejected",
      reason: "not_found",
    });
    throw new WorkerError(403, "license_rejected", "license key not found");
  }
  if (license.revoked_at) {
    throw new WorkerError(403, "license_revoked", license.revoked_reason ?? "license revoked");
  }
  if (license.expires_at && license.expires_at < new Date().toISOString()) {
    throw new WorkerError(403, "license_expired", "license expired");
  }

  const active = await getActiveInstance(env.DB, license.license_key);
  if (!active || active.instance_id !== body.instance_id) {
    await logActivation(env.DB, {
      license_key: body.license_key,
      instance_id: body.instance_id,
      event: "validate",
      result: "rejected",
      reason: "instance_mismatch",
    });
    throw new WorkerError(409, "instance_mismatch", "this instance is not the active binding for this license");
  }

  await touchInstance(env.DB, license.license_key, body.instance_id, body.server_version);

  if (body.telemetry) {
    await recordTelemetry(env.DB, {
      license_key: license.license_key,
      instance_id: body.instance_id,
      tenant_count: body.telemetry.tenant_count,
      agent_count: body.telemetry.agent_count,
      instrument_count: body.telemetry.instrument_count,
      unique_domain_count: body.telemetry.unique_domain_count,
      payload_json: JSON.stringify(body.telemetry),
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
    event: "validate",
    result: "success",
    client_ip: clientIP(req),
    user_agent: req.headers.get("user-agent"),
  });

  return jsonResponse(200, blob);
}
