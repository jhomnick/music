// Offline shell for the Music app. Network-first so GitHub Pages updates show up right away;
// falls back to the cached copy when offline. Never caches OneDrive/Graph/music traffic.
const CACHE = 'music-shell-v2';
const SHELL = ['./', 'index.html', 'css/app.css', 'vendor/msal-browser.min.js', 'manifest.webmanifest', 'icons/icon.svg',
  'js/main.js', 'js/util.js', 'js/db.js', 'js/prefs.js', 'js/auth.js', 'js/graph.js', 'js/library.js', 'js/userdata.js',
  'js/sync.js', 'js/formats.js', 'js/view.js', 'js/mix.js', 'js/player.js', 'js/scanner.js', 'js/playlists.js', 'js/tags.js',
  'js/art.js', 'js/source.js', 'js/enrich.js', 'js/table.js', 'js/demo.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
