self.addEventListener('install', e => {
  e.waitUntil(
    caches.open('cijenemeal-pwa-v1').then(cache => {
      return cache.addAll(['./index.html', './app.js', './db.js', './zip.js', './styles.css', './manifest.json']);
    })
  );
});
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(response => response || fetch(e.request))
  );
});