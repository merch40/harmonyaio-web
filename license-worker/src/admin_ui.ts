// Static single-page admin console served at GET /admin. It carries no secrets;
// every data call is gated server-side by an admin session cookie (see admin.ts).
// Styled to the Harmony brand spec (harmony-branding skill): amber + teal on ink,
// warm white text, the H wordmark as the single glow, gradient only on the
// wordmark and a thin card top-accent, no red (reserved for the security band).
// The inline script uses string concatenation (no template literals / ${}) so it
// nests cleanly inside this TS template literal.

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harmony License Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;900&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --amber:#e8a020; --teal:#2dd4bf; --ink:#080808; --white:#f0ede8; --dim:#a6a39d;
    --card:rgba(18,16,14,0.85); --card-border:rgba(240,237,232,0.10); --field:#0c0b0a;
    --teal-dim:rgba(45,212,191,0.10); --teal-border:rgba(45,212,191,0.22);
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--ink); color:var(--white); font-family:'DM Sans',system-ui,sans-serif; font-weight:400; -webkit-font-smoothing:antialiased; }
  .wrap { position:relative; max-width:880px; margin:0 auto; padding:48px 20px 80px; }

  .brand { text-align:center; margin-bottom:36px; }
  .wordmark-h {
    display:inline-flex; align-items:center; justify-content:center;
    width:52px; height:52px; border-radius:11px;
    background:linear-gradient(135deg,var(--amber),var(--teal));
    font-family:'Cinzel',serif; font-weight:900; font-size:26px; color:#080808;
    box-shadow:0 0 40px rgba(232,160,32,0.4),0 0 80px rgba(45,212,191,0.2),0 4px 24px rgba(0,0,0,0.6);
    animation:hPulse 2.8s ease-in-out infinite;
  }
  @keyframes hPulse {
    0%,100% { box-shadow:0 0 40px rgba(232,160,32,0.4),0 0 80px rgba(45,212,191,0.2),0 4px 24px rgba(0,0,0,0.6); }
    50% { box-shadow:0 0 56px rgba(232,160,32,0.55),0 0 110px rgba(45,212,191,0.3),0 4px 24px rgba(0,0,0,0.6); }
  }
  @media (prefers-reduced-motion: reduce) { .wordmark-h { animation:none; } }
  .wordmark-name { font-family:'Cinzel',serif; font-weight:600; font-size:26px; letter-spacing:0.24em; text-transform:uppercase; margin:14px 0 0; text-shadow:0 2px 12px rgba(0,0,0,0.5); }
  .wordmark-sub { font-weight:300; font-size:10px; letter-spacing:0.38em; text-transform:uppercase; color:var(--teal); margin:7px 0 0; }
  .wordmark-desc { font-size:12px; color:var(--dim); letter-spacing:0.05em; margin:12px 0 0; }
  .logout { position:absolute; top:24px; right:20px; }

  .card { position:relative; background:var(--card); border:1px solid var(--card-border); border-radius:14px; padding:26px; margin:0 auto 20px; max-width:680px; }
  .card.accent { border-top:0; }
  .card.accent::before { content:""; position:absolute; top:0; left:0; right:0; height:2px; border-radius:14px 14px 0 0; background:linear-gradient(135deg,var(--amber),var(--teal)); }
  #loginCard { max-width:420px; }

  h2 { font-family:'Cinzel',serif; font-weight:600; font-size:14px; letter-spacing:0.06em; text-transform:uppercase; margin:0 0 16px; display:flex; align-items:center; gap:12px; }
  .muted { color:var(--dim); font-size:13px; margin:0 0 14px; }

  label { display:flex; flex-direction:column; gap:6px; font-size:10px; font-weight:500; letter-spacing:0.14em; text-transform:uppercase; color:var(--dim); }
  input, select { background:var(--field); border:1px solid var(--card-border); color:var(--white); border-radius:8px; padding:10px 11px; font-size:14px; font-family:'DM Sans',sans-serif; }
  input:focus, select:focus { outline:none; border-color:var(--teal); }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px 18px; }
  .grid button { grid-column:1 / -1; }

  button { background:var(--amber); color:#1a1205; border:none; border-radius:8px; padding:11px 18px; font-family:'DM Sans',sans-serif; font-size:12px; font-weight:600; letter-spacing:0.08em; text-transform:uppercase; cursor:pointer; }
  button:hover { filter:brightness(1.08); }
  button.ghost { background:none; color:var(--dim); border:1px solid var(--card-border); font-size:10px; padding:6px 12px; letter-spacing:0.12em; }
  button.ghost:hover { color:var(--white); border-color:var(--teal-border); }

  .err { color:var(--amber); font-size:12px; margin-top:10px; min-height:1em; letter-spacing:0.02em; }
  #loginForm { display:flex; gap:10px; }
  #loginForm input { flex:1; }
  #result { margin-top:18px; padding-top:16px; border-top:1px solid var(--card-border); }
  .keyrow { display:flex; align-items:center; gap:12px; margin-top:8px; }
  #keyValue { font-family:'Courier New',monospace; font-size:18px; letter-spacing:0.06em; color:var(--teal); }

  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--card-border); }
  th { font-family:'Cinzel',serif; font-weight:400; font-size:10px; letter-spacing:0.16em; text-transform:uppercase; color:var(--teal); }
  td code { font-family:'Courier New',monospace; color:var(--amber); }
  tr.revoked td { opacity:0.55; }
  .pill { font-size:9px; font-weight:500; letter-spacing:0.18em; text-transform:uppercase; padding:3px 9px; border-radius:999px; white-space:nowrap; }
  .pill.active { color:var(--teal); background:var(--teal-dim); border:1px solid var(--teal-border); }
  .pill.revoked { color:var(--dim); background:rgba(240,237,232,0.04); border:1px solid rgba(240,237,232,0.18); }
