// 离线缓存：App 本身的文件先用网络（保证拿到最新版），没网时用缓存
const CACHE = 'shunlu-v17';
// 地图（离线地图也存在这里），换版本时不要删
const MAP_CACHE = 'shunlu-map';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'geo.js', 'optimizer.js', 'hours.js', 'discover.js', 'days.js', 'icons.js',
  'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-180.png',
  'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js',
  'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== MAP_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // 地图：图块、字体、图标先用手机里存的（没网络也能看）；样式和图块目录先问网络（会更新版本）
  if (url.hostname === 'tiles.openfreemap.org') {
    const fresh = url.pathname.startsWith('/styles/') || url.pathname === '/planet';
    e.respondWith(
      caches.open(MAP_CACHE).then(async (c) => {
        const hit = await c.match(e.request.url);
        if (hit && !fresh) return hit;
        try {
          const res = await fetch(e.request);
          if (res.ok) c.put(e.request.url, res.clone());
          return res;
        } catch (err) {
          if (hit) return hit;
          throw err;
        }
      }),
    );
    return;
  }
  const isShell = url.origin === location.origin || url.hostname === 'cdn.jsdelivr.net';
  if (!isShell) return; // 地图图块、搜索、路线都直接走网络
  // 自己网站的文件：每次都先问服务器有没有新版（没变的话很快，只回 304）
  const req = url.origin === location.origin ? fetch(e.request.url, { cache: 'no-cache' }) : fetch(e.request);
  e.respondWith(
    req
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
