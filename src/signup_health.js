// Health probe for the newsletter signup path (/api/signup).
//
// Exists because the signup broke silently twice in 2026: a wrangler deploy
// wiped the dashboard-var config in July, and the idle Brevo API key was
// auto-deactivated for inactivity. Low signup volume made both invisible —
// a dead form and no demand look identical from the outside.
//
// The probe validates the same config the signup handler uses, end to end:
// env vars present, list id numeric, and the API key accepted by Brevo
// (GET on the configured list — read-only, creates nothing). As a side
// effect, running it on the weekly cron keeps the key active, which is
// itself a guard against Brevo's inactivity deactivation.

export async function probeSignup(env, fetchImpl = fetch) {
  if (!env.BREVO_API_KEY || !env.BREVO_LIST_ID) {
    return { ok: false, reason: "not_configured" };
  }

  const listId = parseInt(env.BREVO_LIST_ID, 10);
  if (!Number.isInteger(listId)) {
    return { ok: false, reason: "bad_list_id" };
  }

  let response;
  try {
    response = await fetchImpl(`https://api.brevo.com/v3/contacts/lists/${listId}`, {
      headers: {
        "accept": "application/json",
        "api-key": env.BREVO_API_KEY,
      },
    });
  } catch {
    return { ok: false, reason: "brevo_unreachable" };
  }

  if (response.status === 200) {
    return { ok: true };
  }
  // 401 is a bad/revoked/deactivated key; Brevo uses 403 for keys that are
  // recognized but not permitted. Both mean "a human must fix the key".
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "brevo_auth" };
  }
  if (response.status === 404) {
    return { ok: false, reason: "list_missing" };
  }
  return { ok: false, reason: `brevo_status_${response.status}` };
}