</style>
</head>
<body>
<div class="wrap">
  <button id="logoutBtn" class="ghost logout" hidden>Sign out</button>

  <div class="brand">
    <div class="wordmark-h">H</div>
    <div class="wordmark-name">Harmony AIO</div>
    <div class="wordmark-sub">AI Operations Orchestration</div>
    <div class="wordmark-desc">License Administration</div>
  </div>

  <section id="loginCard" class="card accent" hidden>
    <h2>Sign in</h2>
    <p class="muted">Enter the admin secret to issue license keys.</p>
    <form id="loginForm">
      <input type="password" id="password" placeholder="Admin secret" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
    </form>
    <div id="loginErr" class="err"></div>
  </section>

  <section id="issueCard" class="card accent" hidden>
    <h2>Generate a license key</h2>
    <form id="issueForm" class="grid">
      <label>Tier
        <select id="tier">
          <option value="business">Business</option>
          <option value="professional" selected>Professional</option>
          <option value="enterprise">Enterprise</option>
        </select>
      </label>
      <label id="packWrap">Pack size
        <select id="packSize">
          <option>10</option><option>20</option><option>50</option><option>100</option>
        </select>
      </label>
      <label>Organization
        <input id="org" placeholder="Acme Corp" required>
      </label>
      <label>Contact email
        <input id="email" type="email" placeholder="admin@acme.com" required>
      </label>
      <label>Expires (optional)
        <input id="expires" type="date">
      </label>
      <label>Notes (optional)
        <input id="notes" placeholder="sales ref, partner, etc.">
      </label>
      <button type="submit">Generate key</button>
    </form>
    <div id="issueErr" class="err"></div>
    <div id="result" hidden>
      <span class="muted">New license key</span>
      <div class="keyrow"><code id="keyValue"></code><button id="copyBtn" type="button" class="ghost">Copy</button></div>
    </div>
  </section>

  <section id="listCard" class="card" hidden>
    <h2>Issued licenses <button id="refreshBtn" type="button" class="ghost">Refresh</button></h2>
    <table>
      <thead><tr><th>Key</th><th>Tier</th><th>Organization</th><th>Active</th><th>Issued</th><th>Expires</th><th>Status</th></tr></thead>
      <tbody id="licenseBody"></tbody>
    </table>
  </section>
