// Harmony AIO site assistant widget.
//
// Self-contained on purpose: it injects its own styles and markup so adding it
// to a page is one script tag and removing it is deleting that tag. No build
// step, matching the rest of this repo.
//
// The conversation icon distinguishes the assistant from the site wordmark.
(function () {
  "use strict";

  var ENDPOINT = "/api/chat";
  var MAX_TURNS = 6; // 6 user + 6 assistant = the worker's 12 message cap
  var GREETING =
    "Ask me about Harmony AIO, model choice, and early access.  " +
    "Explore Architecture for the public overview.";

  var css = [
    "#hz-launch{position:fixed;right:22px;bottom:22px;z-index:9998;width:52px;height:52px;",
    "border-radius:50%;border:1px solid var(--line-strong);background:var(--panel);",
    "backdrop-filter:blur(8px);cursor:pointer;display:flex;align-items:center;justify-content:center;",
    "box-shadow:0 4px 24px rgba(0,0,0,.18);transition:border-color .18s,transform .18s}",
    "#hz-launch:hover{border-color:var(--teal);transform:translateY(-2px)}",
    "#hz-launch svg{width:22px;height:22px;stroke:var(--teal);fill:none;stroke-width:1.6}",
    "#hz-launch[aria-expanded=true]{opacity:0;pointer-events:none}",

    "#hz-panel{position:fixed;right:22px;bottom:22px;z-index:9999;width:min(380px,calc(100vw - 32px));",
    "height:min(540px,calc(100vh - 44px));display:none;flex-direction:column;overflow:hidden;",
    "background:var(--panel);backdrop-filter:blur(14px);border:1px solid var(--line-strong);",
    "border-radius:16px;box-shadow:0 18px 60px rgba(0,0,0,.18);font-family:'DM Sans',sans-serif;color:var(--text)}",
    "#hz-panel.hz-open{display:flex}",

    "#hz-head{display:flex;align-items:center;gap:10px;padding:14px 16px;",
    "border-bottom:1px solid var(--line);background:var(--raised)}",
    "#hz-head .hz-dot{width:8px;height:8px;border-radius:50%;background:var(--teal);flex:0 0 auto}",
    "#hz-head h2{font-family:'Cinzel',serif;font-weight:400;font-size:13px;letter-spacing:.16em;",
    "text-transform:uppercase;margin:0;flex:1;color:var(--text)}",
    "#hz-close{background:none;border:none;color:var(--muted);font-size:22px;line-height:1;",
    "cursor:pointer;padding:0 2px}",
    "#hz-close:hover{color:var(--teal)}",

    "#hz-log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;",
    "font-size:14px;line-height:1.6;scrollbar-width:thin;scrollbar-color:var(--line-strong) transparent}",
    ".hz-msg{max-width:88%;padding:9px 13px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}",
    ".hz-bot{align-self:flex-start;background:var(--raised);border:1px solid var(--line)}",
    ".hz-you{align-self:flex-end;background:var(--teal-soft);border:1px solid var(--line-strong)}",
    ".hz-err{align-self:flex-start;color:var(--red);font-size:13px}",
    ".hz-wait{align-self:flex-start;color:var(--muted);font-size:13px;font-style:italic}",

    "#hz-form{display:flex;gap:8px;padding:12px;border-top:1px solid var(--line)}",
    "#hz-input{flex:1;min-width:0;background:var(--page);border:1px solid var(--line-strong);",
    "border-radius:9px;padding:10px 12px;color:var(--text);font-family:inherit;font-size:14px}",
    "#hz-input:focus{outline:none;border-color:var(--teal)}",
    "#hz-input::placeholder{color:var(--quiet)}",
    "#hz-send{background:var(--teal);color:var(--on-accent);border:none;border-radius:9px;padding:0 16px;",
    "font-family:inherit;font-weight:500;font-size:13px;cursor:pointer}",
    "#hz-send:disabled{opacity:.45;cursor:default}",
    "#hz-foot{padding:0 12px 11px;font-size:10.5px;letter-spacing:.04em;color:var(--quiet)}",
    "#hz-foot a{text-decoration:underline;text-underline-offset:3px}",
    "#hz-close{min-width:40px;min-height:40px}#hz-send{min-height:44px}",
    "@media (prefers-reduced-motion:reduce){#hz-launch{transition:none}}",
  ].join("");

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var launcher = document.createElement("button");
  launcher.id = "hz-launch";
  launcher.type = "button";
  launcher.setAttribute("aria-expanded", "false");
  launcher.setAttribute("aria-label", "Ask about Harmony AIO");
  launcher.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5.2A8 8 0 1 1 21 12z" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var panel = document.createElement("div");
  panel.id = "hz-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Harmony AIO assistant");
  panel.innerHTML =
    '<div id="hz-head"><span class="hz-dot"></span><h2>Ask Harmony</h2>' +
    '<button id="hz-close" type="button" aria-label="Close">&times;</button></div>' +
    '<div id="hz-log" aria-live="polite"></div>' +
    '<form id="hz-form"><input id="hz-input" aria-label="Ask about Harmony" type="text" autocomplete="off" ' +
    'placeholder="What does Harmony actually do?" maxlength="800">' +
    '<button id="hz-send" type="submit">Send</button></form>' +
    '<div id="hz-foot"><a href="/architecture">Read the public architecture overview</a>.</div>';

  document.body.appendChild(launcher);
  document.body.appendChild(panel);

  var log = panel.querySelector("#hz-log");
  var form = panel.querySelector("#hz-form");
  var input = panel.querySelector("#hz-input");
  var send = panel.querySelector("#hz-send");
  var history = [];
  var busy = false;
  var greeted = false;

  function bubble(text, cls) {
    var el = document.createElement("div");
    el.className = "hz-msg " + cls;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function open() {
    panel.classList.add("hz-open");
    launcher.setAttribute("aria-expanded", "true");
    if (!greeted) {
      greeted = true;
      bubble(GREETING, "hz-bot");
    }
    input.focus();
  }

  function close() {
    panel.classList.remove("hz-open");
    launcher.setAttribute("aria-expanded", "false");
    launcher.focus();
  }

  launcher.addEventListener("click", open);
  panel.querySelector("#hz-close").addEventListener("click", close);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && panel.classList.contains("hz-open")) close();
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || busy) return;

    input.value = "";
    bubble(text, "hz-you");
    history.push({ role: "user", content: text });
    // Keep the tail only. The worker rejects anything longer, and older turns
    // stop mattering fast in a question and answer this short.
    if (history.length > MAX_TURNS * 2) history = history.slice(-MAX_TURNS * 2);

    busy = true;
    send.disabled = true;
    var waiting = bubble("thinking", "hz-wait");

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: history }),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, data: data };
        });
      })
      .then(function (r) {
        waiting.remove();
        if (!r.ok || !r.data.reply) {
          bubble(r.data.error || "Something went wrong.  Try again in a moment.", "hz-err");
          history.pop();
          return;
        }
        bubble(r.data.reply, "hz-bot");
        history.push({ role: "assistant", content: r.data.reply });
      })
      .catch(function () {
        waiting.remove();
        bubble("Could not reach the assistant.  Check your connection.", "hz-err");
        history.pop();
      })
      .finally(function () {
        busy = false;
        send.disabled = false;
        input.focus();
      });
  });
})();
