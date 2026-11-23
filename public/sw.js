// Einfacher Offline-Cache: App-Dateien zuerst aus dem Netz, sonst aus dem Cache.
const CACHE = 'giesbert-v3';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'plants.js', 'icon.svg', 'manifest.webmanifest'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Daten kommen immer frisch vom Server (die App hat eine eigene Offline-Kopie); Bilder dürfen in den Cache
  if (url.pathname.includes('/api/') && !url.pathname.endsWith('/image')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      // Nur echte Antworten merken – keine Umleitungen zur Portal-Anmeldung
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request, {ignoreSearch: true}))
  );
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type: 'window'}).then(list => list.length ? list[0].focus() : self.clients.openWindow('./')));
});
