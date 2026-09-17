// Static single-page admin console served at GET /admin. It carries no secrets;
// every data call is gated server-side by an admin session cookie (see admin.ts).
// Uses the current Harmony identity: static H, neutral surfaces and teal actions.
// The inline script uses string concatenation (no template literals / ${}) so it
// nests cleanly inside this TS template literal. CAUTION: do not use escape
// sequences like \n in inner JS strings here -- inside this outer template literal
// they expand to real characters at build time, and a literal newline splits a JS
// string -> SyntaxError that blanks the entire page. Keep dialog text on one line.

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harmony License Admin</title>
<meta name="theme-color" content="#0c0c0d">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<script>
// Apply the preference before styles load, avoiding a flash of the wrong theme.
(() => {
  const key = 'harmony-site-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const normalize = value => ['light', 'dark'].includes(value) ? value : 'system';
  let preference = 'system';
  try { preference = normalize(localStorage.getItem(key)); } catch { /* Storage can be unavailable. */ }

  function apply() {
    const theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0c0c0d' : '#f4f2ef');
    const control = document.querySelector('[data-theme-select]');
    if (control) control.value = preference;
  }

  apply();
  system.addEventListener('change', apply);
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) {
      preference = normalize(event.newValue);
      apply();
    }
  });
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.querySelector('[data-theme-select]')?.addEventListener('change', event => {
      preference = normalize(event.target.value);
      try {
        if (preference === 'system') localStorage.removeItem(key);
        else localStorage.setItem(key, preference);
      } catch { /* Keep the current-page choice usable without storage. */ }
      apply();
    });
  });
})();

