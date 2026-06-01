// Typed error codes shared with the Go server (see internal/license/errors.go).
// Format matches the brief: { error: { code, reason } } HTTP body.

export type ErrorCode =
  | "license_rejected"
  | "license_expired"
  | "license_revoked"
  | "instance_mismatch"
  | "rate_limited"
  | "force_release_cooldown"
  | "unauthorized"
  | "bad_request"
  | "not_found"
  | "internal_error";

export class WorkerError extends Error {
  status: number;
  code: ErrorCode;
  reason: string;
  extra?: Record<string, unknown>;

  constructor(status: number, code: ErrorCode, reason: string, extra?: Record<string, unknown>) {
    super(`${code}: ${reason}`);
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.extra = extra;
  }

  toResponse(): Response {
    const body = { error: { code: this.code, reason: this.reason, ...(this.extra ?? {}) } };
    return new Response(JSON.stringify(body), {
      status: this.status,
      headers: { "content-type": "application/json" },
    });
  }
}

export function badRequest(reason: string): WorkerError {
  return new WorkerError(400, "bad_request", reason);
}
export function unauthorized(reason = "authentication required"): WorkerError {
  return new WorkerError(401, "unauthorized", reason);
}
export function notFound(reason = "not found"): WorkerError {
  return new WorkerError(404, "not_found", reason);
}
export function internalError(reason = "internal error"): WorkerError {
  return new WorkerError(500, "internal_error", reason);
}
