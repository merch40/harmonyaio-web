import { listActiveInstancesForEmail } from "./db";
import { jsonResponse } from "./activate";
import { requireSession } from "./magic_link";
import type { Env } from "./types";

export async function handleAccountInstances(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  const rows = await listActiveInstancesForEmail(env.DB, session.email);
  return jsonResponse(200, { email: session.email, instances: rows });
}
