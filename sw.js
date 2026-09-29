// ============================================================
// Service Worker JajanDekat
// Precache app shell + strategi caching per jenis request, supaya
// aplikasi tetap bisa dibuka & dipakai walau device offline —
// termasuk saat pertama kali dibuka tanpa koneksi (asalkan SW
// sudah pernah ter-install minimal sekali saat online).
// ============================================================

// Naikkan angka versi ini setiap kali kamu deploy perubahan besar
// pada app shell (index.html/style.css/app.js/config.js), supaya
// cache lama otomatis dibuang dan pengguna dapat versi baru.
const CACHE_VERSION = 'v3';
const STATIC_CACHE = `jajandekat-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `jajandekat-runtime-${CACHE_VERSION}`;

const offlineFallbackPage = 'offline.html';

// App shell: file lokal yang WAJIB ada supaya app bisa dibuka offline.
// Query string (?v=..) di index.html tidak perlu diikutkan di sini —
// kita precache path aslinya, lalu fetch handler yang mencocokkan
// tanpa memedulikan query string (lihat matchIgnoringVersion di bawah).
const APP_SHELL = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/config.js',
  '/js/app.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png',
  offlineFallbackPage,
  '/offline-mascot.png',
  '/icons/onboarding-wave.png',
  '/icons/onboarding-point.png',
  '/icons/onboarding-thumbsup.png',
  '/icons/ojek-mascot.png',
];

// Library pihak ketiga (CDN) yang dipakai app — kita cache runtime
// supaya peta/QR/koneksi Supabase tetap bisa jalan saat offline
// (setelah pernah diakses sekali secara online).
const THIRD_PARTY_HOSTS = [
  'unpkg.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
];

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ---- Install: precache app shell ----
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      // addAll akan gagal seluruhnya kalau salah satu URL gagal di-fetch;
      // pakai Promise.allSettled supaya 1 aset gagal (mis. ikon belum ada)
      // tidak menggagalkan precache aset lain yang penting.
      return Promise.allSettled(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] Gagal precache:', url, err);
          })
        )
      );
    })
  );
  self.skipWaiting();
});

// ---- Activate: bersihkan cache versi lama ----
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Cari di cache tanpa peduli query string (?v=80 dst)
async function matchIgnoringVersion(request) {
  return caches.match(request, { ignoreSearch: true });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // biarkan POST/PUT dll (mis. ke Supabase) apa adanya

  const url = new URL(request.url);

  // 1) Navigasi halaman (buka app / refresh) -> network-first,
  //    fallback ke index.html dari cache, fallback terakhir offline.html.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const networkResp = await fetch(request);
          const cache = await caches.open(STATIC_CACHE);
          cache.put('/index.html', networkResp.clone());
          return networkResp;
        } catch (err) {
          const cachedShell = await matchIgnoringVersion(new Request('/index.html'));
          if (cachedShell) return cachedShell;
          const cache = await caches.open(STATIC_CACHE);
          return cache.match(offlineFallbackPage);
        }
      })()
    );
    return;
  }

  // 2) Aset app shell sendiri (sama origin: css/js/manifest/ikon)
  //    -> cache-first, lalu perbarui cache di background (stale-while-revalidate).
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cached = await matchIgnoringVersion(request);
        const fetchPromise = fetch(request)
          .then((networkResp) => {
            if (networkResp && networkResp.ok) {
              caches.open(STATIC_CACHE).then((cache) => cache.put(request, networkResp.clone()));
            }
            return networkResp;
          })
          .catch(() => undefined);
        return cached || fetchPromise || caches.match(offlineFallbackPage);
      })()
    );
    return;
  }

  // 3) Library CDN pihak ketiga (Leaflet, Supabase JS, QRCode.js)
  //    -> cache-first, supaya tetap termuat walau offline setelah pernah online sekali.
  if (THIRD_PARTY_HOSTS.includes(url.hostname)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        try {
          const networkResp = await fetch(request);
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put(request, networkResp.clone());
          return networkResp;
        } catch (err) {
          return cached; // undefined kalau memang belum pernah tersimpan
        }
      })()
    );
    return;
  }

  // 4) Selain itu (mis. request ke Supabase REST/API, gambar upload, dsb.)
  //    -> biarkan lewat network apa adanya; jangan dicache supaya data selalu fresh.
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
      const cache = await caches.open(RUNTIME_CACHE);
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
  // ?src=push dipakai app untuk mencatat "notifikasi dibuka" saat app dibuka dari keadaan tertutup
  const fullUrlObj = new URL(targetUrl, self.location.origin);
  fullUrlObj.searchParams.set('src', 'push');
  const fullUrl = fullUrlObj.href;

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
