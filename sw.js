/**
 * ==========================================
 * Tactical GPS Dashboard - Service Worker (sw.js)
 * ==========================================
 * 提供野外完全无信号离线下的 App 启动和持续运行支持
 * 采用 Stale-While-Revalidate (缓存优先，后台异步刷新) 机制
 */

const CACHE_NAME = 'where-i-am-v6';
const APP_SHELL = './index.html';
const ASSETS = [
  './',
  APP_SHELL,
  './manifest.json',
  './icon.jpg'
];

// 安装阶段缓存静态资源
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll(ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

// 激活阶段清理过期历史缓存
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Stale-While-Revalidate 离线拦截策略
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(e.request.url);
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((networkResponse) => {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(APP_SHELL, responseToCache);
          });
          return networkResponse;
        })
        .catch(() => {
          return caches.match(e.request).then((cachedResponse) => {
            return cachedResponse || caches.match(APP_SHELL);
          });
        })
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      if (cachedResponse) {
        // 后台发起真实网络请求并静默覆盖缓存，保证下一次开启时是最新版
        fetch(e.request).then((networkResponse) => {
          if (networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(e.request, networkResponse);
            });
          }
        }).catch(() => {
          // 离线状态下 fetch 报错，无需任何动作，静默失败
        });
        return cachedResponse;
      }
      return fetch(e.request);
    })
  );
});
