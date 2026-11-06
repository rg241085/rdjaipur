// App ki files phone mein cache hoti hain taaki app jaldi khule.
// Customer ka data, photo aur video kabhi yahan cache nahi hote.
try { importScripts("config.js"); } catch (e) {}
const CACHE = "sample-book-v4";
const SHELL = ["./", "./index.html", "./app.js", "./config.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./icon-maskable.png", "./apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match("./index.html"))));
});
function kv(mode, work) {
  return new Promise((ok, fail) => {
    const open = indexedDB.open("sample-book", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => fail(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("kv", mode), req = work(tx.objectStore("kv"));
      tx.oncomplete = () => { open.result.close(); ok(req && req.result); };
      tx.onerror = () => { open.result.close(); fail(tx.error); };
    };
  });
}
function money(n) { return "\u20B9" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 }); }
async function pickNote() {
  const token = await kv("readonly", s => s.get("token"));
  if (!token) return null;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
  let r;
  try {
    r = await fetch(SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/rpc/sb_push_latest", {
      method: "POST", headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ p_token: token }), signal: ctl.signal
    });
  } finally { clearTimeout(timer); }
  if (!r.ok) return null;
  const items = await r.json();
  if (!items.length) return null;
  const shown = (await kv("readonly", s => s.get("shown"))) || [];
  const it = items.find(x => shown.indexOf(x.id) < 0) || items[0];
  await kv("readwrite", s => s.put([it.id].concat(shown.filter(x => x !== it.id)).slice(0, 20), "shown"));
  const line = [money(it.rate) + " / " + it.unit, it.category].filter(Boolean).join(" \u00B7 ");
  const desc = (it.description || "").slice(0, 100);
  return {
    title: "Naya sample: " + it.name,
    options: {
      body: desc ? line + "\n" + desc : line, image: it.image_url, tag: "item-" + it.id,
      data: { url: "./#item-" + it.id, id: it.id }, actions: [{ action: "open", title: "Sample dekhiye" }]
    }
  };
}
async function handlePush() {
  let note = null;
  try { note = await pickNote(); } catch (e) {}
  if (!note) note = { title: "Naya sample aaya hai", options: { body: "Dekhne ke liye yahan dabaiye.", tag: "new-sample", data: { url: "./" } } };
  return self.registration.showNotification(note.title, Object.assign({ icon: "icon-192.png", badge: "icon-192.png", renotify: true }, note.options));
}
self.addEventListener("push", e => { e.waitUntil(handlePush()); });
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const d = e.notification.data || {};
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    if (list.length) { list[0].postMessage({ refresh: true, open: d.id || null }); return list[0].focus(); }
    return self.clients.openWindow(d.url || "./");
  }));
});
