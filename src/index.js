// Harmony AIO Worker
// Handles /api/signup POST requests and serves static assets for everything else

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