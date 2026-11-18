/* Shared offline cache for trip pages. Each trip's sw.js sets
 *   self.TRIP_SW = { version: "<family>-trip-<trip>-vN", assets: [...] }
 * and then importScripts() this file. The service worker lives in the trip
 * folder so its scope is that trip, but it also caches the shared engine in
 * /trip-app/.
 *
 * It precaches everything on install, then serves cache-first with a
 * background refresh: the app opens instantly in airplane mode and quietly
 * picks up edits when back online. API calls (/api/...) are never cached
 * here; the app keeps its own copy of the data in localStorage.
 */
const { version: VERSION, assets: ASSETS } = self.TRIP_SW;
const SCOPE_PATH = new URL("./", location.href).pathname;   // e.g. /beach-2027/
const SHARED_PATH = new URL("../trip-app/", location.href).pathname;

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // One at a time, keeping only real 200s. If the Cloudflare Access session
    // has lapsed, responses are redirects to the login page; don't cache those.
    for (const path of ASSETS) {
      try {
        const res = await fetch(new Request(path, { cache: "reload", redirect: "manual" }));
        if (res.ok && res.type === "basic") await cache.put(new URL(path, location.href).href, res);
      } catch { /* offline during install: the next visit will retry */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    // Only clean up this trip's old caches (other trips share the prefix).
    const mine = VERSION.replace(/-v\d+$/, "-v");
    for (const key of await caches.keys()) {
      const legacy = (self.TRIP_SW.legacyCaches || []).includes(key);
      if ((key.startsWith(mine) && key !== VERSION) || legacy) await caches.delete(key);
    }
    await self.clients.claim();
    for (const c of await self.clients.matchAll()) c.postMessage({ type: "cached" });
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (!url.pathname.startsWith(SCOPE_PATH) && !url.pathname.startsWith(SHARED_PATH)) return;

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    // Navigations ignore query strings (?date=… preview links) and map to the shell.
    const key = req.mode === "navigate" ? new URL("./", location.href).href : url.href.split("?")[0];
    const cached = await cache.match(key);

    const refresh = fetch(new Request(req.url, { redirect: "manual", cache: "no-cache" }))
      .then(async res => {
        if (res.ok && res.type === "basic") { await cache.put(key, res.clone()); return res; }
        return null;
      })
      .catch(() => null);

    if (cached) {
      event.waitUntil(refresh);
      return cached;
    }
    const fresh = await refresh;
    if (fresh) return fresh;
    // Not cached and the network failed or bounced to a login page: let the
    // browser handle it normally (this shows the Access login when online).
    return fetch(req);
  })());
});
