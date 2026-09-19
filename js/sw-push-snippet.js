// ============================================
// Tempel di sw.js (ganti handler 'push' & 'notificationclick' yang lama)
// ============================================

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }

  const options = {
    body: data.body || '',
    icon: 'icons/lainnya.png',      // ikon kecil di kiri (path relatif terhadap sw.js)
    badge: 'icons/lainnya.png',     // idealnya PNG putih transparan 96x96 untuk ikon status bar
    image: data.image || undefined, // gambar besar (muncul saat notif di-expand)
    tag: data.tag || undefined,     // tag sama = notif lama diganti, bukan menumpuk
    renotify: !!data.tag,           // bunyi/getar lagi walau menggantikan notif lama
    vibrate: [100, 50, 100],
    data: { url: data.url || '?view=peta', vendor_id: data.vendor_id },
    actions: [{ action: 'peta', title: '📍 Lihat di Peta' }],
  };

  event.waitUntil(self.registration.showNotification(data.title || 'JajanDekat', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Relatif terhadap scope app, jadi aman walau app ada di subfolder
  const target = new URL(event.notification.data?.url || '?view=peta', self.registration.scope).href;

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
