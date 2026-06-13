// 輕境 Service Worker — 每次開啟都從伺服器拿最新版本
const CACHE = 'qingjing-v1';

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(['./']))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // 主頁面：network-first（一定先抓最新，離線才用快取）
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request, {cache: 'no-cache'})
        .then(r => {
          if (r.ok) {
            caches.open(CACHE).then(c => c.put(e.request, r.clone()));
            // 通知所有開著的頁面可以重新整理了
            self.clients.matchAll({type: 'window'}).then(clients => {
              clients.forEach(client => client.postMessage({type: 'SW_UPDATED'}));
            });
          }
          return r;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  // 其他資源：cache-first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
