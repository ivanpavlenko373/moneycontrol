// Service worker: кешує оболонку додатку, щоб він відкривався без інтернету.
// Запити до Google API не кешуються. Версія береться з js/version.js.
importScripts('js/version.js');
const VERSION = 'v' + self.APP_VERSION;
const CACHE = 'moneycontrol-' + VERSION;
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/version.js', 'js/config.js', 'js/backend.js', 'js/app.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('moneycontrol-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first для власних файлів (щоб оновлення підхоплювались одразу), кеш — як запасний варіант
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