</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600&family=DM+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme:dark; --ink:#0c0c0d; --card:#121213; --field:#171718; --white:#ececea; --dim:#a3a09b;
    --card-border:rgba(255,255,255,.10); --strong:rgba(255,255,255,.18); --teal:#2dd4bf;
    --teal-dim:rgba(45,212,191,.09); --teal-border:rgba(45,212,191,.3); --amber:#e8a020;
    --red:#f0655a; --on-accent:#0c0c0d; --mono:'IBM Plex Mono',monospace;
  }
  :root[data-theme=light] {
    color-scheme:light; --ink:#f4f2ef; --card:#fbfaf8; --field:#efedea; --white:#1c1b19; --dim:#55524d;
    --card-border:#dbd7d1; --strong:#c8c3bb; --teal:#0d7b70; --teal-dim:rgba(13,123,112,.08);
    --teal-border:rgba(13,123,112,.3); --amber:#8a5a0d; --red:#a63328; --on-accent:#fff;
  }
  * { box-sizing:border-box; }
  [hidden] { display:none!important; }
  body { margin:0; background:var(--ink); color:var(--white); font:400 15px/1.6 'DM Sans',system-ui,sans-serif; -webkit-font-smoothing:antialiased; }
  a { color:inherit; text-decoration:none; }
  button,input,select,a { -webkit-tap-highlight-color:transparent; }
  :focus-visible { outline:2px solid var(--teal); outline-offset:4px; }
  ::selection { background:var(--teal); color:var(--on-accent); }
  .skip { position:absolute; top:-100px; left:20px; padding:10px; background:var(--teal); color:var(--on-accent); z-index:10; }
  .skip:focus { top:12px; }
  .site-header { border-bottom:1px solid var(--card-border); }
  .header-inner { max-width:1120px; margin:auto; padding:22px 32px; display:flex; align-items:center; justify-content:space-between; gap:24px; }
  .brand { display:flex; align-items:center; gap:15px; }
  .wordmark-h { font:400 38px/1 'Cinzel',Georgia,serif; color:var(--teal); padding-right:16px; border-right:1px solid var(--strong); }
  .wordmark-name { display:block; font:400 19px/1.3 'Cinzel',Georgia,serif; letter-spacing:.19em; text-transform:uppercase; }
  .wordmark-sub { display:block; font:10px/1.5 var(--mono); color:var(--dim); margin-top:4px; }
  .header-actions { display:flex; gap:12px; align-items:center; }
  .theme-select { min-height:44px; max-width:95px; font-size:13px; cursor:pointer; }
  .wrap { max-width:1056px; margin:0 auto; padding:52px 32px 64px; }
  .page-intro { margin-bottom:32px; }
  .eyebrow { display:flex; align-items:center; gap:10px; color:var(--teal); font:11px/1.5 var(--mono); letter-spacing:.13em; text-transform:uppercase; margin:0 0 16px; }
  .eyebrow::before { content:''; width:19px; height:1px; background:currentColor; }
  h1 { font:400 clamp(30px,4vw,44px)/1.2 'Cinzel',Georgia,serif; letter-spacing:-.03em; margin:0 0 14px; }
  .page-intro p:last-child { color:var(--dim); margin:0; }
  .card { background:var(--card); border:1px solid var(--card-border); border-radius:10px; padding:28px; margin:0 0 24px; min-width:0; }
  #loginCard { max-width:490px; }
  h2 { font:400 22px/1.3 'Cinzel',Georgia,serif; letter-spacing:-.02em; margin:0 0 22px; display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:12px; }
  .muted { color:var(--dim); font-size:13px; margin:0 0 16px; }
  label { display:flex; flex-direction:column; gap:7px; font-size:13px; font-weight:500; color:var(--dim); }
  input,select { min-width:0; min-height:44px; background:var(--field); border:1px solid var(--strong); color:var(--white); border-radius:6px; padding:10px 12px; font:400 14px 'DM Sans',system-ui,sans-serif; }
  input::placeholder { color:var(--dim); opacity:.8; }
  input:focus,select:focus { border-color:var(--teal); }
  .grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:20px 24px; }
  .grid .full,.grid button[type=submit] { grid-column:1/-1; }
  .grid button[type=submit] { justify-self:start; }
  button { background:var(--teal); color:var(--on-accent); border:1px solid transparent; border-radius:6px; min-height:44px; padding:10px 18px; font:500 14px 'DM Sans',system-ui,sans-serif; cursor:pointer; }
  button:hover { filter:brightness(1.08); }
  button.ghost { background:transparent; color:var(--white); border-color:var(--strong); font-size:13px; padding:8px 13px; }
  button.ghost:hover { background:var(--field); border-color:var(--dim); }
  button.ghost.danger { color:var(--red); }
  button.ghost.danger:hover { border-color:var(--red); }
  .packs-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .packs-label { color:var(--dim); font-size:13px; font-weight:500; }
  .pack-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:12px; }
  .pack-qty { width:70px; }
  .pack-unit,.pack-x { color:var(--dim); font-size:13px; }
  #packHint { margin:12px 0 0; max-width:650px; }
  .err { color:var(--amber); font-size:13px; margin-top:12px; }
  .err:empty { display:none; }
  #loginForm { display:flex; flex-direction:column; align-items:stretch; gap:18px; }
  #loginForm button { align-self:flex-start; }
  #result { margin-top:24px; padding:18px; background:var(--teal-dim); border:1px solid var(--teal-border); border-radius:6px; }
  .keyrow { display:flex; flex-wrap:wrap; align-items:center; gap:12px; margin-top:8px; }
  #keyValue { font:15px/1.7 var(--mono); color:var(--teal); overflow-wrap:anywhere; }
  .table-scroll { max-width:100%; overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th,td { text-align:left; padding:14px 12px; border-bottom:1px solid var(--card-border); vertical-align:middle; }
  th { font:11px/1.5 var(--mono); letter-spacing:.06em; text-transform:uppercase; color:var(--dim); }
  td:first-child { min-width:160px; overflow-wrap:anywhere; }
  td.actions { white-space:nowrap; }
  .pill { display:inline-block; font:10px/1.5 var(--mono); letter-spacing:.05em; text-transform:uppercase; padding:5px 9px; border-radius:4px; white-space:nowrap; }
  .pill.active,.pill.bound { color:var(--teal); background:var(--teal-dim); border:1px solid var(--teal-border); }
  .pill.revoked,.pill.unbound { color:var(--dim); background:var(--field); border:1px solid var(--strong); }
  .modal-overlay { position:fixed; inset:0; z-index:5000; background:rgba(0,0,0,.66); display:flex; align-items:center; justify-content:center; padding:20px; }
  .modal { background:var(--card); border:1px solid var(--strong); border-radius:10px; padding:28px; width:620px; max-width:100%; max-height:calc(100dvh - 40px); overflow-y:auto; }
  .modal h3 { font:400 24px/1.3 'Cinzel',Georgia,serif; margin:0 0 20px; }
  .modal-row { display:flex; justify-content:space-between; gap:20px; padding:12px 0; border-bottom:1px solid var(--card-border); font-size:14px; }
  .modal-row .k { color:var(--dim); font-size:12px; flex-shrink:0; }
  .modal-row .v { text-align:right; overflow-wrap:anywhere; min-width:0; }
  .modal-row .v code { font:12px/1.7 var(--mono); color:var(--teal); }
  .modal-edit { display:flex; flex-direction:column; gap:7px; padding:12px 0; border-bottom:1px solid var(--card-border); }
  .modal-edit .k,.modal-edit-packs .k { color:var(--dim); font-size:13px; }
  .modal-edit input { width:100%; }
  .modal-edit-packs { padding:12px 0; }
  .modal-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:10px; margin-top:24px; }
  button.crm { background:var(--field); color:var(--dim); border-color:var(--strong); cursor:not-allowed; }
  .settings-sub h3 { font-size:15px; font-weight:500; margin:0 0 8px; }
  .map-preview { margin-top:20px; border:1px solid var(--card-border); border-radius:6px; overflow:hidden; }
  .map-head { font:10px/1.6 var(--mono); letter-spacing:.04em; text-transform:uppercase; color:var(--dim); padding:12px 16px; background:var(--field); }
  .map-row { display:flex; justify-content:space-between; gap:16px; padding:10px 16px; font-size:13px; border-top:1px solid var(--card-border); }
  .map-row .dst { color:var(--teal); font:12px/1.6 var(--mono); text-align:right; }
  .footer { display:flex; justify-content:space-between; gap:20px; flex-wrap:wrap; border-top:1px solid var(--card-border); padding-top:24px; color:var(--dim); font-size:12px; }
  .footer a:hover { color:var(--teal); }
  .audit-notice { display:block; color:var(--teal); font-size:13px; margin-top:18px; }
  .audit-list { list-style:none; padding:0; margin:0; }
  .audit-event { padding:18px 0; border-top:1px solid var(--card-border); }
  .audit-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px; }
  .audit-head strong { font-weight:500; }
  .audit-meta { color:var(--dim); font-size:12px; margin:8px 0 0; overflow-wrap:anywhere; }
  .audit-event details { margin-top:12px; }
  .audit-event summary { cursor:pointer; color:var(--teal); font-size:13px; }
  .audit-changes { margin:12px 0 0; padding:14px; background:var(--field); border-radius:6px; font-size:13px; }
  .audit-changes dt { color:var(--dim); margin-top:12px; }
  .audit-changes dt:first-child { margin-top:0; }
  .audit-changes dd { margin:4px 0 0; overflow-wrap:anywhere; white-space:pre-wrap; }
  .pill.denied,.pill.rate_limited { color:var(--amber); border:1px solid var(--amber); }
  #auditMore { margin-top:16px; }
  @media(max-width:600px) {
    .header-inner { padding:18px 20px; gap:12px; flex-wrap:wrap; }
    .brand { gap:10px; } .wordmark-h { font-size:30px; padding-right:10px; }
    .wordmark-name { font-size:15px; letter-spacing:.13em; } .wordmark-sub { font-size:9px; }
    .header-actions { gap:8px; margin-left:auto; }
    .theme-select { padding:8px; max-width:86px; }
    .wrap { padding:34px 20px 40px; } .card { padding:22px 18px; }
    .grid { grid-template-columns:minmax(0,1fr); gap:18px; }
    h2 { font-size:20px; } .modal { padding:22px 18px; }
    .modal-row { gap:14px; } .modal-row .k { max-width:36%; }
  }
  @media(prefers-reduced-motion:reduce) { *,*::before,*::after { animation:none!important; transition:none!important; } }
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="header-inner">
    <a class="brand" href="https://www.harmonyaio.com/" aria-label="Harmony AIO home">
      <span class="wordmark-h" aria-hidden="true">H</span>
      <span><span class="wordmark-name">Harmony AIO</span><span class="wordmark-sub">License administration</span></span>
    </a>
    <div class="header-actions">
      <select class="theme-select" data-theme-select aria-label="Color theme">
        <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
      </select>
      <button id="logoutBtn" class="ghost" hidden>Sign out</button>
    </div>
  </div>
