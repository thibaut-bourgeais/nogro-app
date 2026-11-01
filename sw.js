// Bump CACHE on every deploy so phones pick up the new version.
const CACHE = "nogro-v8";
// Exercise DB files are pinned to a commit, so cache-first forever is safe.
const EXDB_CACHE = "nogro-exdb";
const EXDB_ORIGIN = "https://cdn.jsdelivr.net";
const ASSETS = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== EXDB_CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const origin = new URL(e.request.url).origin;
  if (origin === EXDB_ORIGIN) {
    e.respondWith(
      caches.open(EXDB_CACHE).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      })
    );
    return;
  }
  // Only serve the app shell from cache; API calls (GitHub sync) go straight to the network.
  if (origin !== self.location.origin) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
