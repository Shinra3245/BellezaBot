// Service worker mínimo para que el panel sea instalable como PWA.
// Estrategia network-first simple (sin cache agresivo: el panel siempre debe reflejar datos frescos).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  // Solo intercepta navegaciones para dar un fallback offline básico; el resto pasa directo a la red.
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/')));
  }
});