</header>
<main class="wrap" id="main">
  <div class="page-intro">
    <p class="eyebrow">Administration</p>
    <h1>License control, clearly.</h1>
    <p>Issue keys, manage capacity, and keep customer licenses in view.</p>
    <a id="auditNotice" class="audit-notice" href="#auditCard" hidden>View admin activity ↓</a>
  </div>

  <section id="loginCard" class="card accent" hidden>
    <h2>Sign in</h2>
    <p class="muted">Enter the admin secret to issue license keys.</p>
    <form id="loginForm">
      <label>Admin secret<input type="password" id="password" placeholder="Enter your admin secret" autocomplete="current-password" required></label>
      <button type="submit">Sign in</button>
    </form>
    <div id="loginErr" class="err" role="alert"></div>
  </section>

  <section id="issueCard" class="card accent" hidden>
    <h2>Generate a license key</h2>
    <form id="issueForm" class="grid">
      <label>Tier
        <select id="tier">
          <option value="professional">Professional</option>
          <option value="business" selected>Business</option>
          <option value="enterprise">Enterprise</option>
        </select>
      </label>
      <label>Term
        <select id="term">
          <option value="perpetual" selected>Perpetual</option>
          <option value="monthly">Monthly</option>
          <option value="annual">Annual</option>
          <option value="custom">Custom date</option>
        </select>
      </label>
      <label>Organization
        <input id="org" placeholder="Acme Corp" required>
      </label>
      <label>Contact email
        <input id="email" type="email" placeholder="admin@acme.com" required>
      </label>
      <label>Company ID (optional)
        <input id="companyId" placeholder="CRM / DebtorID">
      </label>
      <label id="expiresWrap" hidden>Expiry date
        <input id="expires" type="date">
      </label>
      <label class="full">Notes (optional)
        <input id="notes" placeholder="sales ref, partner, subscription id, etc.">
      </label>
      <div id="packWrap" class="full">
        <div class="packs-head">
          <span class="packs-label">Endpoint packs</span>
          <button id="addPackBtn" type="button" class="ghost">+ Add pack</button>
        </div>
        <div id="packRows"></div>
        <p class="muted" id="packHint">Each pack adds its size in managed endpoints and 5x that in device inventory. Add as many as the order includes.</p>
      </div>
      <button type="submit">Generate key</button>
    </form>
    <div id="issueErr" class="err" role="alert"></div>
    <div id="result" hidden>
      <span class="muted">New license key</span>
      <div class="keyrow"><code id="keyValue"></code><button id="copyBtn" type="button" class="ghost">Copy</button></div>
    </div>
  </section>

  <section id="listCard" class="card" hidden>
    <h2>Issued licenses <button id="refreshBtn" type="button" class="ghost">Refresh</button></h2>
    <div class="table-scroll" tabindex="0" role="region" aria-label="Issued licenses"><table>
      <thead><tr><th>Organization</th><th>Status</th><th>Bound</th><th>Actions</th></tr></thead>
      <tbody id="licenseBody"></tbody>
    </table></div>
  </section>

  <section id="auditCard" class="card" hidden>
    <h2>Admin activity <button id="auditRefresh" type="button" class="ghost">Show latest</button></h2>
    <p class="muted">License changes and sign-in activity, newest first. Shared admin access identifies a session, not an individual person.</p>
    <p id="auditStatus" class="muted" role="status">Loading activity…</p>
    <div id="auditErr" class="err" role="alert"></div>
    <ol id="auditList" class="audit-list"></ol>
    <button id="auditMore" type="button" class="ghost" hidden>Load older activity</button>
  </section>

  <section id="settingsCard" class="card accent" hidden>
    <h2>Administration settings</h2>
    <div class="settings-sub">
      <h3>CRM Integration</h3>
      <p class="muted">Connect to Dynamics 365 to sync issued licenses to CRM records. When live, you will map license fields to CRM fields here.</p>
      <!-- TODO: wire "Connect to CRM" to Dynamics 365 (D365). On connect, sync each
           license to a CRM record using the field map below, then link back. -->
      <button id="crmBtn" type="button" class="crm" title="Coming soon" disabled>CRM integration · Coming soon</button>
      <div class="map-preview">
        <div class="map-head">Planned field mapping (configurable when the connector ships)</div>
        <div class="map-row"><span class="src">Organization</span><span class="dst">Company Name</span></div>
        <div class="map-row"><span class="src">Company ID</span><span class="dst">DebtorID</span></div>
        <div class="map-row"><span class="src">Contact email</span><span class="dst">Primary Contact</span></div>
        <div class="map-row"><span class="src">Tier &amp; packs</span><span class="dst">Product / Subscription</span></div>
        <div class="map-row"><span class="src">Expires</span><span class="dst">Renewal Date</span></div>
        <div class="map-row"><span class="src">Status / Binding</span><span class="dst">License Status</span></div>
      </div>
    </div>
  </section>
  <footer class="footer"><span>Harmony AIO · License administration</span><a href="https://www.harmonyaio.com/">Visit the website ↗</a></footer>
