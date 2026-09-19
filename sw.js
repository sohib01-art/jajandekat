const CACHE_NAME = 'jajandekat-v3';
const CORE_FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/config.js',
  './js/app.js',
  './manifest.json',
  './offline.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Strategi: coba jaringan dulu (data pedagang harus selalu fresh).
// Kalau gagal (offline):
//  - untuk navigasi halaman (buka app/refresh) -> tampilkan offline.html yang rapi
//  - untuk file lain (css/js/gambar) -> pakai cache kalau ada
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match('./offline.html').then((r) => r || caches.match('./index.html'))
      )
    );
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// ---------- WEB PUSH ----------
self.addEventListener('push', (event) => {
  let data = { title: 'JajanDekat', body: 'Ada kabar baru!' };
  try { data = event.data.json(); } catch (e) {}

  const options = {
    body: data.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    image: data.image || undefined, // gambar besar (muncul saat notif di-expand)
    tag: data.tag || undefined,     // tag sama = notif lama diganti, bukan menumpuk
    renotify: !!data.tag,           // tetap getar/bunyi walau menggantikan notif lama
    vibrate: [100, 50, 100],
    data: { url: data.url || '?view=peta', vendor_id: data.vendor_id },
    // Tombol "Lihat di Peta" hanya untuk notifikasi pedagang; pengumuman & artikel tidak punya vendor_id
    actions: data.vendor_id ? [{ action: 'peta', title: '📍 Lihat di Peta' }] : [],
  };

  event.waitUntil(self.registration.showNotification(data.title || 'JajanDekat', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Tujuan relatif terhadap scope app: ?vendor=ID, ?artikel=slug, ?ann=ID, ?view=peta
  const target = new URL(
    (event.notification.data && event.notification.data.url) || '?view=peta',
    self.registration.scope
  ).href;

  event.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) {
        try { await w.navigate(target); } catch (e) {}
        return w.focus();
      }
    }
    return clients.openWindow(target);
  })());
});
