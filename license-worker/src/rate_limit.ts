// Tiny D1-backed fixed-window rate limiter. Per (key, 60-second window).

const WINDOW_SECONDS = 60;

export async function checkRateLimit(
  db: D1Database,
  key: string,
  limit: number,
): Promise<boolean> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);

  // Atomically increment via INSERT ... ON CONFLICT.
  await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1`,
    )
    .bind(key, window)
    .run();

  const row = await db
    .prepare("SELECT count FROM rate_limits WHERE key = ?1 AND window_start = ?2")
    .bind(key, window)
    .first<{ count: number }>();

  return (row?.count ?? 0) <= limit;
}

export function clientIP(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

// Convenience: enforce both per-IP and per-key buckets, raise WorkerError on breach.
import { WorkerError } from "./errors";

export async function enforceRateLimits(
  db: D1Database,
  req: Request,
  scope: string,
  licenseKey: string,
  limit: number,
): Promise<void> {
  const ip = clientIP(req);
  const ipOk = await checkRateLimit(db, `${scope}:ip:${ip}`, limit);
  const keyOk = await checkRateLimit(db, `${scope}:key:${licenseKey}`, limit);
  if (!ipOk || !keyOk) {
    throw new WorkerError(429, "rate_limited", "too many requests, slow down");
  }
}
