import { handleActivate } from "./activate";
import { handleValidate } from "./validate";
import { handleRelease, handleForceRelease } from "./release";
import { handleAccountInstances } from "./account";
import { handleAuthRequest, handleAuthVerify } from "./magic_link";
import {
  handleAdminIssue,
  handleAdminLicensesList,
  handleAdminAuth,
  handleAdminSession,
  handleAdminLogout,
} from "./admin";
import { handleAdminPage } from "./admin_ui";
import { handleHealth } from "./health";
import { WorkerError, internalError, notFound } from "./errors";
import type { Env } from "./types";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method.toUpperCase();

      if (method === "GET" && path === "/health") return handleHealth();

      if (method === "POST" && path === "/activate") return await handleActivate(req, env);
      if (method === "POST" && path === "/validate") return await handleValidate(req, env);
      if (method === "POST" && path === "/release") return await handleRelease(req, env);
      if (method === "POST" && path === "/force-release") return await handleForceRelease(req, env);

      if (method === "GET" && path === "/account/instances")
        return await handleAccountInstances(req, env);

      if (method === "POST" && path === "/auth/request") return await handleAuthRequest(req, env);
      if (method === "GET" && path === "/auth/verify") return await handleAuthVerify(req, env);

      if (method === "GET" && path === "/admin") return handleAdminPage();
      if (method === "POST" && path === "/admin/auth") return await handleAdminAuth(req, env);
      if (method === "POST" && path === "/admin/logout") return await handleAdminLogout(req, env);
      if (method === "GET" && path === "/admin/session") return await handleAdminSession(req, env);
      if (method === "GET" && path === "/admin/licenses") return await handleAdminLicensesList(req, env);
      if (method === "POST" && path === "/admin/license") return await handleAdminIssue(req, env);

      throw notFound(`no route for ${method} ${path}`);
    } catch (err) {
      if (err instanceof WorkerError) return err.toResponse();
      console.error("unhandled error", err);
      return internalError((err as Error).message ?? "unknown").toResponse();
    }
  },
};
