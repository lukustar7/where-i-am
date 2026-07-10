/**
 * Where I AM 离线缓存。
 *
 * 页面导航采用网络优先：在线时立即得到最新版，断网时回退到已缓存入口。
 * 静态资源采用缓存优先并在后台更新：快速启动的同时为下一次打开准备新文件。
 */

const CACHE_PREFIX = 'where-i-am-';
const CACHE_NAME = 'where-i-am-v7';
const APP_SHELL = './index.html';
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './icon.jpg',
  './js/app.js',
  './js/geo.js',
  './js/heading.js'
];

function canCache(response) {
  return response
    && response.ok
    && (response.type === 'basic' || response.type === 'default');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          // Cache Storage 以域名为单位共享，只清理由本应用创建的缓存，避免误删同域其他项目。
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

async function respondToNavigation(request) {
  try {
    const networkResponse = await fetch(request);
    if (canCache(networkResponse)) {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(APP_SHELL, networkResponse.clone());
      } catch (error) {
        // 存储空间不足只影响下次离线回退，不能阻断本次已经成功的在线响应。
        console.warn('Navigation cache update failed:', error);
      }
    }
    return networkResponse;
  } catch {
    const exactMatch = await caches.match(request);
    const appShell = exactMatch || await caches.match(APP_SHELL);
    return appShell || new Response('Offline application shell is unavailable.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

function respondToStaticAsset(event) {
  const cachedResponsePromise = caches.match(event.request);
  const networkResponsePromise = fetch(event.request);
  const cacheUpdatePromise = networkResponsePromise.then(async (networkResponse) => {
    if (canCache(networkResponse)) {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, networkResponse.clone());
      } catch (error) {
        console.warn('Static asset cache update failed:', error);
      }
    }
  });

  // 把后台更新交给 waitUntil，防止响应缓存后 Service Worker 被浏览器提前终止。
  event.waitUntil(cacheUpdatePromise.catch(() => undefined));

  return cachedResponsePromise.then(async (cachedResponse) => {
    if (cachedResponse) {
      return cachedResponse;
    }

    try {
      return await networkResponsePromise;
    } catch {
      return new Response('Offline resource is unavailable.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  });
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(respondToNavigation(event.request));
    return;
  }

  event.respondWith(respondToStaticAsset(event));
});
