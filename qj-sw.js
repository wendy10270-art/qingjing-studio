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
  // 跨網域的請求（例如 line-webhook 的 API）跟非 GET 請求（POST/PUT…）完全不攔截，
  // 交給瀏覽器原生處理就好——cache-first 這套策略是給同網域的靜態資源用的，
  // 硬要把它套用在跨網域 POST 上，在 Safari/PWA 環境會直接丟出
  // 「FetchEvent.respondWith received an error: TypeError: Load failed」
  // （簽到後點「透過 LINE 直接傳送」失敗就是這個原因）。
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) {
    return;
  }
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
