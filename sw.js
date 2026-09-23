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


// ---- Notifikasi Push ----
// PENTING: tanpa blok ini, event 'push' dari server (send-broadcast-push, send-open-reminders,
// send-vendor-push, dst.) diterima oleh Service Worker tapi TIDAK PERNAH ditampilkan sebagai
// notifikasi — payload-nya cuma didiamkan. Ini penyebab utama "kirim pengumuman tidak muncul
// notifnya" walau server melaporkan sukses terkirim.
// Bonus: langganan push dibuat dengan userVisibleOnly:true, yang MEWAJIBKAN setiap event 'push'
// menampilkan notifikasi. Kalau tidak (seperti sebelumnya), Chrome menganggap situsnya melanggar
// aturan itu dan lama-lama BISA MENCABUT IZIN/LANGGANAN PUSH SENDIRI — jadi blok ini juga salah
// satu penyebab "notifikasi ke pedagang mati sendiri".
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {
    data = { title: 'JajanDekat', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'JajanDekat';
  const options = {
    body: data.body || '',
    icon: data.icon || 'icon-192.png',
    badge: data.badge || 'icon-192.png',
    image: data.image || undefined,
    tag: data.tag || undefined,       // notif dgn tag sama saling menggantikan (tidak menumpuk)
    renotify: !!data.tag,
    data: { url: data.url || '/' },   // dibaca saat notifikasi diketuk
    vibrate: [80, 40, 80],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Ketuk notifikasi -> fokuskan tab yang sudah terbuka (dan arahkan ke halaman terkait lewat URL),
// atau buka tab baru kalau app-nya belum terbuka sama sekali.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  const fullUrl = new URL(targetUrl, self.location.origin).href;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.postMessage({ type: 'PUSH_NOTIFICATION_CLICK', url: targetUrl });
          return c.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(fullUrl);
    })
  );
});
