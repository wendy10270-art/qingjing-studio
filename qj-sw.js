// 輕境 Service Worker — 每次開啟都從伺服器拿最新版本
const CACHE = 'qingjing-v2';

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
            // clone() 一定要在這裡（拿到 r 的當下）同步呼叫，不能等 caches.open() 這個
            // 非同步操作 resolve 後才 clone——那段等待期間瀏覽器可能已經開始消費 r 的
            // body 去渲染頁面，body 一旦被讀過，clone() 就會丟「body 已經被使用」的錯誤。
            const copy = r.clone();
            const copyForDiff = r.clone();
            caches.open(CACHE).then(async c => {
              // 只有在「這頁本來就有快取，而且內容真的變了」時才通知頁面有新版本，
              // 避免每次載入都跳「有新版本」（SW_UPDATED 本來每次 navigate 都會發）。
              let changed = false;
              try {
                const prev = await c.match(e.request);
                if (prev) {
                  const [a, b] = await Promise.all([prev.text(), copyForDiff.text()]);
                  changed = a !== b;
                }
              } catch (err) {}
              await c.put(e.request, copy);
              if (changed) {
                const clients = await self.clients.matchAll({type: 'window'});
                clients.forEach(client => client.postMessage({type: 'SW_UPDATED'}));
              }
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
