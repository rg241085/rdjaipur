"use strict";
/* Sample Book: sirf server (Supabase) ke functions se baat karta hai. Yahan koi secret nahi rehta. */

var API = (typeof SUPABASE_URL === "string" ? SUPABASE_URL : "").replace(/\/+$/, "");
var KEY = typeof SUPABASE_KEY === "string" ? SUPABASE_KEY : "";
var MAX_PHOTO = 10 * 1048576, SHRINK_OVER = 8 * 1048576, MAX_VIDEO = 40 * 1048576;
var UNITS = ["kg", "gram", "quintal", "piece", "meter", "than", "set", "box", "dozen"];

var state = {
  status: null, session: null, view: "loading", err: "", confirmKey: null,
  catalog: null, q: "", cat: "", itemId: null,
  admin: null, tab: "items", draft: null, custDraft: null, share: null, busy: false,
  installEvent: null, showInstallHelp: false, pushOn: false
};
var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
function isInstalled() { return (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true; }
function pushSupported() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; }
function b64uToBytes(v) {
  var s = atob(v.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((v.length + 3) % 4));
  return Uint8Array.from(s, function (c) { return c.charCodeAt(0); });
}
function bytesToB64u(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ---------- Helpers ---------- */
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function digits(s) { return String(s || "").replace(/\D/g, ""); }
function rs(n) { return "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 }); }
var toastTimer;
function toast(m) {
  var t = $("toast"); t.textContent = m; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3600);
}
function newPin() {
  var a = new Uint32Array(1); crypto.getRandomValues(a);
  return String(100000 + (a[0] % 900000));
}
function appUrl() { return location.origin + location.pathname; }
function loadSession() { try { return JSON.parse(localStorage.getItem("sb_session")); } catch (e) { return null; } }
function saveSession(s) { try { if (s) localStorage.setItem("sb_session", JSON.stringify(s)); else localStorage.removeItem("sb_session"); } catch (e) {} }
function dateText(d) { return d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "Abhi tak nahi"; }
function friendly(e) { return (e && e.message) || "Kuch gadbad hui. Dobara koshish karein."; }

/* ---------- Server ---------- */
async function rpc(fn, args) {
  var r;
  try {
    r = await fetch(API + "/rest/v1/rpc/" + fn, {
      method: "POST",
      headers: { apikey: KEY, "Content-Type": "application/json" },
      body: JSON.stringify(args || {})
    });
  } catch (e) {
    throw new Error("Server se judna nahi ho paya. Internet dekhein aur dobara koshish karein.");
  }
  var j = null;
  try { j = await r.json(); } catch (e) {}
  if (!r.ok) {
    if (j && j.message === "SESSION_END") { endSession("Aapka login khatam ho gaya. Dobara login karein."); throw new Error("SESSION_END"); }
    throw new Error((j && j.message) || "Server ne kaam nahi kiya. Thodi der baad koshish karein.");
  }
  return j;
}
function endSession(msg) {
  state.session = null; state.catalog = null; state.admin = null; saveSession(null);
  state.err = msg || ""; state.view = "login"; render();
}
async function loadCatalog() { state.catalog = await rpc("sb_catalog", { p_token: state.session.token }); }
async function loadAdmin() { state.admin = await rpc("sb_admin_data", { p_token: state.session.token }); }

/* ---------- Cloudinary upload ---------- */
function shrinkPhoto(file) {
  if (file.size <= SHRINK_OVER || !window.createImageBitmap) return Promise.resolve(file);
  return createImageBitmap(file).then(function (bm) {
    var scale = Math.min(1, 2400 / Math.max(bm.width, bm.height));
    var c = document.createElement("canvas");
    c.width = Math.round(bm.width * scale); c.height = Math.round(bm.height * scale);
    c.getContext("2d").drawImage(bm, 0, 0, c.width, c.height);
    return new Promise(function (res) {
      c.toBlob(function (b) { res(b || file); }, "image/jpeg", 0.85);
    });
  }).catch(function () { return file; });
}
function upload(res, file, onProgress) {
  return rpc("sb_sign_upload", { p_token: state.session.token, p_res: res }).then(function (sig) {
    return new Promise(function (ok, fail) {
      var fd = new FormData();
      Object.keys(sig.fields).forEach(function (k) { fd.append(k, sig.fields[k]); });
      fd.append("file", file);
      var x = new XMLHttpRequest();
      x.open("POST", sig.url);
      x.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onerror = function () { fail(new Error("Upload nahi hua. Internet dekhein aur dobara koshish karein.")); };
      x.onload = function () {
        var j = null; try { j = JSON.parse(x.responseText); } catch (e) {}
        if (x.status >= 200 && x.status < 300 && j && j.public_id) ok({ public_id: j.public_id, version: j.version });
        else fail(new Error("Cloudinary ne file nahi li" + (j && j.error ? ": " + j.error.message : ". Settings mein Cloudinary ki details dekhein.")));
      };
      x.send(fd);
    });
  });
}
async function cleanup(list) {
  var failed = 0;
  for (var i = 0; i < (list || []).length; i++) {
    try {
      var fd = new FormData(), f = list[i].fields;
      Object.keys(f).forEach(function (k) { fd.append(k, f[k]); });
      var r = await fetch(list[i].url, { method: "POST", body: fd });
      if (!r.ok) failed++;
    } catch (e) { failed++; }
  }
  if (failed) toast("Purani file Cloudinary se nahi hati. Wahan ki Media Library se hata sakte hain.");
}

/* ---------- Screens ---------- */
function brand() { return esc((state.status && state.status.business_name) || "Sample Book"); }
function mark() { return '<div class="lockmark" aria-hidden="true"><i></i><i></i><i></i></div>'; }
function errBox() { return state.err ? '<div class="err" role="alert">' + esc(state.err) + "</div>" : ""; }

function installBar() {
  if (isInstalled()) return "";
  var label = state.installEvent ? "App install karein" : "App kaise install karein";
  var help = "";
  if (state.showInstallHelp) {
    help = isIos
      ? "<ol><li>Is link ko Safari mein kholiye.</li><li>Neeche Share button dabaiye.</li><li>Add to Home Screen chuniye, phir Add dabaiye.</li></ol>"
      : "<ol><li>Is link ko Chrome mein kholiye. WhatsApp ke andar ho to upar ke menu se Open in Chrome chuniye.</li><li>Upar ke teen dots dabaiye.</li><li>Install app ya Add to Home screen chuniye.</li></ol>";
  }
  return '<div class="tip"><div class="row between"><span class="grow small">Phone par app ki tarah rakhiye, baar baar link nahi kholna padega.</span><button class="btn sm" type="button" data-act="install">' + label + "</button></div>" + help + "</div>";
}
function pushBar() {
  var c = state.catalog;
  if (!c || !c.push_public) return "";
  if (state.pushOn) return '<div class="row between small"><span class="muted">Naye sample ki notification chalu hai.</span><button class="btn link sm" data-act="pushOff">Band karein</button></div>';
  if (isIos && !isInstalled()) return '<div class="tip small">iPhone par notification ke liye pehle app install kijiye, phir usi app se yahan chalu kijiye.</div>';
  if (!pushSupported()) return "";
  if (Notification.permission === "denied") return '<div class="tip small">Notification band hai. Browser ya phone ki settings mein is site ki notification chalu kijiye.</div>';
  return '<div class="tip"><div class="row between"><span class="grow small">Naya sample aate hi phone par pata chalega.</span><button class="btn sm" data-act="pushOn">Notification chalu karein</button></div></div>';
}
async function checkPush() {
  state.pushOn = false;
  if (!pushSupported() || Notification.permission !== "granted") return;
  try {
    var reg = await navigator.serviceWorker.getRegistration();
    var sub = reg && await reg.pushManager.getSubscription();
    if (sub) {
      state.pushOn = true;
      await rpc("sb_push_subscribe", { p_token: state.session.token, p_endpoint: sub.endpoint });
    }
  } catch (e) { if (e.message === "SESSION_END") throw e; }
}
async function pushOn() {
  var perm = await Notification.requestPermission();
  if (perm !== "granted") { render(); toast("Notification ki permission nahi mili."); return; }
  var reg = await navigator.serviceWorker.ready;
  var sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(state.catalog.push_public) });
  await rpc("sb_push_subscribe", { p_token: state.session.token, p_endpoint: sub.endpoint });
  state.pushOn = true; render(); toast("Notification chalu ho gayi");
}
async function pushOff() {
  var reg = await navigator.serviceWorker.getRegistration();
  var sub = reg && await reg.pushManager.getSubscription();
  if (sub) {
    await rpc("sb_push_unsubscribe", { p_token: state.session.token, p_endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  state.pushOn = false;
}
async function ensurePushKeys() {
  if (!state.admin || state.admin.settings.push_public || !window.crypto || !crypto.subtle) return;
  try {
    var pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    var pub = await crypto.subtle.exportKey("raw", pair.publicKey);
    var priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
    await rpc("sb_save_push_keys", { p_token: state.session.token, p_public: bytesToB64u(pub), p_private: JSON.stringify(priv) });
    await loadAdmin();
  } catch (e) {}
}
async function notifyItem(id) {
  try {
    var r = await fetch(API + "/functions/v1/notify", {
      method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ token: state.session.token, item_id: id })
    });
    var j = await r.json();
    if (!r.ok || !j.ok) return "Sample save ho gaya, par notification nahi gayi.";
    if (j.sent) return "Sample save ho gaya. " + j.sent + " phone par notification gayi.";
    return j.failed ? "Sample save ho gaya, par notification nahi gayi." : "Sample save ho gaya. Abhi kisi aise customer ne notification chalu nahi ki.";
  } catch (e) { return "Sample save ho gaya, par notification nahi gayi."; }
}

function vNeedConfig() {
  return '<div class="stack loginwrap">' + mark() + "<h1>Setup baaki hai</h1><p>config.js file mein Supabase ka Project URL aur Publishable key daaliye. Poora tarika PADHO-PEHLE.txt mein likha hai.</p></div>";
}
function vOffline() {
  return '<div class="stack loginwrap">' + mark() + "<h1>Server nahi mil raha</h1><p>" + esc(state.err) +
    '</p><p class="muted small">Agar ye aapka app hai aur Supabase project ruka hua hai, to Supabase ke dashboard se use Restore kijiye.</p><div><button class="btn" data-act="retry">Dobara koshish karein</button></div></div>';
}
function vFirstSetup() {
  function f(id, label, type, hint, extra) {
    return '<div class="field"><label for="' + id + '">' + label + '</label><input id="' + id + '" type="' + type + '" autocomplete="off" ' + (extra || "") + ">" + (hint ? '<span class="muted small">' + hint + "</span>" : "") + "</div>";
  }
  return '<form id="setupForm" class="stack loginwrap" novalidate>' + mark() + "<h1>Pehla setup</h1><p class=\"muted\">Ye sirf ek baar karna hai. API Secret yahan se seedha aapke server par save hogi.</p>" + errBox() +
    f("sc", "Setup code", "text", "Supabase mein setup.sql chalane par mila tha.") +
    f("sb", "Business ka naam", "text", "Customers ko yahi naam dikhega.") +
    f("sn", "Aapka naam", "text") +
    f("sm", "Aapka mobile number", "tel", "", 'inputmode="numeric"') +
    f("sp", "Aapka PIN (6 ank)", "password", "", 'inputmode="numeric"') +
    f("cc", "Cloudinary: Cloud name", "text") +
    f("ck", "Cloudinary: API Key", "text") +
    f("cs", "Cloudinary: API Secret", "password") +
    '<button class="btn" type="submit">Setup poora karein</button></form>';
}
function vLogin() {
  return '<form id="loginForm" class="stack loginwrap" novalidate>' + mark() + "<h1>" + brand() + '</h1><p class="muted">Sample dekhne ke liye apna mobile number aur PIN daaliye.</p>' + errBox() +
    '<div class="field"><label for="lm">Mobile number</label><input id="lm" type="tel" inputmode="numeric" autocomplete="username"></div>' +
    '<div class="field"><label for="lp">PIN</label><input id="lp" type="password" inputmode="numeric" autocomplete="current-password"></div>' +
    '<button class="btn" type="submit">Login karein</button><p class="muted small">PIN nahi hai? Apne dalal se maangiye.</p>' + installBar() + "</form>";
}
function head(title, sub) {
  return '<div class="row between"><div class="grow"><h1>' + esc(title) + '</h1><p class="muted">' + esc(sub) + '</p></div><div class="row"><button class="btn ghost sm" data-act="logout">Bahar niklein</button></div></div>';
}
function vCatalog() {
  var c = state.catalog, n = c.items.length;
  var cats = c.items.map(function (i) { return i.category; }).filter(function (x, i, a) { return x && a.indexOf(x) === i; }).sort();
  var chips = cats.length ? '<div class="chips"><button class="chip" data-act="cat" data-c="" aria-pressed="' + (!state.cat) + '">Sab</button>' +
    cats.map(function (x) { return '<button class="chip" data-act="cat" data-c="' + esc(x) + '" aria-pressed="' + (state.cat === x) + '">' + esc(x) + "</button>"; }).join("") + "</div>" : "";
  return '<div class="stack">' + head(c.me.name, c.business_name + ": aapke liye " + n + " sample") +
    installBar() + pushBar() +
    (n ? '<div class="field"><label for="q">Naam ya code se dhoondiye</label><input id="q" type="search" value="' + esc(state.q) + '"></div>' + chips : "") +
    '<div id="grid"></div><div><button class="btn link sm" data-act="reloadCat">Naye sample dekhein</button></div></div>';
}
function paintGrid() {
  var c = state.catalog, g = $("grid"), q = state.q.trim().toLowerCase();
  var list = c.items.filter(function (i) {
    return (!state.cat || i.category === state.cat) && (!q || (i.name + " " + i.code).toLowerCase().indexOf(q) >= 0);
  });
  if (!list.length) {
    g.className = ""; g.innerHTML = '<p class="muted">' + (c.items.length ? "Is naam ka koi sample nahi mila." : "Abhi aapke liye koi sample nahi hai. Naya sample aate hi yahan dikhega.") + "</p>";
    return;
  }
  g.className = "grid";
  g.innerHTML = list.map(function (i) {
    return '<button class="card" data-act="open" data-id="' + esc(i.id) + '"><div class="swatch"><img alt="" loading="lazy" src="' + esc(i.thumb_url) + '">' + (i.video_url ? '<span class="vidtag">Video</span>' : "") +
      '</div><span class="code">' + esc(i.code) + '</span><span class="name">' + esc(i.name) + '</span><span class="rate">' + rs(i.rate) + " <small>/ " + esc(i.unit) + "</small></span></button>";
  }).join("");
}
function vDetail() {
  var c = state.catalog, i = c.items.filter(function (x) { return x.id === state.itemId; })[0];
  if (!i) return '<div class="stack"><p>Ye sample ab aapke liye nahi hai.</p><div><button class="btn" data-act="back">Wapas jaiye</button></div></div>';
  return '<div class="stack"><div><button class="btn link" data-act="back">← Saare sample</button></div><div class="detail"><div class="stack">' +
    '<div class="swatch full" style="--z:22px"><img alt="' + esc(i.name) + '" src="' + esc(i.photo_url) + '"></div>' +
    (i.video_url ? '<div class="media"><video controls playsinline preload="metadata" controlslist="nodownload" poster="' + esc(i.thumb_url) + '" src="' + esc(i.video_url) + '"></video></div>' : "") +
    '</div><div class="stack tight"><span class="code">' + esc(i.code) + (i.category ? " · " + esc(i.category) : "") + "</span><h1>" + esc(i.name) + '</h1><p class="bigrate">' + rs(i.rate) + ' <span class="rate"><small>/ ' + esc(i.unit) + "</small></span></p>" +
    (i.description ? "<p>" + esc(i.description) + "</p>" : "") +
    "</div></div></div>";
}
function accessPill(i) {
  if (i.access === "all") return '<span class="pill good">Sabhi customers</span>';
  if (i.access === "none") return '<span class="pill bad">Chhupa hua</span>';
  return '<span class="pill">' + i.allowed.length + " chune hue</span>";
}
function confirmBtn(key, act, id, label) {
  return state.confirmKey === key
    ? '<button class="btn danger sm" data-act="' + act + '" data-id="' + esc(id) + '">Pakka ' + label + "</button>"
    : '<button class="btn ghost sm" data-act="ask" data-k="' + key + '">' + label + "</button>";
}
function vAdmin() {
  var a = state.admin, t = state.tab, body = "";
  if (t === "items") {
    body = '<div><button class="btn" data-act="newItem">Naya sample jodiye</button></div>' +
      (a.items.length ? '<div class="list">' + a.items.map(function (i) {
        return '<div class="li"><img class="thumb" alt="" loading="lazy" src="' + esc(i.thumb_url) + '"><div class="info"><div class="code">' + esc(i.code) + (i.category ? " · " + esc(i.category) : "") + (i.video_url ? " · Video" : "") + '</div><div class="name">' + esc(i.name) + '</div><div class="row"><span class="num">' + rs(i.rate) + " / " + esc(i.unit) + "</span>" + accessPill(i) +
          '</div></div><div class="acts"><button class="btn ghost sm" data-act="editItem" data-id="' + esc(i.id) + '">Badliye</button>' + confirmBtn("di" + i.id, "delItem", i.id, "Hataiye") + "</div></div>";
      }).join("") + "</div>" : '<p class="muted">Abhi koi sample nahi hai. Pehla sample jodiye, phir wo aapke customers ko dikhega.</p>');
  } else if (t === "customers") {
    body = '<div><button class="btn" data-act="newCust">Naya customer jodiye</button></div>' +
      (a.customers.length ? '<div class="list">' + a.customers.map(function (c) {
        return '<div class="li"><div class="info"><div class="name">' + esc(c.name) + '</div><div class="row small"><span class="num">' + esc(c.mobile) + '</span><span class="pill ' + (c.active ? "good" : "bad") + '">' + (c.active ? "Login chalu" : "Login band") + "</span>" + (c.push_count ? '<span class="pill">Notification chalu</span>' : "") + '</div><div class="muted small">' + c.visible_count + " sample dikhte hain. Aakhri login: " + esc(dateText(c.last_login)) +
          '</div></div><div class="acts"><button class="btn ghost sm" data-act="toggleCust" data-id="' + esc(c.id) + '" data-on="' + (!c.active) + '">' + (c.active ? "Login band karein" : "Login chalu karein") + '</button><button class="btn ghost sm" data-act="resetPin" data-id="' + esc(c.id) + '">Naya PIN</button>' + confirmBtn("dc" + c.id, "delCust", c.id, "Hataiye") + "</div></div>";
      }).join("") + "</div>" : '<p class="muted">Abhi koi customer nahi hai. Customer jodne par PIN banega, jise WhatsApp par bhej sakte hain.</p>');
  } else {
    var s = a.settings;
    body = '<form id="settingsForm" class="stack form" novalidate><h2>Business aur Cloudinary</h2>' + errBox() +
      '<div class="field"><label for="sb">Business ka naam</label><input id="sb" type="text" value="' + esc(s.business_name) + '"></div>' +
      '<div class="field"><label for="cc">Cloud name</label><input id="cc" type="text" autocomplete="off" value="' + esc(s.cloud_name) + '"></div>' +
      '<div class="field"><label for="ck">API Key</label><input id="ck" type="text" autocomplete="off" value="' + esc(s.api_key) + '"></div>' +
      '<div class="field"><label for="cs">Naya API Secret</label><input id="cs" type="password" autocomplete="new-password"><span class="muted small">Badalna ho tabhi likhiye. Purana secret kabhi wapas nahi dikhta.</span></div>' +
      '<div><button class="btn" type="submit">Settings save karein</button></div></form>' +
      '<form id="pinForm" class="stack form" novalidate><h2>Apna PIN badliye</h2>' +
      '<div class="field"><label for="po">Purana PIN</label><input id="po" type="password" inputmode="numeric" autocomplete="current-password"></div>' +
      '<div class="field"><label for="pn">Naya PIN (6 ank)</label><input id="pn" type="password" inputmode="numeric" autocomplete="new-password"></div>' +
      '<div><button class="btn ghost" type="submit">PIN badliye</button></div></form>';
  }
  function tab(k, l) { return '<button role="tab" aria-selected="' + (t === k) + '" data-act="tab" data-t="' + k + '">' + l + "</button>"; }
  return '<div class="stack">' + head("Admin page", a.items.length + " sample, " + a.customers.filter(function (c) { return c.active; }).length + " customers ka login chalu") +
    '<div class="tabs" role="tablist">' + tab("items", "Samples") + tab("customers", "Customers") + tab("settings", "Settings") + "</div>" + body + "</div>";
}
function vItemForm() {
  var d = state.draft, a = state.admin;
  var units = UNITS.indexOf(d.unit) < 0 && d.unit ? UNITS.concat([d.unit]) : UNITS;
  var cats = a.items.map(function (i) { return i.category; }).filter(function (x, i, l) { return x && l.indexOf(x) === i; });
  function radio(v, l) { return '<label class="check"><input type="radio" name="acc" value="' + v + '"' + (d.access === v ? " checked" : "") + ">" + l + "</label>"; }
  var custs = a.customers.map(function (c) { return '<label class="check"><input type="checkbox" name="al" value="' + esc(c.id) + '"' + (d.allowed.indexOf(c.id) >= 0 ? " checked" : "") + ">" + esc(c.name) + "</label>"; }).join("");
  var previewSrc = d.previewUrl || d.thumb_url;
  return '<form id="itemForm" class="stack form" novalidate><div><button type="button" class="btn link" data-act="toItems">← Wapas</button></div><h1>' + (d.id ? "Sample badliye" : "Naya sample") + "</h1>" + errBox() +
    '<div class="field"><label for="fn">Item ka naam</label><input id="fn" type="text" value="' + esc(d.name) + '"></div>' +
    '<div class="two"><div class="field"><label for="fr">Rate (₹)</label><input id="fr" type="number" min="0" step="0.01" inputmode="decimal" value="' + esc(d.rate) + '"></div><div class="field"><label for="fu">Kiske hisab se</label><select id="fu">' +
    units.map(function (u) { return "<option" + (d.unit === u ? " selected" : "") + ">" + esc(u) + "</option>"; }).join("") + "</select></div></div>" +
    '<div class="field"><label for="fc">Category (chahein to)</label><input id="fc" type="text" list="catlist" value="' + esc(d.category) + '"><datalist id="catlist">' + cats.map(function (c) { return '<option value="' + esc(c) + '">'; }).join("") + "</datalist></div>" +
    '<div class="field"><label for="fd">Jankari (chahein to)</label><textarea id="fd" rows="2">' + esc(d.description) + "</textarea></div>" +
    '<div class="field"><label for="fp">Photo (10 MB tak)</label><div class="row"><img id="pv" class="preview" alt=""' + (previewSrc ? ' src="' + esc(previewSrc) + '"' : " hidden") + '><input id="fp" class="grow" type="file" accept="image/*"></div></div>' +
    '<div class="field"><label for="fv">Video (chahein to, 40 MB tak)</label><input id="fv" type="file" accept="video/*"><span id="vs" class="muted small">' + (d.videoFile ? "Video chun liya: " + esc(d.videoFile.name) : (d.video_url && !d.remove_video ? "Video juda hua hai." : "")) + "</span>" +
    ((d.videoFile || (d.video_url && !d.remove_video)) ? '<div><button type="button" class="btn link sm" data-act="rmVideo">Video hataiye</button></div>' : "") + "</div>" +
    "<fieldset><legend>Kaun dekh sakta hai</legend>" + radio("all", "Sabhi customers") + radio("some", "Sirf chune hue customers") + radio("none", "Kisi ko nahi (chhupa dijiye)") +
    '<div id="alBox" class="stack tight" style="padding-left:28px"' + (d.access === "some" ? "" : " hidden") + ">" + (custs || '<span class="muted small">Pehle customer jodiye.</span>') + "</div></fieldset>" +
    '<label class="check"><input id="fnotify" type="checkbox"' + (d.notify ? " checked" : "") + '>Customers ko notification bhejiye</label>' +
    '<div id="prog" class="stack tight" hidden><span id="progText" class="small"></span><progress id="progBar" max="1" value="0"></progress></div>' +
    '<button id="itemSave" class="btn" type="submit">Sample save karein</button></form>';
}
function vCustForm() {
  var d = state.custDraft;
  return '<form id="custForm" class="stack form" novalidate><div><button type="button" class="btn link" data-act="toCustomers">← Wapas</button></div><h1>Naya customer</h1>' + errBox() +
    '<div class="field"><label for="cn">Customer ya firm ka naam</label><input id="cn" type="text" value="' + esc(d.name) + '"></div>' +
    '<div class="field"><label for="cm">Mobile number (10 ank)</label><input id="cm" type="tel" inputmode="numeric" value="' + esc(d.mobile) + '"></div>' +
    '<div class="field"><label for="cp">PIN (6 ank)</label><input id="cp" type="text" inputmode="numeric" value="' + esc(d.pin) + '"><span class="muted small">Ye PIN sirf abhi dikhega. Baad mein Naya PIN bana sakte hain.</span></div>' +
    '<button class="btn" type="submit">Customer save karein</button></form>';
}
function shareText(s) {
  return "Namaste " + s.name + ",\n" + ((state.status && state.status.business_name) || "Sample Book") + " ke sample dekhne ke liye ye link kholiye:\n" + appUrl() + "\n\nMobile: " + s.mobile + "\nPIN: " + s.pin + "\n\nLogin ke baad App install aur Notification chalu kar lijiye, taaki naya sample aate hi pata chale.\nApna PIN kisi aur ko mat dijiye.";
}
function vShare() {
  var s = state.share, text = shareText(s);
  return '<div class="stack form"><div class="okbox">' + esc(s.name) + " ka login taiyar hai.</div><h1>Customer ko bhejiye</h1><p class=\"muted\">Ye PIN dobara nahi dikhega.</p>" +
    '<div id="shareMsg" class="msgbox">' + esc(text) + '</div><div class="row"><a class="btn" target="_blank" rel="noopener" href="https://wa.me/91' + esc(s.mobile) + "?text=" + encodeURIComponent(text) + '">WhatsApp par bhejiye</a><button class="btn ghost" data-act="copyShare">Message copy karein</button></div>' +
    '<div><button class="btn link" data-act="toCustomers">Customers par wapas</button></div></div>';
}

function render() {
  var map = { loading: function () { return '<p class="muted">Khul raha hai…</p>'; }, needConfig: vNeedConfig, offline: vOffline, firstSetup: vFirstSetup, login: vLogin, catalog: vCatalog, detail: vDetail, admin: vAdmin, itemForm: vItemForm, custForm: vCustForm, share: vShare };
  $("root").innerHTML = map[state.view]();
  document.title = (state.status && state.status.business_name) || "Sample Book";
  if (state.view === "catalog") paintGrid();
}
function go(view) { state.view = view; state.err = ""; state.confirmKey = null; render(); window.scrollTo(0, 0); }
function showErr(e) { if (e && e.message === "SESSION_END") return; state.err = friendly(e); render(); window.scrollTo(0, 0); }

/* ---------- Clicks ---------- */
document.addEventListener("click", async function (e) {
  var b = e.target.closest("[data-act]"); if (!b) return;
  var a = b.dataset.act, id = b.dataset.id;
  try {
    if (a === "retry") { start(); }
    else if (a === "install") {
      if (state.installEvent) { var ev = state.installEvent; state.installEvent = null; ev.prompt(); await ev.userChoice; render(); }
      else { state.showInstallHelp = !state.showInstallHelp; render(); }
    }
    else if (a === "pushOn") { b.disabled = true; await pushOn(); }
    else if (a === "pushOff") { b.disabled = true; await pushOff(); render(); toast("Notification band ho gayi"); }
    else if (a === "logout") { if (state.pushOn) { try { await pushOff(); } catch (x) {} } var t = state.session && state.session.token; endSession(""); if (t) rpc("sb_logout", { p_token: t }).catch(function () {}); }
    else if (a === "cat") { state.cat = b.dataset.c; render(); }
    else if (a === "open") { state.itemId = id; go("detail"); }
    else if (a === "back") { go("catalog"); }
    else if (a === "reloadCat") { b.disabled = true; await loadCatalog(); render(); toast("Sample list taaza ho gayi"); }
    else if (a === "tab") { state.tab = b.dataset.t; go("admin"); }
    else if (a === "ask") { state.confirmKey = b.dataset.k; render(); }
    else if (a === "toItems") { state.tab = "items"; go("admin"); }
    else if (a === "toCustomers") { state.tab = "customers"; state.share = null; await loadAdmin(); go("admin"); }
    else if (a === "newItem") { state.draft = { id: null, name: "", rate: "", unit: "kg", category: "", description: "", access: "all", allowed: [], notify: true }; go("itemForm"); }
    else if (a === "editItem") {
      var it = state.admin.items.filter(function (i) { return i.id === id; })[0];
      state.draft = Object.assign({}, it, { allowed: it.allowed.slice(), notify: false }); go("itemForm");
    }
    else if (a === "rmVideo") { syncDraft(); state.draft.videoFile = null; state.draft.uploadedVideo = null; state.draft.remove_video = !!state.draft.video_url; render(); }
    else if (a === "delItem") {
      b.disabled = true;
      var r = await rpc("sb_delete_item", { p_token: state.session.token, p_id: id });
      await cleanup(r.cleanup); await loadAdmin(); state.confirmKey = null; render(); toast("Sample hata diya");
    }
    else if (a === "newCust") { state.custDraft = { name: "", mobile: "", pin: newPin() }; go("custForm"); }
    else if (a === "toggleCust") {
      b.disabled = true;
      await rpc("sb_set_active", { p_token: state.session.token, p_id: id, p_active: b.dataset.on === "true" });
      await loadAdmin(); state.confirmKey = null; render(); toast(b.dataset.on === "true" ? "Login chalu kar diya" : "Login band kar diya. Customer ab andar nahi ja sakta.");
    }
    else if (a === "resetPin") {
      b.disabled = true;
      var c = state.admin.customers.filter(function (x) { return x.id === id; })[0], pin = newPin();
      await rpc("sb_reset_pin", { p_token: state.session.token, p_id: id, p_pin: pin });
      state.share = { name: c.name, mobile: c.mobile, pin: pin }; go("share");
    }
    else if (a === "delCust") {
      b.disabled = true;
      await rpc("sb_delete_customer", { p_token: state.session.token, p_id: id });
      await loadAdmin(); state.confirmKey = null; render(); toast("Customer hata diya");
    }
    else if (a === "copyShare") {
      var text = shareText(state.share);
      try { await navigator.clipboard.writeText(text); toast("Message copy ho gaya"); }
      catch (err) { var rng = document.createRange(); rng.selectNodeContents($("shareMsg")); var sel = getSelection(); sel.removeAllRanges(); sel.addRange(rng); toast("Message select ho gaya. Ab copy kar lijiye."); }
    }
  } catch (err) {
    if (err.message !== "SESSION_END") { toast(friendly(err)); b.disabled = false; }
  }
});
document.addEventListener("input", function (e) { if (e.target.id === "q") { state.q = e.target.value; paintGrid(); } });
function syncDraft() {
  var d = state.draft; if (!d || !$("fn")) return;
  d.notify = $("fnotify").checked; d.name = $("fn").value; d.rate = $("fr").value; d.unit = $("fu").value; d.category = $("fc").value; d.description = $("fd").value;
  var r = document.querySelector("input[name=acc]:checked"); d.access = r ? r.value : "all";
  d.allowed = [].slice.call(document.querySelectorAll("input[name=al]:checked")).map(function (x) { return x.value; });
}
document.addEventListener("change", function (e) {
  var t = e.target;
  if (t.name === "acc") $("alBox").hidden = t.value !== "some";
  if (t.id === "fp" && t.files[0]) { state.draft.photoFile = t.files[0]; state.draft.uploadedPhoto = null; state.draft.previewUrl = URL.createObjectURL(t.files[0]); var p = $("pv"); p.src = state.draft.previewUrl; p.hidden = false; }
  if (t.id === "fv" && t.files[0]) {
    var v = t.files[0];
    if (v.size > MAX_VIDEO) { t.value = ""; state.draft.videoFile = null; $("vs").textContent = "Ye video 40 MB se bada hai. Chhota video chuniye."; return; }
    syncDraft(); state.draft.videoFile = v; state.draft.uploadedVideo = null; state.draft.remove_video = false; render();
  }
});

/* ---------- Forms ---------- */
document.addEventListener("submit", async function (e) {
  e.preventDefault();
  if (state.busy) return;
  var f = e.target, btn = f.querySelector("button[type=submit]");
  state.busy = true; if (btn) btn.disabled = true;
  try {
    if (f.id === "setupForm") await submitSetup();
    else if (f.id === "loginForm") await submitLogin();
    else if (f.id === "itemForm") await submitItem();
    else if (f.id === "custForm") await submitCustomer();
    else if (f.id === "settingsForm") await submitSettings();
    else if (f.id === "pinForm") await submitPin();
  } catch (err) {
    showErr(err);
  } finally {
    state.busy = false;
    var nb = document.querySelector("form button[type=submit][disabled]"); if (nb) nb.disabled = false;
  }
});
async function submitSetup() {
  var m = digits($("sm").value), p = $("sp").value.trim();
  await rpc("sb_first_setup", { p_code: $("sc").value.trim(), p_business: $("sb").value, p_name: $("sn").value, p_mobile: m, p_pin: p,
    p_cloud_name: $("cc").value.trim(), p_api_key: $("ck").value.trim(), p_api_secret: $("cs").value.trim() });
  state.status = await rpc("sb_status");
  await doLogin(m, p);
}
async function doLogin(m, p) {
  var r = await rpc("sb_login", { p_mobile: m, p_pin: p });
  if (!r.ok) { state.err = r.error; state.view = "login"; render(); return; }
  state.session = { token: r.token, role: r.role, name: r.name, mobile: r.mobile }; saveSession(state.session);
  await openHome();
}
async function submitLogin() { await doLogin(digits($("lm").value), $("lp").value.trim()); }
async function openHome() {
  if (state.session.role === "admin") { await loadAdmin(); await ensurePushKeys(); state.tab = "items"; go("admin"); }
  else { await loadCatalog(); await checkPush(); go("catalog"); }
}
async function submitItem() {
  syncDraft();
  var d = state.draft, err = !d.name.trim() ? "Item ka naam likhiye." : (d.rate === "" || Number(d.rate) < 0) ? "Rate sahi likhiye." : (!d.id && !d.photoFile && !d.uploadedPhoto) ? "Photo chuniye." : (d.access === "some" && !d.allowed.length) ? "Kam se kam ek customer chuniye." : "";
  if (err) { state.err = err; render(); window.scrollTo(0, 0); return; }
  var prog = $("prog"), bar = $("progBar"), txt = $("progText");
  function step(label) { return function (x) { txt.textContent = label + " " + Math.round(x * 100) + "%"; bar.value = x; }; }
  prog.hidden = false;
  var payload = { id: d.id, name: d.name, rate: d.rate, unit: d.unit, category: d.category, description: d.description, access: d.access, allowed: d.allowed, remove_video: !!d.remove_video };
  if (d.photoFile) {
    step("Photo taiyar ho rahi hai")(0);
    var ph = await shrinkPhoto(d.photoFile);
    if (ph.size > MAX_PHOTO) throw new Error("Ye photo 10 MB se badi hai. Chhoti photo chuniye.");
    payload.photo = await upload("image", ph, step("Photo upload ho rahi hai"));
    d.photoFile = null; d.uploadedPhoto = payload.photo;
  } else if (d.uploadedPhoto) { payload.photo = d.uploadedPhoto; }
  if (d.videoFile) {
    payload.video = await upload("video", d.videoFile, step("Video upload ho rahi hai"));
    d.videoFile = null; d.uploadedVideo = payload.video;
  } else if (d.uploadedVideo) { payload.video = d.uploadedVideo; }
  txt.textContent = "Save ho raha hai…";
  var r = await rpc("sb_save_item", { p_token: state.session.token, p_item: payload });
  await cleanup(r.cleanup);
  var doneMsg = "Sample save ho gaya";
  if (d.notify && d.access !== "none") { txt.textContent = "Notification ja rahi hai…"; doneMsg = await notifyItem(r.id); }
  await loadAdmin();
  state.tab = "items"; state.draft = null; go("admin"); toast(doneMsg);
}
async function submitCustomer() {
  var d = { name: $("cn").value.trim(), mobile: digits($("cm").value), pin: $("cp").value.trim() }; state.custDraft = d;
  await rpc("sb_add_customer", { p_token: state.session.token, p_name: d.name, p_mobile: d.mobile, p_pin: d.pin });
  await loadAdmin(); state.share = d; go("share");
}
async function submitSettings() {
  await rpc("sb_save_settings", { p_token: state.session.token, p_business: $("sb").value, p_cloud_name: $("cc").value.trim(), p_api_key: $("ck").value.trim(), p_api_secret: $("cs").value.trim() });
  state.status = await rpc("sb_status"); await loadAdmin(); state.err = ""; render(); toast("Settings save ho gayi");
}
async function submitPin() {
  await rpc("sb_change_pin", { p_token: state.session.token, p_old: $("po").value.trim(), p_new: $("pn").value.trim() });
  $("po").value = ""; $("pn").value = ""; state.err = ""; render(); toast("PIN badal gaya");
}

/* ---------- Start ---------- */
async function start() {
  if (!/^https:\/\/.+/.test(API) || !KEY || /^YAHAN/.test(KEY)) { state.view = "needConfig"; render(); return; }
  state.view = "loading"; state.err = ""; render();
  try {
    state.status = await rpc("sb_status");
  } catch (e) { state.err = friendly(e); state.view = "offline"; render(); return; }
  if (!state.status.setup_done) { state.view = "firstSetup"; render(); return; }
  state.session = loadSession();
  if (!state.session) { state.view = "login"; render(); return; }
  try { await openHome(); }
  catch (e) { if (e.message !== "SESSION_END") { state.err = friendly(e); state.view = "offline"; render(); } }
}
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(function () {});
  navigator.serviceWorker.addEventListener("message", function (e) {
    if (e.data === "refresh" && state.session && state.session.role === "customer") loadCatalog().then(function () { if (state.view === "catalog") render(); }).catch(function () {});
  });
}
window.addEventListener("beforeinstallprompt", function (e) {
  e.preventDefault(); state.installEvent = e;
  if (state.view === "login" || state.view === "catalog") render();
});
window.addEventListener("appinstalled", function () {
  state.installEvent = null; if (state.view === "login" || state.view === "catalog") render();
});
start();