</div>

<script>
(function () {
  function $(id) { return document.getElementById(id); }
  function show(el, on) { el.hidden = !on; }

  function api(path, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) {
          var msg = (data && data.error && data.error.reason) || ('HTTP ' + r.status);
          throw new Error(msg);
        }
        return data;
      });
    });
  }

  function refreshAuth() {
    return api('/admin/session').then(function (d) {
      var authed = d.admin === true;
      show($('loginCard'), !authed);
      show($('issueCard'), authed);
      show($('listCard'), authed);
      show($('logoutBtn'), authed);
      if (authed) loadList();
    });
  }

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    $('loginErr').textContent = '';
    api('/admin/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: $('password').value })
    }).then(function () {
      $('password').value = '';
      return refreshAuth();
    }).catch(function (err) { $('loginErr').textContent = err.message; });
  });

  $('logoutBtn').addEventListener('click', function () {
    api('/admin/logout', { method: 'POST' }).then(refreshAuth);
  });

  function syncPack() { show($('packWrap'), $('tier').value === 'professional'); }
  $('tier').addEventListener('change', syncPack);

  $('issueForm').addEventListener('submit', function (e) {
    e.preventDefault();
    $('issueErr').textContent = '';
    show($('result'), false);
    var payload = {
      tier: $('tier').value,
      issued_to_org: $('org').value.trim(),
      contact_email: $('email').value.trim()
    };
    if (payload.tier === 'professional') payload.pack_size = parseInt($('packSize').value, 10);
    var exp = $('expires').value;
    if (exp) payload.expires_at = exp + 'T00:00:00Z';
    var notes = $('notes').value.trim();
    if (notes) payload.notes = notes;
    api('/admin/license', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (d) {
      $('keyValue').textContent = d.license_key;
      show($('result'), true);
      loadList();
    }).catch(function (err) { $('issueErr').textContent = err.message; });
  });

  $('copyBtn').addEventListener('click', function () {
    navigator.clipboard.writeText($('keyValue').textContent).then(function () {
      $('copyBtn').textContent = 'Copied';
      setTimeout(function () { $('copyBtn').textContent = 'Copy'; }, 1500);
    });
  });

  $('refreshBtn').addEventListener('click', loadList);

  function cell(text) {
    var td = document.createElement('td');
    td.textContent = (text === null || text === undefined) ? '' : String(text);
    return td;
  }

  function loadList() {
    api('/admin/licenses').then(function (d) {
      var body = $('licenseBody');
      body.innerHTML = '';
      (d.licenses || []).forEach(function (l) {
        var tr = document.createElement('tr');
        if (l.revoked_at) tr.className = 'revoked';
        var keyTd = document.createElement('td');
        var code = document.createElement('code');
        code.textContent = l.license_key;
        keyTd.appendChild(code);
        tr.appendChild(keyTd);
        tr.appendChild(cell(l.tier));
        tr.appendChild(cell(l.issued_to_org));
        tr.appendChild(cell(l.active_instances));
        tr.appendChild(cell((l.issued_at || '').slice(0, 10)));
        tr.appendChild(cell(l.expires_at ? l.expires_at.slice(0, 10) : 'perpetual'));
        var statusTd = document.createElement('td');
        var pill = document.createElement('span');
        pill.className = l.revoked_at ? 'pill revoked' : 'pill active';
        pill.textContent = l.revoked_at ? 'revoked' : 'active';
        statusTd.appendChild(pill);
        tr.appendChild(statusTd);
        body.appendChild(tr);
      });
    }).catch(function () { /* list errors are non-fatal */ });
  }

  syncPack();
  refreshAuth();
})();
</script>
</body>
</html>`;

export function handleAdminPage(): Response {
  return new Response(PAGE, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
