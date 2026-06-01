import { jsonResponse } from "./activate";

export function handleHealth(): Response {
  return jsonResponse(200, { ok: true, ts: new Date().toISOString() });
}
