/* Offline support, network first:
 * - Online: always fetch the latest file from the server (revalidated with ETag, so it's cheap)
 *   and refresh the offline copy. Deploys show up on the next load with no version bumps.
 * - Offline (or server unreachable within a few seconds): serve the saved copy. */
const CACHE = "l7zip";
const ASSETS = [
  "./", "index.html", "styles.css", "app.js", "vendor/zip.min.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: "no-cache" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  // Remove caches from older versions of this app (e.g. "lockbox-v1", "l7zip-v1").
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);
  try {
    const res = await fetch(req, { cache: "no-cache", signal: ctrl.signal });
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  } catch {
    const hit = await caches.match(req, { ignoreSearch: true });
    return hit || Response.error();
  } finally {
    clearTimeout(timer);
  }
}
