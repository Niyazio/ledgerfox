/*
 * LedgerFox service worker.
 * - App shell (HTML, JS, CSS, icons) is precached so the app opens without a connection.
 * - API GETs are network-first; successful JSON responses are kept on this device and served when offline.
 * - Writes (POST/PUT/DELETE) are never handled here; the page queues them in IndexedDB (see src/web/lib/offline.ts).
 */
const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const SHELL = `lf-shell-${VERSION}`;
const API = "lf-api-v1";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const res = await fetch("/precache-manifest.json", { cache: "no-store" });
    const { files } = await res.json();
    const cache = await caches.open(SHELL);
    await cache.addAll(files);
    // First install takes over immediately; updates wait until every tab is closed so open pages keep their chunks.
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith("lf-shell-") && name !== SHELL) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) {
    if (url.pathname === "/api/health") return;
    event.respondWith(apiNetworkFirst(req));
  } else if (req.mode === "navigate") {
    event.respondWith(navigation(req));
  } else {
    event.respondWith(cacheFirst(req));
  }
});

const offlineJson = (message) =>
  new Response(JSON.stringify({ error: { code: "OFFLINE", message } }), { status: 503, headers: { "content-type": "application/json" } });

async function apiNetworkFirst(req) {
  try {
    const res = await fetch(req);
    // Only JSON is kept: exports, receipts and other downloads are never stored on the device.
    if (res.ok && (res.headers.get("content-type") || "").includes("application/json")) {
      const cache = await caches.open(API);
      await cache.put(req, res.clone());
    }
    return res;
  } catch {
    const hit = await caches.match(req, { cacheName: API });
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set("x-ledgerfox-offline", "1");
      return new Response(hit.body, { status: hit.status, headers });
    }
    return offlineJson("You're offline and this page hasn't been saved on this device yet. Open it once while online to make it available offline.");
  }
}

async function navigation(req) {
  try {
    return await fetch(req);
  } catch {
    return (await caches.match("/", { cacheName: SHELL })) || new Response("LedgerFox is offline and not yet installed on this device.", { status: 503 });
  }
}

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // Unknown paths fall back to index.html (SPA); never store that HTML under an asset URL.
  if (res.ok && !(res.headers.get("content-type") || "").includes("text/html")) {
    const cache = await caches.open(SHELL);
    await cache.put(req, res.clone());
  }
  return res;
}