</main>

<div id="detailOverlay" class="modal-overlay" hidden>
  <div class="modal">
    <h3>License detail</h3>
    <div id="detailBody"></div>
    <div class="modal-actions">
      <button id="detailEditBtn" type="button" class="ghost">Edit</button>
      <button id="forceReleaseBtn" type="button" class="ghost">Release</button>
      <button id="detailRevokeBtn" type="button" class="ghost">Revoke</button>
      <button id="detailRemoveBtn" type="button" class="ghost danger">Remove</button>
      <button id="detailCopyBtn" type="button" class="ghost">Copy key</button>
      <button id="detailSaveBtn" type="button" hidden>Save</button>
      <button id="detailCancelBtn" type="button" class="ghost" hidden>Cancel</button>
      <button id="detailCloseBtn" type="button" class="ghost">Close</button>
    </div>
  </div>
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
      show($('settingsCard'), authed);
      show($('auditCard'), authed);
      show($('auditNotice'), authed);
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

  // ---- endpoint pack editor ----
  function makeSizeSelect() {
    var s = document.createElement('select');
    s.setAttribute('aria-label', 'Endpoints per pack');
    [10, 20, 50, 100].forEach(function (n) {
      var o = document.createElement('option');
      o.value = String(n);
      o.textContent = String(n);
      s.appendChild(o);
    });
    return s;
  }
  function addPackRow(container, size, qty) {
    var row = document.createElement('div');
    row.className = 'pack-row';
    var sel = makeSizeSelect();
    if (size) sel.value = String(size);
    var unit = document.createElement('span');
    unit.className = 'pack-unit';
    unit.textContent = '-endpoint pack';
    var x = document.createElement('span');
    x.className = 'pack-x';
    x.textContent = 'x';
    var q = document.createElement('input');
    q.type = 'number';
    q.setAttribute('aria-label', 'Pack quantity');
    q.min = '1';
    q.value = String(qty || 1);
    q.className = 'pack-qty';
    var rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'ghost';
    rm.textContent = 'Remove';
    rm.addEventListener('click', function () { row.remove(); });
    row.appendChild(sel);
    row.appendChild(unit);
    row.appendChild(x);
    row.appendChild(q);
    row.appendChild(rm);
    container.appendChild(row);
  }
  function gatherPacks(container) {
    var out = [];
    var rows = container.querySelectorAll('.pack-row');
    for (var i = 0; i < rows.length; i++) {
      var size = parseInt(rows[i].querySelector('select').value, 10);
      var qty = parseInt(rows[i].querySelector('input').value, 10);
      if (size > 0 && qty > 0) out.push({ size: size, qty: qty });
    }
    return out;
  }
  $('addPackBtn').addEventListener('click', function () { addPackRow($('packRows')); });

  function syncPack() { show($('packWrap'), $('tier').value !== 'enterprise'); }
  $('tier').addEventListener('change', syncPack);

  function syncTerm() { show($('expiresWrap'), $('term').value === 'custom'); }
  $('term').addEventListener('change', syncTerm);

  $('issueForm').addEventListener('submit', function (e) {
    e.preventDefault();
    $('issueErr').textContent = '';
    show($('result'), false);
    var payload = {
      tier: $('tier').value,
      issued_to_org: $('org').value.trim(),
      contact_email: $('email').value.trim()
    };
    if (payload.tier !== 'enterprise') {
      var packs = gatherPacks($('packRows'));
      if (packs.length > 0) payload.packs = packs;
    }
    var term = $('term').value;
    if (term === 'custom') {
      var exp = $('expires').value;
      if (exp) payload.expires_at = exp + 'T00:00:00Z';
    } else {
      payload.term = term;
    }
    var cid = $('companyId').value.trim();
    if (cid) payload.company_id = cid;
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

  // ---- license actions ----
  function afterAction() { show($('detailOverlay'), false); loadList(); }
  function onRevoke(key) {
    var reason = prompt('Revocation reason for ' + key + '?', 'subscription cancelled');
    if (reason === null) return;
    api('/admin/license/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ license_key: key, reason: reason })
    }).then(afterAction).catch(function (err) { alert(err.message); });
  }
  function onRemove(key) {
    if (!confirm('Permanently remove ' + key + '? This deletes the license and its activation history.')) return;
    api('/admin/license/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ license_key: key })
    }).then(afterAction).catch(function (err) { alert(err.message); });
  }

  // ---- detail modal ----
  var detailKey = '';
  var currentLicense = null;
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function modalRow(k, v, isCode) {
    var row = document.createElement('div');
    row.className = 'modal-row';
    var kk = document.createElement('span');
    kk.className = 'k';
    kk.textContent = k;
    var vv = document.createElement('span');
    vv.className = 'v';
    if (isCode) {
      var c = document.createElement('code');
      c.textContent = v;
      vv.appendChild(c);
    } else {
      vv.textContent = v;
    }
    row.appendChild(kk);
    row.appendChild(vv);
    return row;
  }
  function editField(label, id, val) {
    var wrap = document.createElement('div');
    wrap.className = 'modal-edit';
    var k = document.createElement('span');
    k.className = 'k';
    k.textContent = label;
    var inp = document.createElement('input');
    inp.id = id;
    inp.setAttribute('aria-label', label);
    inp.value = val || '';
    wrap.appendChild(k);
    wrap.appendChild(inp);
    return wrap;
  }
  function renderView(l) {
    var b = $('detailBody');
    b.innerHTML = '';
    b.appendChild(modalRow('License key', l.license_key, true));
    b.appendChild(modalRow('Tier', cap(l.tier)));
    b.appendChild(modalRow('Organization', l.issued_to_org));
    b.appendChild(modalRow('Company ID', l.company_id || 'not set'));
    b.appendChild(modalRow('Contact email', l.contact_email || ''));
    b.appendChild(modalRow('Notes', l.notes || 'none'));
    b.appendChild(modalRow('Endpoint packs', formatPacks(l.packs)));
    b.appendChild(modalRow('Issued', (l.issued_at || '').slice(0, 10)));
    b.appendChild(modalRow('Expires', l.expires_at ? l.expires_at.slice(0, 10) : 'Perpetual'));
    b.appendChild(modalRow('Binding', l.active_instances > 0 ? 'Bound' : 'Unbound'));
    b.appendChild(modalRow('Status', l.revoked_at ? 'Revoked' : 'Active'));
  }
  function editPacks(l) {
    var wrap = document.createElement('div');
    wrap.className = 'modal-edit-packs';
    var head = document.createElement('div');
    head.className = 'packs-head';
    var lab = document.createElement('span');
    lab.className = 'k';
    lab.textContent = 'Endpoint packs';
    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'ghost';
    add.textContent = '+ Add pack';
    head.appendChild(lab);
    head.appendChild(add);
    var rows = document.createElement('div');
    rows.id = 'edPackRows';
    add.addEventListener('click', function () { addPackRow(rows); });
    wrap.appendChild(head);
    wrap.appendChild(rows);
    var existing = [];
    try { existing = JSON.parse(l.packs || '[]'); } catch (e) { existing = []; }
    if (Array.isArray(existing)) {
      existing.forEach(function (p) { addPackRow(rows, p.size, p.qty); });
    }
    var hint = document.createElement('p');
    hint.className = 'muted';
    hint.style.margin = '8px 0 0';
    hint.textContent = 'Each pack adds its size in managed endpoints and 5x that in devices. Saving updates the live license; the customer clicks Re-check Now (or waits up to a day) to pull the new capacity.';
    wrap.appendChild(hint);
    return wrap;
  }
  function renderEdit(l) {
    var b = $('detailBody');
    b.innerHTML = '';
    b.appendChild(editField('Organization', 'edOrg', l.issued_to_org));
    b.appendChild(editField('Contact email', 'edEmail', l.contact_email));
    b.appendChild(editField('Company ID', 'edCompany', l.company_id));
    b.appendChild(editField('Notes', 'edNotes', l.notes));
    if (l.tier !== 'enterprise') b.appendChild(editPacks(l));
  }
  function setEditMode(on) {
    var l = currentLicense;
    if (on) renderEdit(l); else renderView(l);
    show($('detailEditBtn'), !on);
    show($('forceReleaseBtn'), !on && l.active_instances > 0);
    show($('detailRevokeBtn'), !on && !l.revoked_at);
    show($('detailRemoveBtn'), !on);
    show($('detailCopyBtn'), !on);
    show($('detailSaveBtn'), on);
    show($('detailCancelBtn'), on);
  }
  function showDetail(l) {
    currentLicense = l;
    detailKey = l.license_key;
    setEditMode(false);
    show($('detailOverlay'), true);
  }
  $('detailCloseBtn').addEventListener('click', function () { show($('detailOverlay'), false); });
  $('detailOverlay').addEventListener('click', function (e) {
    if (e.target === $('detailOverlay')) show($('detailOverlay'), false);
  });
  $('detailCopyBtn').addEventListener('click', function () {
    navigator.clipboard.writeText(detailKey).then(function () {
      $('detailCopyBtn').textContent = 'Copied';
      setTimeout(function () { $('detailCopyBtn').textContent = 'Copy key'; }, 1500);
    });
  });
  $('forceReleaseBtn').addEventListener('click', function () {
    if (!detailKey) return;
    if (!confirm('Force-release the active binding for ' + detailKey + '? It is unbound from its current server so it can activate on a new one. Use this for migrations or after wiping a server.')) return;
    api('/admin/license/force-release', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ license_key: detailKey })
    }).then(function (d) {
      alert('Released ' + (d.released || 0) + ' binding(s).');
      show($('detailOverlay'), false);
      loadList();
    }).catch(function (err) { alert(err.message); });
  });
  $('detailRevokeBtn').addEventListener('click', function () { if (detailKey) onRevoke(detailKey); });
  $('detailRemoveBtn').addEventListener('click', function () { if (detailKey) onRemove(detailKey); });
  $('detailEditBtn').addEventListener('click', function () { if (currentLicense) setEditMode(true); });
  $('detailCancelBtn').addEventListener('click', function () { setEditMode(false); });
  $('detailSaveBtn').addEventListener('click', function () {
    if (!currentLicense) return;
    var payload = {
      license_key: currentLicense.license_key,
      issued_to_org: $('edOrg').value.trim(),
      contact_email: $('edEmail').value.trim(),
      company_id: $('edCompany').value.trim(),
      notes: $('edNotes').value.trim()
    };
    if (currentLicense.tier !== 'enterprise') payload.packs = gatherPacks($('edPackRows'));
    api('/admin/license/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (d) {
      currentLicense.issued_to_org = payload.issued_to_org;
      currentLicense.contact_email = payload.contact_email;
      currentLicense.company_id = payload.company_id || null;
      currentLicense.notes = payload.notes || null;
      if (d && d.packs !== undefined) {
        currentLicense.packs = (d.packs && d.packs.length > 0) ? JSON.stringify(d.packs) : null;
      }
      setEditMode(false);
      loadList();
    }).catch(function (err) { alert(err.message); });
  });

  function cell(text) {
    var td = document.createElement('td');
    td.textContent = (text === null || text === undefined) ? '' : String(text);
    return td;
  }
  function formatPacks(raw) {
    if (!raw) return 'none';
    try {
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr) || arr.length === 0) return 'none';
      return arr.map(function (p) { return p.qty + 'x' + p.size; }).join(', ');
    } catch (e) { return 'none'; }
  }

  function loadList() {
    loadAudit(false);
    api('/admin/licenses').then(function (d) {
      var body = $('licenseBody');
      body.innerHTML = '';
      (d.licenses || []).forEach(function (l) {
        var tr = document.createElement('tr');
        if (l.revoked_at) tr.className = 'revoked';
        tr.appendChild(cell(l.issued_to_org));
        var statusTd = document.createElement('td');
        var pill = document.createElement('span');
        pill.className = l.revoked_at ? 'pill revoked' : 'pill active';
        pill.textContent = l.revoked_at ? 'revoked' : 'active';
        statusTd.appendChild(pill);
        tr.appendChild(statusTd);
        var boundTd = document.createElement('td');
        var bpill = document.createElement('span');
        var isBound = l.active_instances > 0;
        bpill.className = isBound ? 'pill bound' : 'pill unbound';
        bpill.textContent = isBound ? 'bound' : 'unbound';
        boundTd.appendChild(bpill);
        tr.appendChild(boundTd);
        var actTd = document.createElement('td');
        actTd.className = 'actions';
        var det = document.createElement('button');
        det.type = 'button';
        det.className = 'ghost';
        det.textContent = 'Detail';
        det.addEventListener('click', function () { showDetail(l); });
        actTd.appendChild(det);
        tr.appendChild(actTd);
        body.appendChild(tr);
      });
    }).catch(function () { /* list errors are non-fatal */ });
  }

  // Read-only audit feed. Untrusted customer text is rendered with textContent.
  var auditCursor = null;
  var auditLoading = false;
  var auditShowingOlder = false;
  var auditLabels = {
    'license.created': 'License created', 'license.updated': 'License updated',
    'license.revoked': 'License revoked', 'license.removed': 'License removed',
    'license.released': 'Binding released', 'admin.login': 'Admin sign-in', 'admin.logout': 'Admin sign-out'
  };
  function auditValue(value) {
    if (value === null || value === undefined || value === '') return 'Not set';
    if (Array.isArray(value)) return value.length ? value.map(function (pack) { return pack.qty + ' × ' + pack.size + '-endpoint pack'; }).join(', ') : 'None';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  function auditItem(event) {
    var item = document.createElement('li');
    item.className = 'audit-event';
    var head = document.createElement('div');
    head.className = 'audit-head';
    var title = document.createElement('strong');
    var snapshot = event.after || event.before || {};
    title.textContent = (auditLabels[event.action] || event.action) + (snapshot.organization ? ' · ' + snapshot.organization : '') + (event.license_hint ? ' · ' + event.license_hint : '');
    var badge = document.createElement('span');
    badge.className = 'pill ' + (event.outcome === 'success' ? 'active' : 'denied');
    badge.textContent = event.outcome === 'rate_limited' ? 'Rate limited' : event.outcome;
    head.appendChild(title); head.appendChild(badge); item.appendChild(head);
    var meta = document.createElement('p');
    meta.className = 'audit-meta';
    var actor = event.actor === 'shared-admin-browser' ? 'Shared admin · browser' : event.actor === 'shared-admin-api' ? 'Shared admin · API' : 'Unauthenticated';
    meta.textContent = new Date(event.occurred_at).toLocaleString() + ' · ' + actor + ' · IP: ' + event.client_ip + (event.session_id ? ' · Session: ' + event.session_id : '');
    item.appendChild(meta);
    var details = document.createElement('details');
    var summary = document.createElement('summary');
    summary.textContent = 'View event details'; details.appendChild(summary);
    var fields = document.createElement('dl'); fields.className = 'audit-changes';
    var before = event.before || {}, after = event.after || {};
    var keys = Object.keys(Object.assign({}, before, after));
    var changed = 0;
    keys.forEach(function (key) {
      if (JSON.stringify(before[key]) === JSON.stringify(after[key])) return;
      changed++;
      var label = document.createElement('dt');
      var fieldLabels = { organization: 'Organization', contact_email: 'Contact email', company_id: 'Company ID', tier: 'Tier', pack_endpoints: 'Additional endpoints', packs: 'Endpoint packs', notes: 'Notes', expires_at: 'Expires', revoked_at: 'Revoked', revoked_reason: 'Revocation reason', active_bindings: 'Active bindings' };
      label.textContent = fieldLabels[key] || key;
      var value = document.createElement('dd');
      value.textContent = auditValue(before[key]) + ' → ' + auditValue(after[key]);
      fields.appendChild(label); fields.appendChild(value);
    });
    if (!changed && keys.length) {
      var unchanged = document.createElement('dd'); unchanged.textContent = 'No stored values changed.'; fields.appendChild(unchanged);
    }
    var requestLabel = document.createElement('dt'); requestLabel.textContent = 'Request reference';
    var requestValue = document.createElement('dd'); requestValue.textContent = event.event_id;
    fields.appendChild(requestLabel); fields.appendChild(requestValue);
    var agentLabel = document.createElement('dt'); agentLabel.textContent = 'Browser / client (reported)';
    var agentValue = document.createElement('dd'); agentValue.textContent = event.user_agent;
    fields.appendChild(agentLabel); fields.appendChild(agentValue);
    details.appendChild(fields); item.appendChild(details);
    return item;
  }
  function loadAudit(older) {
    if (auditLoading || $('auditCard').hidden) return;
    auditLoading = true;
    $('auditErr').textContent = '';
    $('auditRefresh').disabled = true; $('auditMore').disabled = true;
    api('/admin/audit' + (older && auditCursor ? '?before=' + auditCursor : '')).then(function (data) {
      // A sign-out may finish while this request is in flight.
      if ($('auditCard').hidden) return;
      if (!older) { $('auditList').textContent = ''; auditShowingOlder = false; }
      else auditShowingOlder = true;
      (data.events || []).forEach(function (event) { $('auditList').appendChild(auditItem(event)); });
      auditCursor = data.next_cursor;
      show($('auditMore'), !!auditCursor);
      $('auditStatus').textContent = $('auditList').children.length ? 'Times shown in your local time zone. Activity refreshes every 30 seconds while viewing the latest page.' : 'No activity recorded yet. History starts when audit logging is enabled.';
      if (!older && data.events && data.events.length) {
        var latest = data.events[0];
        $('auditNotice').textContent = 'Latest activity: ' + (auditLabels[latest.action] || latest.action) + ' · ' + new Date(latest.occurred_at).toLocaleString() + ' ↓';
      }
    }).catch(function () {
      $('auditErr').textContent = 'Activity could not be loaded. Use Show latest to try again.';
      $('auditStatus').textContent = '';
      $('auditNotice').textContent = 'Admin activity unavailable — check activity log ↓';
    }).finally(function () {
      auditLoading = false;
      $('auditRefresh').disabled = false; $('auditMore').disabled = false;
    });
  }
  $('auditRefresh').addEventListener('click', function () { loadAudit(false); });
  $('auditMore').addEventListener('click', function () { loadAudit(true); });
  setInterval(function () {
    if (!document.hidden && !auditShowingOlder && !$('auditList').querySelector('details[open]')) loadAudit(false);
  }, 30000);

  syncPack();
  syncTerm();
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
