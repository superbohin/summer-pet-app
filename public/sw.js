const APP_VERSION = "0.5.2";
const SCOPE_URL = new URL(self.registration.scope);
const SCOPE_KEY = SCOPE_URL.pathname.replace(/[^a-z0-9]+/gi, "-") || "root";
const CACHE_PREFIX = `summer-pet-shell-${SCOPE_KEY}-`;
const CACHE_NAME = `${CACHE_PREFIX}${APP_VERSION}`;
const BUILD_ASSETS = [];
const scopedUrl = (path = "") => new URL(String(path).replace(/^\/+/, ""), SCOPE_URL).toString();
const APP_SHELL = [
  scopedUrl("/"),
  scopedUrl("/manifest.webmanifest"),
  scopedUrl("/version.json"),
  scopedUrl("/icon-192.png"),
  scopedUrl("/icon-512.png"),
  scopedUrl("/apple-touch-icon.png"),
  ...BUILD_ASSETS.map(scopedUrl),
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const hadOlderVersion = keys.some((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);
    await Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key)),
    );
    await self.clients.claim();
    if (hadOlderVersion) {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      clients.forEach((client) => client.postMessage({ type: "APP_UPDATE_READY", version: APP_VERSION }));
    }
  })());
});

async function cacheSuccessfulResponse(request, response) {
  if (response?.ok) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, fallbackToRoot = false) {
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error("network timeout")), 4500)),
    ]);
    return await cacheSuccessfulResponse(request, response);
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (fallbackToRoot) {
      const root = await caches.match(scopedUrl("/")) ?? await caches.match("/");
      if (root) return root;
    }
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    return await cacheSuccessfulResponse(request, await fetch(request));
  } catch {
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then((response) => cacheSuccessfulResponse(request, response))
    .catch(() => null);
  return cached ?? await network ?? new Response("Offline", { status: 503, statusText: "Offline" });
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(networkFirst(event.request, true));
    return;
  }

  if (
    requestUrl.pathname === new URL("version.json", SCOPE_URL).pathname ||
    requestUrl.pathname === "/version.json"
  ) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  if (requestUrl.pathname.includes("/assets/")) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  event.respondWith(staleWhileRevalidate(event.request));
});
