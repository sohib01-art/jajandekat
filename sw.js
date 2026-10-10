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
const CACHE_VERSION = 'v43';
const STATIC_CACHE = `jajandekat-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `jajandekat-runtime-${CACHE_VERSION}`;

const offlineFallbackPage = 'offline.html';

// App shell: file lokal yang WAJIB ada supaya app bisa dibuka offline.
// Query string (?v=..) di index.html tidak perlu diikutkan di sini —
// kita precache path aslinya, lalu fetch handler yang mencocokkan
// (lihat matchIgnoringVersion & penanganan file berversi di bawah).
const APP_SHELL = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/config.js',
  '/js/app.js',
  '/js/header-scroll.js',
  '/js/header-admin.js',
  '/js/kesiapan-admin.js',
  '/css/header-scroll.css',
  '/icons/hero-beranda.jpg',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png',
  // Suara
  '/pesanan-masuk.mp3',
  '/pesan-chat.mp3',
  '/pedagang-buka.mp3',
  '/sukses.mp3',
  '/peringatan.mp3',
  '/klik.mp3',
  '/bel-mangkuk.mp3',
  offlineFallbackPage,
  '/offline-mascot.webp',
  '/icons/install-wave.webp',
  '/icons/install-girl.webp',
  '/icons/install-thumb.webp',
  '/icons/onboarding-wave.png',
  '/icons/onboarding-point.png',
  '/icons/onboarding-thumbsup.png',
  '/icons/ojek-mascot.png',
  // Halaman & portal koordinator ojek
  '/privacy.html',
  '/terms.html',
  '/koordinator.html',
  // Ikon browser/iOS yang dirujuk index.html
  '/favicon.ico',
  '/favicon-32x32.png',
  '/apple-touch-icon.png',
  // Gambar statis yang dirujuk langsung di app.js
  '/icons/maskot.png',
  '/icons/maskot-daftar.png',
  '/icons/maskot-jualan.png',
  '/icons/avatar-pembeli.png',
  '/icons/banner-pedagang.png',
  '/icons/icon_chat_wa.png',
  '/icons/icon_check.png',
  '/icons/icon_map.png',
  '/icons/bakso.png',
  '/icons/lainnya.png',
  '/icons/kat-berat.webp',
  '/icons/kat-fast.webp',
  '/icons/kat-jajanan.webp',
  '/icons/kat-manis.webp',
  '/icons/kat-minuman.webp',
  // Ikon "Kategori Lainnya" (non-kuliner). Aman kalau ada yang belum ada: install memakai allSettled.
  '/icons/kat-kebutuhan.webp',
  '/icons/kat-segar.webp',
  '/icons/kat-fashion.webp',
  '/icons/kat-servis.webp',
  '/icons/kat-kecantikan.webp',
  '/icons/kat-rumah.webp',
  '/icons/kat-otomotif.webp',
  '/icons/kat-digital.webp',
  '/icons/kat-pertanian.webp',
  '/icons/kat-kado.webp',
  '/icons/kat-jasa_rumah.webp',
  '/icons/kat-pendidikan.webp',
  '/icons/kat-kreatif.webp',
  '/icons/kat-kesehatan.webp',
  '/icons/kat-lain.webp',
];

// Library pihak ketiga (CDN) + font Google yang dipakai app — kita cache runtime
// supaya peta/QR/koneksi Supabase/font tetap bisa jalan saat offline
// (setelah pernah diakses sekali secara online).
const THIRD_PARTY_HOSTS = [
  'unpkg.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
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

// Simpan salinan respons ke cache. Salinan dibuat SEKARANG (sebelum respons asli dipakai halaman),
// dan hanya respons 200 penuh yang disimpan (206 / error tidak boleh masuk cache).
function simpanKeCache(cacheName, request, resp) {
  if (!resp || resp.status !== 200) return;
  const copy = resp.clone();
  caches.open(cacheName).then((c) => c.put(request, copy)).catch(() => {});
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // biarkan POST/PUT dll (mis. ke Supabase) apa adanya

  const url = new URL(request.url);

  // 1) Navigasi halaman (buka app / refresh) -> network-first.
  //    Hanya halaman utama ('/' atau /index.html) yang disimpan sebagai app shell.
  //    Halaman lain (privacy.html, terms.html, koordinator.html) tidak boleh menimpa
  //    cache /index.html, kalau tidak, saat offline yang muncul bukan app.
  if (request.mode === 'navigate') {
    const isShell = url.pathname === '/' || url.pathname === '/index.html';
    event.respondWith(
      (async () => {
        try {
          const networkResp = await fetch(request);
          if (networkResp && networkResp.ok) {
            const cache = await caches.open(STATIC_CACHE);
            cache.put(isShell ? '/index.html' : request, networkResp.clone());
          }
          return networkResp;
        } catch (err) {
          const cached = isShell
            ? await matchIgnoringVersion(new Request('/index.html'))
            : await matchIgnoringVersion(request);
          if (cached) return cached;
          const cache = await caches.open(STATIC_CACHE);
          return cache.match(offlineFallbackPage);
        }
      })()
    );
    return;
  }

  // 2) Aset app shell sendiri (sama origin: css/js/manifest/ikon)
  //    -> cache-first, lalu perbarui cache di background (stale-while-revalidate).
  //    File berversi (…js?v=3): dicocokkan PERSIS dulu. Begitu angka ?v= di index.html naik,
  //    pengguna langsung mendapat file baru (tidak lagi memakai salinan lama sekali buka).
  //    Kalau jaringan mati, baru dipakai salinan tanpa memedulikan versi.
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const berversi = url.searchParams.has('v');
        const cached = berversi ? await caches.match(request) : await matchIgnoringVersion(request);
        const fetchPromise = fetch(request)
          .then((networkResp) => {
            simpanKeCache(STATIC_CACHE, request, networkResp);
            return networkResp;
          })
          .catch(() => undefined);
        // Ada di cache -> pakai itu, perbarui di latar belakang (jaga SW tetap hidup sampai selesai).
        if (cached) { event.waitUntil(fetchPromise); return cached; }
        // Belum ada di cache -> tunggu jaringan.
        const networkResp = await fetchPromise;
        if (networkResp) return networkResp;
        // Offline: file berversi yang belum pernah disimpan persis -> pakai salinan versi lama.
        if (berversi) {
          const lama = await matchIgnoringVersion(request);
          if (lama) return lama;
        }
        return Response.error();
      })()
    );
    return;
  }

  // 3) Library CDN pihak ketiga (Leaflet, Supabase JS, QRCode.js) + font Google
  //    -> cache-first, supaya tetap termuat walau offline setelah pernah online sekali.
  if (THIRD_PARTY_HOSTS.includes(url.hostname)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        try {
          const networkResp = await fetch(request);
          if (networkResp && (networkResp.ok || networkResp.type === 'opaque')) {
            const copy = networkResp.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(request, copy)).catch(() => {});
          }
          return networkResp;
        } catch (err) {
          return cached; // undefined kalau memang belum pernah tersimpan
        }
      })()
    );
    return;
  }

  // 4) Selain itu (mis. request ke Supabase REST/API, foto header/pedagang dari Supabase Storage, dsb.)
  //    -> biarkan lewat network apa adanya; jangan dicache supaya data selalu fresh.
});

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
