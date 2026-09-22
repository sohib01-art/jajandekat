// This is the "Offline page" service worker, extended with
// Background Sync and Periodic Background Sync support.

importScripts('https://storage.googleapis.com/workbox-cdn/releases/5.1.2/workbox-sw.js');

const CACHE = "pwabuilder-page";

const offlineFallbackPage = "offline.html";

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener('install', async (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.add(offlineFallbackPage))
  );
});

if (workbox.navigationPreload.isSupported()) {
  workbox.navigationPreload.enable();
}

self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const preloadResp = await event.preloadResponse;

        if (preloadResp) {
          return preloadResp;
        }

        const networkResp = await fetch(event.request);
        return networkResp;
      } catch (error) {

        const cache = await caches.open(CACHE);
        const cachedResp = await cache.match(offlineFallbackPage);
        return cachedResp;
      }
    })());
  }
});

// ---- Background Sync ----
// Lets the app queue an action (e.g. "update status jualan pedagang")
// while offline, and retry automatically once the device reconnects.
// From the page: navigator.serviceWorker.ready.then(reg => reg.sync.register('sync-status-pedagang'));
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-status-pedagang') {
    event.waitUntil(syncPedagangStatus());
  }
});

async function syncPedagangStatus() {
  // TODO: ganti dengan endpoint API asli JajanDekat untuk kirim status pedagang
  // yang tersimpan di IndexedDB/cache saat offline.
  try {
    const pending = await getPendingUpdatesFromIndexedDB();
    for (const update of pending) {
      await fetch('/api/pedagang/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update)
      });
    }
  } catch (err) {
    // Melempar error di sini membuat browser otomatis coba lagi nanti.
    throw err;
  }
}

// TODO: implementasikan sesuai skema penyimpanan lokal kamu.
async function getPendingUpdatesFromIndexedDB() {
  return [];
}

// ---- Periodic Background Sync ----
// Menyegarkan daftar pedagang terdekat di background secara berkala,
// selama browser mengizinkan (butuh izin "periodic-background-sync").
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'refresh-pedagang-terdekat') {
    event.waitUntil(refreshPedagangTerdekat());
  }
});

async function refreshPedagangTerdekat() {
  try {
    const response = await fetch('/api/pedagang/terdekat');
    if (response.ok) {
      const cache = await caches.open(CACHE);
      await cache.put('/api/pedagang/terdekat', response.clone());
    }
  } catch (err) {
    console.warn('Periodic sync gagal, akan dicoba lagi nanti:', err);
  }
}
