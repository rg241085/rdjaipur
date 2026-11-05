// App ki files phone mein cache hoti hain taaki app jaldi khule.
// Customer ka data, photo aur video kabhi yahan cache nahi hote.
const CACHE = "sample-book-v3";
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
self.addEventListener("push", e => {
  e.waitUntil(self.registration.showNotification("Naya sample aaya hai", {
    body: "Dekhne ke liye yahan dabaiye.", icon: "icon-192.png", badge: "icon-192.png", tag: "new-sample", renotify: true
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    if (list.length) { list[0].postMessage("refresh"); return list[0].focus(); }
    return self.clients.openWindow("./");
  }));
});
