const CACHE_NAME = "genie-voice-v1";

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener("fetch", (e) => {
  // Network-first strategy (voice app needs live connection)
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
