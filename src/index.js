// Harmony AIO Worker
//
// Serves the harmonyaio.com teaser site plus:
//   POST /api/signup                 Brevo newsletter signup
//   GET  /api/releases/latest        signed-channel release resolver
//   GET  /install.sh|/install.ps1    hosted SERVER install one-liners
//   GET  /uninstall.sh|/uninstall.ps1
//
// The install scripts are static assets under /install/ (synced from the
// Harmony-AIO repo by scripts/sync-install-scripts-to-web.ps1) served with
// normalized line endings: a stray CR makes bash fail with
// "$'\r': command not found", while PowerShell is happiest with CRLF.
//
// The resolver fetches the requested channel pointer from the update
// origin, verifies its PS256 signature against the pinned public keys in
// update_trust.js, and returns the artifact URL + SHA-256 for the target
// OS. The one-liners never parse or trust the raw channel envelope.

import { PINNED_UPDATE_KEYS } from "./update_trust.js";
import { importPinnedKeys, resolveLatest, ResolverError, MAX_ENVELOPE_BYTES } from "./release_resolver.js";

const INSTALL_SCRIPTS = {
  "/install.sh": { asset: "/install/install.sh", eol: "lf" },
  "/install.ps1": { asset: "/install/install.ps1", eol: "crlf" },
  "/uninstall.sh": { asset: "/install/uninstall.sh", eol: "lf" },
  "/uninstall.ps1": { asset: "/install/uninstall.ps1", eol: "crlf" },
};

// Imported CryptoKeys are cached across requests within an isolate.
let pinnedKeysPromise = null;
function getPinnedKeys() {
  if (!pinnedKeysPromise) {
    pinnedKeysPromise = importPinnedKeys(PINNED_UPDATE_KEYS);
  }
  return pinnedKeysPromise;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/signup") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
      }
      return handleSignup(request, env);
    }

    if (url.pathname === "/api/releases/latest") {
      if (request.method !== "GET") {
        return jsonResponse({ error: "Method not allowed" }, 405);
      }
      return handleReleaseResolve(url, env);
    }

    // Root-level one-liner paths, plus the raw asset paths under /install/
    // so both spellings serve identical, EOL-normalized bytes.
    const script = INSTALL_SCRIPTS[url.pathname] ||
      Object.values(INSTALL_SCRIPTS).find((s) => s.asset === url.pathname);
    if (script) {
      return handleInstallScript(script, url, request, env);
    }

    return env.ASSETS.fetch(request);
  }
};

async function handleReleaseResolve(url, env) {
  const os = url.searchParams.get("os") || "";
  if (os !== "linux" && os !== "windows") {
    return jsonResponse({ error: "os must be 'linux' or 'windows'" }, 400);
  }

  const allowed = (env.ALLOWED_CHANNELS || "dogfood,stable").split(",").map((c) => c.trim()).filter(Boolean);
  const channel = url.searchParams.get("channel") || env.DEFAULT_CHANNEL || "dogfood";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channel) || !allowed.includes(channel)) {
    return jsonResponse({ error: "unknown channel", allowed_channels: allowed }, 400);
  }

  const updateOrigin = (env.UPDATE_ORIGIN || "https://updates.harmonyaio.com").replace(/\/+$/, "");

  try {
    const upstream = await fetch(`${updateOrigin}/v1/channels/${channel}.json`, {
      cf: { cacheTtl: 0, cacheEverything: false },
      headers: { "cache-control": "no-cache" },
    });
    if (upstream.status === 404) {
      return jsonResponse({ error: `channel '${channel}' has no published releases yet` }, 404);
    }
    if (!upstream.ok) {
      console.error("release resolver: upstream status", upstream.status, "for channel", channel);
      return jsonResponse({ error: "update origin is unavailable" }, 502);
    }
    const envelopeText = await readBodyCapped(upstream, MAX_ENVELOPE_BYTES);
    if (envelopeText === null) {
      return jsonResponse({ error: "channel envelope is too large" }, 502);
    }

    const result = await resolveLatest({
      envelopeText,
      os,
      pinnedKeys: await getPinnedKeys(),
      updateOrigin,
      expectedChannel: channel,
      nowMs: Date.now(),
    });

    return jsonResponse(result, 200, {
      // Channel pointers are mutable; never let a stale answer linger.
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
  } catch (err) {
    if (err instanceof ResolverError) {
      console.error("release resolver:", err.message);
      return jsonResponse({ error: err.message }, err.status);
    }
    console.error("release resolver exception:", err);
    return jsonResponse({ error: "unexpected resolver error" }, 502);
  }
}

// readBodyCapped streams a response body up to maxBytes and returns the
// decoded text, or null if the body exceeds the cap. A Content-Length
// header is not trusted: chunked responses carry none, so the cap is
// enforced on the actual bytes read.
async function readBodyCapped(response, maxBytes) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

// handleInstallScript serves a hosted one-liner script with normalized line
// endings and a plain-text content type so curl and irm hand it to
// bash/iex cleanly. No substitution happens here: the server installers
// take no URL parameters by design (the old ?server= agent-installer
// rewriting was retired with the agent mirror).
async function handleInstallScript(script, url, request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const assetUrl = new URL(script.asset, url.origin);
  const assetResponse = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: "GET" }));
  if (!assetResponse.ok) {
    return new Response("Install script not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  let body = await assetResponse.text();
  body = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (script.eol === "crlf") {
    body = body.replace(/\n/g, "\r\n");
  }

  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "content-type": script.eol === "lf"
        ? "text/x-shellscript; charset=utf-8"
        : "text/plain; charset=utf-8",
      // Short cache so script fixes propagate quickly.
      "cache-control": "public, max-age=300",
      "x-harmony-install": "2",
    },
  });
}

async function handleSignup(request, env) {
  try {
    // Parse incoming JSON body
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid request body" }, 400);
    }

    const email = (body.email || "").trim().toLowerCase();

    // Basic email validation - catches obvious garbage
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return jsonResponse({ error: "Please provide a valid email address" }, 400);
    }

    // Fail loud if env vars are missing
    if (!env.BREVO_API_KEY || !env.BREVO_LIST_ID) {
      console.error("Missing BREVO_API_KEY or BREVO_LIST_ID env var");
      return jsonResponse({ error: "Server not configured" }, 500);
    }

    // Call Brevo contacts API
    // Docs: https://developers.brevo.com/reference/createcontact
    const brevoResponse = await fetch("https://api.brevo.com/v3/contacts", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "api-key": env.BREVO_API_KEY
      },
      body: JSON.stringify({
        email: email,
        listIds: [parseInt(env.BREVO_LIST_ID, 10)],
        updateEnabled: true  // if contact exists, just add them to the list
      })
    });

    // Brevo returns 201 for new contact, 204 for updated existing contact
    if (brevoResponse.status === 201 || brevoResponse.status === 204) {
      return jsonResponse({ success: true });
    }

    // Log the actual error for debugging in Observability tab
    const errorText = await brevoResponse.text();
    console.error("Brevo API error:", brevoResponse.status, errorText);
    return jsonResponse({ error: "Could not process signup" }, 500);

  } catch (err) {
    console.error("Signup handler exception:", err);
    return jsonResponse({ error: "Unexpected error" }, 500);
  }
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders }
  });
}
