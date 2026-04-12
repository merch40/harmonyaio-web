// Harmony AIO Worker
// Handles /api/signup POST requests and serves static assets for everything else.
// Also rewrites the install scripts at /install.sh and /install.ps1 to inject
// the ?server= query string into the script body before serving, so the
// hosted one-liner works without any separate args.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Route the signup endpoint
    if (url.pathname === "/api/signup") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
      }
      return handleSignup(request, env);
    }

    // Hosted install script routes.  Root-level paths for nice one-liners,
    // backed by the real assets under /install/.  The Worker rewrites the
    // __HARMONY_SERVER_URL__ placeholder with a sanitized ?server= value
    // and serves with an explicit text/plain content-type.
    if (url.pathname === "/install.sh" || url.pathname === "/install.ps1") {
      return handleInstallScript(url, request, env);
    }

    // Everything else falls through to static assets
    return env.ASSETS.fetch(request);
  }
};

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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// handleInstallScript fetches the static install script asset, optionally
// substitutes the Worker placeholder token with a sanitized ?server= value
// from the query string, and returns it with a text/plain content-type so
// curl and Invoke-WebRequest hand it off to bash/iex cleanly.
//
// The sanitizer is strict on purpose: the substituted value is dropped
// directly into a string literal inside a bash and a PowerShell script, so
// any shell metacharacter would be a command injection.  Anything that
// fails validation is treated as "no query param" and the script falls
// through to its env var / error path.
async function handleInstallScript(url, request, env) {
  // Translate the root-level path to the asset path under /install/.
  const assetPath = url.pathname === "/install.sh"
    ? "/install/install.sh"
    : "/install/install.ps1";

  // Fetch the raw static asset from the assets binding.
  const assetUrl = new URL(assetPath, url.origin);
  const assetRequest = new Request(assetUrl.toString(), {
    method: "GET",
    headers: request.headers
  });
  const assetResponse = await env.ASSETS.fetch(assetRequest);

  if (!assetResponse.ok) {
    return new Response("Install script not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }

  let body = await assetResponse.text();

  // Optionally substitute the server URL from ?server=.
  const rawServer = url.searchParams.get("server") || "";
  const safeServer = sanitizeServerUrl(rawServer);
  if (safeServer) {
    body = body.split("__HARMONY_SERVER_URL__").join(safeServer);
  }

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // Short cache so updates propagate quickly during development.
      "cache-control": "public, max-age=60",
      "x-harmony-install": "1"
    }
  });
}

// sanitizeServerUrl returns the input unchanged if it looks like a harmless
// http or https URL with no shell metacharacters, otherwise an empty string.
// This is a defense against query-param injection into the install script
// string literal.
function sanitizeServerUrl(raw) {
  if (!raw || raw.length > 256) return "";

  // Must start with http:// or https://
  if (!/^https?:\/\//i.test(raw)) return "";

  // Reject anything containing shell metacharacters, quotes, backticks,
  // whitespace, or control characters.  This covers bash and PowerShell
  // string-literal escape paths.
  if (/[\s"'`$\\;&|<>(){}[\]\x00-\x1f]/.test(raw)) return "";

  // Must match a basic URL shape: scheme://host[:port][/path]
  // Host chars: letters, digits, dots, hyphens (no wildcards, no IDN).
  // Path chars: letters, digits, dots, underscores, tildes, hyphens, slashes.
  if (!/^https?:\/\/[a-zA-Z0-9.\-]+(?::\d+)?(?:\/[a-zA-Z0-9._~\-\/]*)?$/.test(raw)) return "";

  return raw;
}