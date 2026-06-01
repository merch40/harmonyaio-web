import { WorkerError, badRequest } from "./errors";
import {
  getCooldown,
  getInstance,
  logActivation,
  releaseInstance,
  upsertCooldown,
} from "./db";
import { jsonResponse, safeJSON } from "./activate";
import { requireSession } from "./magic_link";
import type { Env, ReleaseRequest } from "./types";

const FORCE_RELEASE_COOLDOWN_DAYS = 30;

export async function handleRelease(req: Request, env: Env): Promise<Response> {
  const body = (await safeJSON(req)) as ReleaseRequest | null;
  if (!body || !body.license_key || !body.instance_id) {
    throw badRequest("license_key and instance_id are required");
  }

  const inst = await getInstance(env.DB, body.license_key, body.instance_id);
  if (!inst) {
    // Idempotent: silently report ok even if it never existed.
    return jsonResponse(200, { ok: true });
  }
  await releaseInstance(env.DB, body.license_key, body.instance_id);

  await logActivation(env.DB, {
    license_key: body.license_key,
    instance_id: body.instance_id,
    event: "release",
    result: "success",
  });

  return jsonResponse(200, { ok: true });
}

export async function handleForceRelease(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  const body = (await safeJSON(req)) as ReleaseRequest | null;
  if (!body || !body.license_key || !body.instance_id) {
    throw badRequest("license_key and instance_id are required");
  }

  const last = await getCooldown(env.DB, body.license_key);
  if (last) {
    const lastMs = Date.parse(last);
    const diffDays = (Date.now() - lastMs) / (1000 * 60 * 60 * 24);
    if (diffDays < FORCE_RELEASE_COOLDOWN_DAYS) {
      const next = new Date(
        lastMs + FORCE_RELEASE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      throw new WorkerError(429, "force_release_cooldown", "force release was used recently", {
        next_allowed_at: next,
      });
    }
  }

  const inst = await getInstance(env.DB, body.license_key, body.instance_id);
  if (!inst) {
    throw new WorkerError(404, "not_found", "instance not found for license");
  }

  await releaseInstance(env.DB, body.license_key, body.instance_id);
  await upsertCooldown(env.DB, body.license_key);

  await logActivation(env.DB, {
    license_key: body.license_key,
    instance_id: body.instance_id,
    event: "force_release",
    result: "success",
    reason: `actor=${session.email}`,
  });

  return jsonResponse(200, { ok: true });
}
