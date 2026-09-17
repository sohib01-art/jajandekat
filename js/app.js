// ============================================
// JajanDekat — app.js
// Biaya nol: Leaflet+OpenStreetMap (peta) + Supabase free tier (data & realtime)
// ============================================

// Identitas pembeli/pedagang sederhana tanpa login (device id disimpan di localStorage).
// Dihitung SEBELUM membuat client Supabase supaya bisa dikirim sebagai header di setiap
// request — header ini dipakai oleh RLS di server untuk membatasi akses chat cuma ke
// pemiliknya (lihat migration step2_scope_chat_rls_to_device_owner).
function getDeviceId() {
  let id = localStorage.getItem('jd_device_id');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('jd_device_id', id);
  }
  return id;
}
const deviceId = getDeviceId();

const isConfigured = !SUPABASE_URL.includes("ISI-PROJECT-ID");
let sb = null;
let initError = null;
try {
  if (isConfigured) {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { 'x-device-id': deviceId } },
    });
  }
} catch (e) {
  initError = e;
  console.error('Gagal membuat koneksi Supabase:', e);
}
let referralCodeFromLink = null;

// ---------- WEB PUSH: minta izin & simpan langganan ----------
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

let pushAsked = false;
async function ensurePushSubscription() {
  if (pushAsked) return;
  pushAsked = true;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    const json = sub.toJSON();
    await sb.from('push_subscriptions').upsert({
      device_id: deviceId,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    }, { onConflict: 'endpoint' });
  } catch (e) {
    console.error('Gagal langganan push:', e);
  }
}

let vendors = [];
let followedIds = new Set();
let mode = 'pembeli';
let activeCat = 'semua';
let map = null;
let markers = {};

const main = document.getElementById('main');
const btnPembeli = document.getElementById('btn-pembeli');
const btnPedagang = document.getElementById('btn-pedagang');

// Pasang tombol menu PALING AWAL, sebelum kode lain yang mungkin gagal —
// supaya menu tetap bisa diklik walau ada masalah koneksi/data.
btnPembeli.onclick = () => {
  mode = 'pembeli';
  btnPembeli.classList.add('active'); btnPedagang.classList.remove('active');
  renderPembeli();
};
btnPedagang.onclick = () => {
  mode = 'pedagang';
  btnPedagang.classList.add('active'); btnPembeli.classList.remove('active');
  renderPedagang();
};

// Pasang tombol nav bawah (Status / Peta / Cari) — hanya berlaku di mode Pembeli
let bottomView = 'status';
document.querySelectorAll('nav.bottom .nav-item').forEach(el => {
  el.onclick = () => {
    bottomView = el.dataset.view;
    document.querySelectorAll('nav.bottom .nav-item').forEach(n => n.classList.remove('active'));
    el.classList.add('active');
    // Nav bawah selalu membawa ke mode Pembeli
    if (mode !== 'pembeli') {
      mode = 'pembeli';
      btnPembeli.classList.add('active'); btnPedagang.classList.remove('active');
    }
    renderPembeli();
  };
});

function showToast(text) {
  const t = document.getElementById('toast');
  document.getElementById('toast-text').textContent = text;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3200);
}

// ---------- SETUP SCREEN (kalau config.js belum diisi) ----------
function renderSetupNeeded() {
  main.innerHTML = `
    <div class="vendor-hero" style="margin-top:24px;">
      <div class="vendor-hero-emoji">🛠️</div>
      <div class="vendor-hero-name">Belum terhubung ke Supabase</div>
      <div class="vendor-hero-status" style="margin-top:10px; line-height:1.6;">
        Buka file <b class="mono">js/config.js</b>, isi <b>SUPABASE_URL</b> dan
        <b>SUPABASE_ANON_KEY</b> sesuai project Supabase Anda, lalu simpan &amp;
        refresh halaman ini. Lihat README.md untuk langkah lengkapnya.
      </div>
    </div>
  `;
}

// ---------- DATA LAYER ----------
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Waktu habis: ${label} tidak merespons dalam ${ms/1000} detik.`)), ms))
  ]);
}

async function fetchVendors() {
  const { data, error } = await withTimeout(sb.from('vendors').select('id,name,category,categories,emoji,mode_icon,whatsapp,show_whatsapp,active,active_until,lat,lng,photo_url,is_premium,premium_until,promo_until,promo_text,reminder_time,created_at').order('name'), 10000, 'Ambil data pedagang');
  if (error) { console.error(error); throw error; }
  return data;
}

async function fetchFollows() {
  const { data, error } = await withTimeout(sb.from('follows').select('vendor_id').eq('device_id', deviceId), 10000, 'Ambil data pengikut');
  if (error) { console.error(error); throw error; }
  return data.map(f => f.vendor_id);
}

async function toggleFollowDb(vendorId, isFollowing, viaReferral = false) {
  if (isFollowing) {
    await sb.from('follows').delete().eq('device_id', deviceId).eq('vendor_id', vendorId);
  } else {
    await sb.from('follows').insert({ device_id: deviceId, vendor_id: vendorId, via_referral: viaReferral });
  }
}

async function setVendorStatus(vendorId, active, untilMinutes, lat, lng, photoUrl) {
  const { error } = await sb.rpc('set_vendor_status', {
    p_vendor_id: vendorId,
    p_pin: myVendorPin || '',
    p_active: active,
    p_duration_minutes: untilMinutes || null,
    p_lat: lat,
    p_lng: lng,
    p_photo_url: photoUrl,
  });
  if (error) { console.error(error); throw error; }
}

// ---------- FOTO DAGANGAN (sementara, ikut terhapus saat selesai jualan) ----------
function compressImage(file, targetSize = 800, quality = 0.75, squareCrop = true) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => { img.src = e.target.result; };
    reader.onerror = reject;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      if (squareCrop) {
        // Crop tengah jadi persegi (1:1) dulu, baru resize — supaya semua foto pedagang
        // tampil rapi & seragam di kartu, peta, dan ikon bundar, apa pun orientasi aslinya.
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const outSize = Math.min(targetSize, side);
        canvas.width = outSize;
        canvas.height = outSize;
        canvas.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, outSize, outSize);
      } else {
        // Cuma resize, pertahankan rasio asli (dipakai untuk gambar pengumuman/poster).
        const scale = Math.min(1, targetSize / img.width);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      }
      canvas.toBlob(blob => resolve(blob), 'image/jpeg', quality);
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadVendorPhoto(vendorId, file) {
  const blob = await compressImage(file);
  const path = `${vendorId}/${Date.now()}.jpg`;
  const { error } = await sb.storage.from('vendor-photos').upload(path, blob, {
    contentType: 'image/jpeg', upsert: true
  });
  if (error) throw error;
  const { data } = sb.storage.from('vendor-photos').getPublicUrl(path);
  return data.publicUrl;
}

async function uploadAnnouncementImage(file) {
  // Reuse bucket 'vendor-photos' dengan folder terpisah — hindari bikin bucket baru di Supabase.
  const blob = await compressImage(file, 1000, 0.75, false);
  const path = `announcements/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const { error } = await sb.storage.from('vendor-photos').upload(path, blob, {
    contentType: 'image/jpeg', upsert: true
  });
  if (error) throw error;
  const { data } = sb.storage.from('vendor-photos').getPublicUrl(path);
  return data.publicUrl;
}

async function uploadArticleCoverImage(file) {
  // Reuse bucket 'vendor-photos' dengan folder terpisah — hindari bikin bucket baru di Supabase.
  const blob = await compressImage(file, 1000, 0.75, false);
  const path = `artikel-admin/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const { error } = await sb.storage.from('vendor-photos').upload(path, blob, {
    contentType: 'image/jpeg', upsert: true
  });
  if (error) throw error;
  const { data } = sb.storage.from('vendor-photos').getPublicUrl(path);
  return data.publicUrl;
}

function slugifyArticle(title) {
  return String(title || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

async function deleteVendorPhotoByUrl(photoUrl) {
  if (!photoUrl) return;
  try {
    const path = photoUrl.split('/vendor-photos/')[1];
    if (path) await sb.storage.from('vendor-photos').remove([path]);
  } catch (e) { console.error('Gagal hapus foto lama:', e); }
}
// ---------- EXPIRY (lapisan pengaman di sisi aplikasi, cron server jalan tiap 5 menit) ----------
function normalizeExpiry(v) {
  if (v.active && v.active_until && new Date(v.active_until) < new Date()) {
    v.active = false; v.active_until = null; v.photo_url = null;
  }
  return v;
}

function checkAllExpiry() {
  let changed = false;
  vendors.forEach(v => {
    const wasActive = v.active;
    normalizeExpiry(v);
    if (wasActive && !v.active) changed = true;
  });
  if (changed && mode === 'pembeli') renderPembeli();
}
setInterval(checkAllExpiry, 30000); // cek tiap 30 detik selagi app terbuka

// ---------- REALTIME ----------
function subscribeRealtime() {
  sb.channel('public:vendors')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'vendors' }, (payload) => {
      const updated = normalizeExpiry(payload.new);
      delete updated.pin; // lapisan pertahanan tambahan — jangan sampai PIN ikut tersebar lewat realtime
      const idx = vendors.findIndex(v => v.id === updated.id);
      if (idx > -1) {
        const wasActive = vendors[idx].active;
        vendors[idx] = updated;
        if (!wasActive && updated.active && followedIds.has(updated.id)) {
          showToast(`${updated.name} baru saja mulai jualan!`);
        }
      }
      if (mode === 'pembeli') renderPembeli();
    })
    .subscribe();
}

// ---------- BUYER VIEW ----------
let artikelDetailSlug = null;

function renderPembeli() {
  if (bottomView === 'peta') return renderPetaView();
  if (bottomView === 'cari') return renderCariView();
  if (bottomView === 'artikel') return artikelDetailSlug ? renderArtikelDetailView(artikelDetailSlug) : renderArtikelListView();

  const followed = vendors.filter(v => followedIds.has(v.id));

  const storyHtml = followed.map(v => `
    <button class="story ${v.active ? 'on' : ''}" onclick="window.__toggleFollow('${v.id}')">
      <div class="story-ring" style="${vendorIconStyle(v)}">${vendorIconInner(v)}</div>
      <div class="story-name">${v.name.split(' ')[0]}</div>
    </button>
  `).join('');

  const catList = ['semua', ...Array.from(new Set(vendors.flatMap(v => v.categories || []))).sort()];
  const catRowHtml = catList.map(c => `
    <button class="cat-chip ${activeCat === c ? 'active' : ''}" onclick="window.__setCat('${c.replace(/'/g, "\\'")}')">
      <div class="cat-circle">${c === 'semua' ? '🍽️' : `<img src="${categoryIconFile(c) || ''}" alt="${c}" />`}</div>
      <div class="cat-label">${c === 'semua' ? 'Semua' : c}</div>
    </button>
  `).join('');
  const filteredVendors = activeCat === 'semua' ? vendors : vendors.filter(v => (v.categories || []).includes(activeCat));

  main.innerHTML = `
    ${renderAnnouncementBanner(getRelevantAnnouncementsForBuyer())}
    <div class="cat-row">${catRowHtml}</div>
    <div class="section-label">Pedagang yang kamu ikuti</div>
    <div class="stories">${storyHtml || '<div style="color:var(--text-faint);font-size:12px;padding:8px 0;">Belum ada yang diikuti.</div>'}</div>
    <div class="section-label">Semua pedagang</div>
    <div class="vendor-list">${renderVendorListHtml(filteredVendors)}</div>
  `;
}

function isPromoActive(v) {
  return v.promo_until && new Date(v.promo_until) > new Date();
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- ARTIKEL (PUBLIK) ----------
async function renderArtikelListView() {
  main.innerHTML = `<div class="section-label">📰 Artikel</div><div class="vendor-list" id="artikel-list"><div style="color:var(--text-faint);font-size:12.5px;">Memuat artikel...</div></div>`;
  const el = document.getElementById('artikel-list');
  try {
    const { data, error } = await sb.from('artikel_admin').select('id,title,slug,excerpt,cover_image_url,created_at').eq('published', true).order('created_at', { ascending: false });
    if (error) throw error;
    if (!data || data.length === 0) { el.innerHTML = '<div style="color:var(--text-faint);font-size:12.5px;padding:12px 0;">Belum ada artikel.</div>'; return; }
    el.innerHTML = data.map(a => `
      <div class="vendor-card" style="flex-direction:column;align-items:stretch;gap:8px;cursor:pointer;" onclick="window.__openArtikel('${a.slug}')">
        ${a.cover_image_url ? `<img src="${a.cover_image_url}" style="width:100%;border-radius:10px;" />` : ''}
        <div style="font-family:'Poppins';font-weight:700;font-size:13.5px;">${escapeHtml(a.title)}</div>
        ${a.excerpt ? `<div style="font-size:12px;color:var(--text-dim);">${escapeHtml(a.excerpt)}</div>` : ''}
        <div style="font-size:10px;color:var(--text-faint);">${new Date(a.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
      </div>
    `).join('');
  } catch (e) {
    el.innerHTML = `<div style="color:#f87171;font-size:12.5px;">Gagal memuat artikel: ${e.message}</div>`;
  }
}

window.__openArtikel = function (slug) {
  artikelDetailSlug = slug;
  renderPembeli();
  window.scrollTo(0, 0);
};

async function renderArtikelDetailView(slug) {
  main.innerHTML = `<div style="color:var(--text-faint);font-size:12.5px;">Memuat artikel...</div>`;
  try {
    const { data, error } = await sb.from('artikel_admin').select('*').eq('slug', slug).eq('published', true).single();
    if (error || !data) throw error || new Error('Artikel tidak ditemukan.');
    main.innerHTML = `
      <button class="follow-btn" style="margin-bottom:12px;" onclick="window.__backFromArtikel()">← Kembali ke Artikel</button>
      ${data.cover_image_url ? `<img src="${data.cover_image_url}" style="width:100%;border-radius:12px;margin-bottom:12px;" />` : ''}
      <div style="font-family:'Poppins';font-weight:800;font-size:18px;margin-bottom:6px;">${escapeHtml(data.title)}</div>
      <div style="font-size:10.5px;color:var(--text-faint);margin-bottom:14px;">${new Date(data.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
      <div style="font-size:13.5px;line-height:1.7;white-space:pre-wrap;">${escapeHtml(data.content)}</div>
    `;
  } catch (e) {
    main.innerHTML = `
      <button class="follow-btn" style="margin-bottom:12px;" onclick="window.__backFromArtikel()">← Kembali ke Artikel</button>
      <div style="color:#f87171;font-size:12.5px;">Artikel tidak ditemukan.</div>
    `;
  }
}

window.__backFromArtikel = function () {
  artikelDetailSlug = null;
  renderPembeli();
};

// ---------- PENGUMUMAN ADMIN ----------
async function fetchAnnouncements() {
  const { data, error } = await sb.from('announcements').select('*').eq('active', true).order('created_at', { ascending: false });
  if (error) { console.error('Gagal ambil pengumuman:', error); return []; }
  return data || [];
}

function getRelevantAnnouncementsForVendor(v) {
  const audienceType = v.is_premium ? 'premium' : 'biasa';
  return announcements.filter(a => {
    if (a.audience !== 'semua' && a.audience !== audienceType) return false;
    if (a.zone_level && a.zone_level !== 'nasional' && a.zone_value) {
      return (v.region || '').toLowerCase().includes(a.zone_value.toLowerCase());
    }
    return true;
  });
}

function getRelevantAnnouncementsForBuyer() {
  // Catatan: lokasi pembeli tidak disimpan di aplikasi ini, jadi filter zona
  // untuk audiens "Pembeli" belum bisa diterapkan — semua pembeli akan melihatnya.
  return announcements.filter(a => a.audience === 'semua' || a.audience === 'pembeli');
}

function renderAnnouncementBanner(list) {
  const dismissed = JSON.parse(localStorage.getItem('jd_dismissed_ann') || '[]');
  const visible = list.filter(a => !dismissed.includes(a.id));
  if (!visible.length) return '';
  return visible.map(a => `
    <div class="vendor-hero" style="text-align:left;border-color:#3DDC97;position:relative;margin-bottom:10px;">
      <button onclick="window.__dismissAnnouncement('${a.id}')" style="position:absolute;top:6px;right:6px;background:none;border:none;color:var(--text-faint);font-size:15px;cursor:pointer;padding:4px 8px;">✕</button>
      <div style="display:flex;gap:8px;align-items:flex-start;">
        <span style="font-size:18px;">📢</span>
        <div style="flex:1;padding-right:18px;">
          ${a.image_url ? `<img src="${a.image_url}" style="width:100%;max-height:min(280px,42vh);object-fit:cover;border-radius:10px;margin-bottom:8px;display:block;" />` : ''}
          <div style="font-size:12.5px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(a.message)}</div>
          ${a.link && /^https?:\/\//.test(a.link) ? `<a href="${escapeHtml(a.link)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:6px;font-size:11.5px;color:var(--brand);font-weight:700;">Selengkapnya →</a>` : ''}
        </div>
      </div>
    </div>
  `).join('');
}

window.__dismissAnnouncement = function (id) {
  const dismissed = JSON.parse(localStorage.getItem('jd_dismissed_ann') || '[]');
  dismissed.push(id);
  localStorage.setItem('jd_dismissed_ann', JSON.stringify(dismissed));
  if (mode === 'pedagang') renderPedagang(); else renderPembeli();
};

// ---------- CHAT DALAM APP (pedagang <-> pembeli, gratis lewat Supabase Realtime) ----------
const QUICK_REPLIES_BUYER = ['Masih jualan? 🙋', 'Ready berapa banyak?', 'Ongkir ke sini berapa?', 'Boleh COD?', 'Lokasi tepatnya di mana?'];
const QUICK_REPLIES_VENDOR = ['Iya masih, silakan 🙏', 'Otw ke lokasi', 'Sebentar ya, masih disiapin', 'Stok habis, besok lagi ya', 'Boleh, langsung datang aja'];

let currentChatThreadId = null;
let currentChatChannel = null;
let currentChatIsVendor = false;
let chatPollTimer = null;
let chatSeenMessageIds = new Set();

// Bunyi notifikasi chat — dibuat langsung dari kode (bukan file audio), jadi tetap
// single-file dan tidak perlu hosting aset tambahan.
let chatAudioCtx = null;
function playChatDing() {
  try {
    chatAudioCtx = chatAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = chatAudioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1175, ctx.currentTime + 0.09);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.35);
  } catch (e) { /* browser tidak dukung Web Audio, diamkan */ }
}

async function getOrCreateChatThread(vendorId, buyerDeviceId) {
  const { data: existing } = await sb.from('chat_threads').select('id').eq('vendor_id', vendorId).eq('buyer_device_id', buyerDeviceId).maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await sb.from('chat_threads').insert({ vendor_id: vendorId, buyer_device_id: buyerDeviceId }).select('id').single();
  if (error) throw error;
  return data.id;
}

window.__openChatModal = async function (vendorId, vendorName) {
  try {
    const threadId = await getOrCreateChatThread(vendorId, deviceId);
    openChatUI(threadId, { asVendor: false, title: vendorName, quickReplies: QUICK_REPLIES_BUYER });
  } catch (e) {
    alert('Gagal membuka chat: ' + e.message);
  }
};

window.__openVendorChatThread = function (threadId, buyerLabel) {
  openChatUI(threadId, { asVendor: true, title: buyerLabel, quickReplies: QUICK_REPLIES_VENDOR });
};

window.__closeChatModal = function () {
  if (currentChatChannel) { sb.removeChannel(currentChatChannel); currentChatChannel = null; }
  if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
  currentChatThreadId = null;
  chatSeenMessageIds = new Set();
  document.getElementById('chat-modal-overlay')?.remove();
};

async function openChatUI(threadId, opts) {
  document.getElementById('chat-modal-overlay')?.remove();
  if (currentChatChannel) { sb.removeChannel(currentChatChannel); currentChatChannel = null; }
  if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
  currentChatThreadId = threadId;
  currentChatIsVendor = opts.asVendor;
  chatSeenMessageIds = new Set();

  const overlay = document.createElement('div');
  overlay.id = 'chat-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:220;display:flex;align-items:flex-end;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:var(--surface);width:100%;max-width:480px;height:78vh;border-radius:20px 20px 0 0;display:flex;flex-direction:column;overflow:hidden;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--stroke);flex-shrink:0;">
        <div style="font-family:'Poppins';font-weight:700;font-size:14px;">💬 ${escapeHtml(opts.title || 'Chat')}</div>
        <button onclick="window.__closeChatModal()" style="background:none;border:none;color:var(--text-faint);font-size:18px;cursor:pointer;padding:4px 8px;">✕</button>
      </div>
      <div id="chat-msg-list" style="flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px;"></div>
      <div id="chat-quick-replies" style="display:flex;gap:6px;padding:8px 10px 0;overflow-x:auto;flex-shrink:0;"></div>
      <div style="display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--stroke);flex-shrink:0;">
        <input id="chat-input" type="text" placeholder="Tulis pesan..." style="flex:1;min-width:0;background:var(--bg);border:1px solid var(--stroke);border-radius:20px;padding:10px 14px;color:var(--text);font-family:inherit;font-size:13px;" />
        <button onclick="window.__sendChatMessage()" style="background:var(--brand);color:#fff;border:none;border-radius:20px;padding:0 16px;font-weight:700;flex-shrink:0;">Kirim</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') window.__sendChatMessage();
  });

  document.getElementById('chat-quick-replies').innerHTML = (opts.quickReplies || []).map(t => `
    <button onclick="window.__useQuickReply('${t.replace(/'/g, "\\'")}')" style="flex-shrink:0;background:var(--bg);border:1px solid var(--stroke);border-radius:14px;padding:6px 10px;font-size:11px;color:var(--text-dim);white-space:nowrap;">${t}</button>
  `).join('');

  await loadAndRenderChatMessages(threadId, opts.asVendor);
  markThreadRead(threadId, opts.asVendor);

  currentChatChannel = sb.channel('chat_thread_' + threadId)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `thread_id=eq.${threadId}` }, (payload) => {
      if (currentChatThreadId !== threadId) return;
      handleIncomingChatMessage(payload.new, threadId, opts.asVendor);
    })
    .subscribe();

  // Cadangan kalau Realtime tidak sampai (mis. RLS memblokir jalur postgres_changes untuk
  // anon tanpa sesi auth asli): cek pesan baru tiap 3 detik selagi modal chat terbuka.
  chatPollTimer = setInterval(async () => {
    if (currentChatThreadId !== threadId) return;
    try {
      const { data, error } = await sb.from('chat_messages').select('*').eq('thread_id', threadId).order('created_at', { ascending: true });
      if (error || !data) return;
      data.forEach(m => handleIncomingChatMessage(m, threadId, opts.asVendor));
    } catch (e) { /* koneksi sempat gagal, coba lagi di siklus berikutnya */ }
  }, 3000);
}

function handleIncomingChatMessage(m, threadId, asVendor) {
  if (chatSeenMessageIds.has(m.id)) return; // sudah pernah dirender (dari realtime atau polling), jangan dobel
  appendChatMessage(m, asVendor);
  const fromOther = (asVendor && m.sender === 'buyer') || (!asVendor && m.sender === 'vendor');
  if (fromOther) {
    markThreadRead(threadId, asVendor);
    playChatDing();
  }
}

async function loadAndRenderChatMessages(threadId, asVendor) {
  const { data, error } = await sb.from('chat_messages').select('*').eq('thread_id', threadId).order('created_at', { ascending: true });
  const list = document.getElementById('chat-msg-list');
  if (!list) return;
  if (error) { list.innerHTML = `<div style="color:#f87171;font-size:11.5px;text-align:center;">Gagal memuat pesan.</div>`; return; }
  if (!data || !data.length) { list.innerHTML = `<div style="text-align:center;color:var(--text-faint);font-size:11.5px;">Belum ada pesan. Mulai percakapan di bawah 👇</div>`; return; }
  list.innerHTML = '';
  data.forEach(m => appendChatMessage(m, asVendor));
}

function appendChatMessage(m, asVendor) {
  chatSeenMessageIds.add(m.id);
  const list = document.getElementById('chat-msg-list');
  if (!list) return;
  if (list.children.length === 1 && (list.children[0].textContent || '').includes('Belum ada pesan')) list.innerHTML = '';
  const isMine = asVendor ? m.sender === 'vendor' : m.sender === 'buyer';
  const bubble = document.createElement('div');
  bubble.style.cssText = `align-self:${isMine ? 'flex-end' : 'flex-start'};max-width:78%;background:${isMine ? 'var(--brand)' : 'var(--bg)'};color:${isMine ? '#fff' : 'var(--text)'};border:1px solid ${isMine ? 'transparent' : 'var(--stroke)'};border-radius:14px;padding:8px 12px;font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;`;
  bubble.textContent = m.message;
  list.appendChild(bubble);
  list.scrollTop = list.scrollHeight;
}

window.__useQuickReply = function (text) {
  const input = document.getElementById('chat-input');
  if (input) { input.value = text; input.focus(); }
};

window.__sendChatMessage = async function () {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text || !currentChatThreadId) return;
  input.value = '';
  const sender = currentChatIsVendor ? 'vendor' : 'buyer';
  const threadId = currentChatThreadId;
  try {
    // Ambil kembali baris yang baru diinsert (pakai .select().single()) supaya bisa langsung
    // dirender di layar sendiri saat itu juga — tidak usah nunggu giliran poll/realtime, yang
    // ternyata tidak selalu memantulkan balik pesan milik si pengirim sendiri dengan mulus.
    const { data, error } = await sb.from('chat_messages')
      .insert({ thread_id: threadId, sender, message: text })
      .select('*')
      .single();
    if (error) throw error;
    if (currentChatThreadId === threadId && data) appendChatMessage(data, currentChatIsVendor);
    await sb.from('chat_threads').update({ last_message_at: new Date().toISOString(), last_message_preview: text.slice(0, 80) }).eq('id', threadId);
  } catch (e) {
    input.value = text; // kembalikan teksnya, jangan sampai hilang kalau gagal terkirim
    alert('Gagal mengirim pesan: ' + e.message);
  }
};

async function markThreadRead(threadId, asVendor) {
  const otherSender = asVendor ? 'buyer' : 'vendor';
  try {
    await sb.from('chat_messages').update({ read_at: new Date().toISOString() }).eq('thread_id', threadId).eq('sender', otherSender).is('read_at', null);
  } catch (e) { /* tidak kritis, diamkan */ }
}

function renderVendorListHtml(list) {
  if (!list.length) return '<div style="color:var(--text-faint);font-size:13px;">Tidak ada pedagang.</div>';
  const sorted = [...list].sort((a, b) => {
    const scoreA = (a.is_premium ? 2 : 0) + (isPromoActive(a) ? 1 : 0);
    const scoreB = (b.is_premium ? 2 : 0) + (isPromoActive(b) ? 1 : 0);
    return scoreB - scoreA;
  });
  return sorted.map(v => {
    const following = followedIds.has(v.id);
    const untilStr = v.active_until
      ? new Date(v.active_until).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
      : null;
    return `
      <div class="vendor-card" onclick="if(!event.target.closest('button')) window.__openReviewModal('${v.id}','${v.name.replace(/'/g, "\\'")}')" style="cursor:pointer;${isPromoActive(v) ? 'border-color:#F5A623;box-shadow:0 0 0 1px #F5A623;' : ''}">
        <div class="vendor-emoji" style="${vendorIconStyle(v)}">${vendorIconInner(v)}</div>
        <div class="vendor-info">
          <div class="vendor-name">${v.name}${v.is_premium ? ' <span class="premium-badge">⭐ Premium</span>' : ''}${isPromoActive(v) ? ' <span class="premium-badge" style="background:linear-gradient(135deg,#FFD86B,#F5A623);">🔥 Promo</span>' : ''}</div>
          <div class="vendor-meta">
            <span class="status-dot ${v.active ? 'aktif' : 'nonaktif'}"></span>
            <span class="status-text ${v.active ? 'aktif' : 'nonaktif'} mono">
              ${v.active ? 'SEDANG JUALAN · sampai ' + untilStr : 'Belum jualan'}
            </span>
          </div>
          <div class="vendor-sub">${(v.categories || []).join(' · ')}${v.active && !v.lat ? ' · 📍 lokasi tidak tersedia' : ''}</div>
          ${isPromoActive(v) && v.promo_text ? `<div class="vendor-sub" style="color:#F5A623;font-weight:700;">🔥 ${escapeHtml(v.promo_text)}</div>` : ''}
          <div class="vendor-sub" style="color:var(--text-faint);font-size:10.5px;">Tap kartu untuk beri masukan ke pedagang 💬</div>
          <div style="display:flex;gap:6px;margin-top:8px;" onclick="event.stopPropagation();">
            <button class="follow-btn" style="flex:1;background:var(--brand);color:#fff;text-align:center;" onclick="window.__openChatModal('${v.id}','${v.name.replace(/'/g, "\\'")}')">💬 Chat</button>
            ${v.show_whatsapp !== false && v.whatsapp ? `
              <a href="https://wa.me/${v.whatsapp}?text=${encodeURIComponent(`Halo ${v.name}, saya lihat lapak Anda di JajanDekat. Saya mau tanya-tanya, apakah masih jualan?`)}" target="_blank"
                 class="follow-btn" style="flex:1;background:#25D366;color:#fff;text-align:center;text-decoration:none;display:flex;align-items:center;justify-content:center;">📱 WA</a>
            ` : ''}
          </div>
        </div>
        <button class="follow-btn ${following ? 'following' : ''}" onclick="event.stopPropagation();window.__toggleFollow('${v.id}')">
          ${following ? '✓ Ikuti' : '+ Ikuti'}
        </button>
      </div>
    `;
  }).join('');
}

// ---------- PETA VIEW (tab "Peta") ----------
function renderPetaView() {
  const activeVendors = vendors.filter(v => v.active && v.lat && v.lng);
  main.innerHTML = `
    <div class="section-label">Peta pedagang yang sedang jualan</div>
    <div id="map" style="height:calc(100vh - 300px); min-height:300px;"></div>
    <div class="section-label">${activeVendors.length} pedagang aktif di peta</div>
    <div class="vendor-list">${renderVendorListHtml(activeVendors)}</div>
  `;
  renderMap();
}

// ---------- CARI VIEW (tab "Cari") ----------
function renderCariView() {
  main.innerHTML = `
    <div class="section-label">Cari pedagang</div>
    <input id="search-input" type="text" placeholder="Ketik nama atau kategori, misal: bakso"
      style="width:100%;background:var(--surface);border:1px solid var(--stroke);border-radius:12px;
      padding:12px 14px;color:var(--text);font-family:inherit;font-size:14px;margin-bottom:6px;" />
    <div id="search-results" class="vendor-list" style="margin-top:14px;"></div>

    <div class="vendor-hero" style="margin-top:20px;text-align:left;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <span style="font-size:20px;">📢</span>
        <div>
          <div style="font-family:'Poppins';font-weight:700;font-size:13.5px;">Ajak Teman Pakai JajanDekat</div>
          <div style="font-size:11px;color:var(--text-faint);margin-top:1px;">Makin banyak yang pakai, makin banyak pedagang mau daftar</div>
        </div>
      </div>
      <button class="follow-btn" style="display:block;text-align:center;width:100%;padding:10px;background:var(--brand);color:#fff;" onclick="window.__shareApp()">
        📤 Bagikan Aplikasi
      </button>
      <button class="follow-btn" style="display:block;text-align:center;width:100%;padding:10px;margin-top:8px;background:var(--brand-dim);color:var(--brand);" onclick="window.__shareAppImage()">
        🖼️ Bagikan dengan Gambar
      </button>
    </div>
  `;
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');

  function runSearch() {
    const q = input.value.trim().toLowerCase();
    const filtered = !q ? vendors : vendors.filter(v =>
      v.name.toLowerCase().includes(q) || (v.categories || []).some(c => c.toLowerCase().includes(q))
    );
    results.innerHTML = renderVendorListHtml(filtered);
  }
  input.oninput = runSearch;
  input.focus();
  runSearch();
}

window.__shareApp = function () {
  const link = `${location.origin}${location.pathname}`;
  const text = `Cari pedagang keliling (bakso, sate, gorengan, dll) yang sedang jualan di sekitarmu — cek dulu, baru jalan! Coba JajanDekat: ${link}`;
  if (navigator.share) {
    navigator.share({ title: 'JajanDekat', text, url: link }).catch(() => {});
  } else {
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  }
};


function renderMap() {
  const el = document.getElementById('map');
  if (!el) return;
  if (!map) {
    map = L.map('map').setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);
  } else {
    map.invalidateSize();
  }
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};
  vendors.filter(v => v.active && v.lat && v.lng).forEach(v => {
    const iconHtml = v.photo_url
      ? `<div style="width:34px;height:34px;border-radius:50%;background-image:url('${v.photo_url}');background-size:cover;background-position:center;border:2px solid #3DDC97;box-shadow:0 0 8px #3DDC97;"></div>`
      : v.mode_icon
      ? `<div style="width:34px;height:34px;border-radius:50%;background-image:url('mode_icons/${v.mode_icon}.png');background-size:cover;background-position:center;border:2px solid #3DDC97;box-shadow:0 0 8px #3DDC97;"></div>`
      : `<div style="font-size:22px;filter:drop-shadow(0 0 6px #3DDC97)">${v.emoji || '🍜'}</div>`;
    const icon = L.divIcon({
      html: iconHtml,
      className: '', iconSize: [34, 34]
    });
    const popupHtml = `
      <div style="font-family:'Poppins',sans-serif;font-weight:600;font-size:13px;">
        ${v.name}${v.is_premium ? ' ⭐' : ''}
      </div>
      <button onclick="window.__openChatModal('${v.id}','${v.name.replace(/'/g, "\\'")}')"
         style="display:inline-block;margin-top:6px;background:var(--brand);color:#fff;border:none;text-decoration:none;
         font-size:11.5px;font-weight:700;padding:6px 10px;border-radius:8px;cursor:pointer;">
        💬 Chat di App
      </button>
      ${v.is_premium && v.whatsapp && v.show_whatsapp !== false ? `
        <a href="https://wa.me/${v.whatsapp}?text=${encodeURIComponent(`Halo ${v.name}, saya lihat lapak Anda di JajanDekat. Saya mau tanya-tanya, apakah masih jualan?`)}" target="_blank"
           style="display:inline-block;margin-top:6px;margin-left:4px;background:#25D366;color:#fff;text-decoration:none;
           font-size:11.5px;font-weight:700;padding:6px 10px;border-radius:8px;">
          📱 WhatsApp
        </a>
      ` : ''}
      <div style="font-size:9px;color:#999;margin-top:5px;">Transaksi langsung dengan pedagang, di luar tanggung jawab JajanDekat.</div>
    `;
    markers[v.id] = L.marker([v.lat, v.lng], { icon }).addTo(map).bindPopup(popupHtml);
  });
}

// ---------- VENDOR VIEW ----------
let myVendorId = localStorage.getItem('jd_my_vendor_id') || null;
let myVendorPin = null; // hanya di memori (tidak disimpan permanen), diminta ulang tiap buka app baru
let pickedDuration = 120;
let selectedEmoji = '🍜';
let selectedModeIcon = null;
let regNameValue = '';
let regWhatsappValue = '';
let pickWhatsappValue = '';
let announcements = [];
let regPinValue = '';
let regReminderValue = '';
let isRegistering = false;

window.__updateRegField = function (field, value) {
  if (field === 'name') regNameValue = value;
  if (field === 'whatsapp') regWhatsappValue = value;
  if (field === 'pin') regPinValue = value;
  if (field === 'reminder') regReminderValue = value;
};
const VENDOR_MODE_OPTIONS = [
  { label: 'Warung/Kios Tetap', icon: 'warung' },
  { label: 'Jualan dari Rumah', icon: 'rumahan' },
  { label: 'Gerobak Dorong', icon: 'gerobak' },
  { label: 'Keliling Jalan Kaki', icon: 'keliling_jalan' },
  { label: 'Keliling Motor', icon: 'keliling_motor' },
  { label: 'Mobil/Truk Jualan', icon: 'truk' },
  { label: 'Lapak Pasar', icon: 'lapak_pasar' },
  { label: 'Pesan via Aplikasi', icon: 'aplikasi' },
  { label: 'Jasa Antar/Kurir', icon: 'kurir' },
];
const CATEGORY_OPTIONS = [
  { label: 'Bakso', icon: 'bakso' },
  { label: 'Mi Ayam', icon: 'mi_ayam' },
  { label: 'Siomay', icon: 'siomay' },
  { label: 'Sate', icon: 'sate' },
  { label: 'Gorengan', icon: 'gorengan' },
  { label: 'Nasi', icon: 'nasi' },
  { label: 'Jajanan', icon: 'jajanan' },
  { label: 'Minuman', icon: 'minuman' },
  { label: 'Kopi', icon: 'kopi' },
  { label: 'Roti & Kue', icon: 'roti_kue' },
  { label: 'Snack & Camilan', icon: 'snack_camilan' },
  { label: 'Buah', icon: 'buah' },
  { label: 'Sayur', icon: 'sayur' },
  { label: 'Ikan & Seafood', icon: 'ikan_seafood' },
  { label: 'Ayam & Daging', icon: 'ayam_daging' },
  { label: 'Telur', icon: 'telur' },
  { label: 'Sembako', icon: 'sembako' },
  { label: 'Warung', icon: 'warung' },
  { label: 'Toko Kelontong', icon: 'toko_kelontong' },
  { label: 'Pakaian', icon: 'pakaian' },
  { label: 'Sepatu & Sandal', icon: 'sepatu_sandal' },
  { label: 'Tas & Koper', icon: 'tas_koper' },
  { label: 'Aksesoris', icon: 'aksesoris' },
  { label: 'Kosmetik', icon: 'kosmetik' },
  { label: 'HP & Aksesoris', icon: 'hp_aksesoris' },
  { label: 'Elektronik', icon: 'elektronik' },
  { label: 'Alat Tulis', icon: 'alat_tulis' },
  { label: 'Mainan', icon: 'mainan' },
  { label: 'Bunga & Tanaman', icon: 'bunga_tanaman' },
  { label: 'Peralatan & Perkakas', icon: 'peralatan_perkakas' },
  { label: 'Rumah Tangga', icon: 'rumah_tangga' },
  { label: 'Sabun & Perawatan', icon: 'sabun_perawatan' },
  { label: 'BBM Eceran', icon: 'bbm_eceran' },
  { label: 'Gas LPG', icon: 'gas_lpg' },
  { label: 'Air Galon', icon: 'air_galon' },
  { label: 'Pulsa & Token', icon: 'pulsa_token' },
  { label: 'Fotokopi & Percetakan', icon: 'fotokopi_percetakan' },
  { label: 'Pangkas Rambut', icon: 'pangkas_rambut' },
  { label: 'Laundry', icon: 'laundry' },
  { label: 'Bengkel / Jasa Perbaikan', icon: 'bengkel_jasa_perbaikan' },
  { label: 'Jasa Antar', icon: 'jasa_antar' },
  { label: 'Jasa Keliling', icon: 'jasa_keliling' },
  { label: 'Bunga, Hadiah & Dekorasi', icon: 'bunga_hadiah_dekorasi' },
  { label: 'Kerajinan', icon: 'kerajinan' },
  { label: 'Lainnya', icon: 'lainnya' },
];
// Ikon vendor: foto dagangan (kalau aktif) > mode jualan (gambar) > emoji lama (fallback data lama)
function vendorIconStyle(v) {
  if (v.active && v.photo_url) return `background-image:url('${v.photo_url}');background-size:cover;background-position:center;`;
  if (v.mode_icon) return `background-image:url('mode_icons/${v.mode_icon}.png');background-size:cover;background-position:center;`;
  return '';
}
function vendorIconInner(v) {
  if (v.active && v.photo_url) return '';
  if (v.mode_icon) return '';
  return v.emoji || '🍜';
}

function categoryIconFile(label) {
  const found = CATEGORY_OPTIONS.find(c => c.label === label);
  return found ? `icons/${found.icon}.png` : null;
}
let selectedCategories = [];

window.__toggleCategory = function (c) {
  if (selectedCategories.includes(c)) selectedCategories = selectedCategories.filter(x => x !== c);
  else selectedCategories.push(c);
  renderPedagang();
};

window.__pickEmoji = function (e) {
  selectedEmoji = e;
  renderPedagang();
};

window.__pickModeIcon = function (icon) {
  selectedModeIcon = icon;
  renderPedagang();
};

// ---------- EDIT PROFIL TOKO ----------
let editCategories = [];
let editModeIcon = null;

window.__openEditProfile = function (vendorId) {
  const v = vendors.find(v => v.id === vendorId);
  if (!v) return;
  editCategories = [...(v.categories || [])];
  editModeIcon = v.mode_icon || null;
  renderEditProfile(vendorId);
};

function renderEditProfile(vendorId) {
  const v = vendors.find(v => v.id === vendorId);
  if (!v) return;

  const catHtml = CATEGORY_OPTIONS.map(c => `
    <button type="button" class="cat-picker-item ${editCategories.includes(c.label) ? 'picked' : ''}" onclick="window.__editToggleCategory('${c.label.replace(/'/g, "\\'")}')">
      <div class="cat-picker-icon-wrap"><img src="icons/${c.icon}.png" alt="${c.label}" /></div>
      <span>${c.label}</span>
    </button>
  `).join('');

  const modeHtml = VENDOR_MODE_OPTIONS.map(m => `
    <button type="button" class="cat-picker-item ${editModeIcon === m.icon ? 'picked' : ''}" onclick="window.__editPickModeIcon('${m.icon}')">
      <div class="cat-picker-icon-wrap"><img src="mode_icons/${m.icon}.png" alt="${m.label}" /></div>
      <span>${m.label}</span>
    </button>
  `).join('');

  main.innerHTML = `
    <div class="vendor-hero" style="text-align:left;">
      <div class="section-label" style="margin-top:0;">✏️ Edit Profil Toko</div>
      <div class="setup-form">
        <input id="edit-name" type="text" value="${v.name.replace(/"/g, '&quot;')}" placeholder="Nama usaha" />
        <input id="edit-whatsapp" type="tel" value="${v.whatsapp || ''}" placeholder="Nomor WhatsApp" />

        <div style="text-align:left;font-size:11px;color:var(--text-faint);margin-top:6px;">Mode jualan Anda (pilih 1)</div>
        <div class="cat-picker-grid">${modeHtml}</div>

        <div style="text-align:left;font-size:11px;color:var(--text-faint);margin-top:6px;">Jual apa saja? (tap untuk pilih, tap lagi untuk batal)</div>
        ${editCategories.length ? `
          <div class="selected-cat-strip">
            ${editCategories.map(label => `
              <span class="selected-cat-pill">${label} <button type="button" onclick="window.__editToggleCategory('${label.replace(/'/g, "\\'")}')">✕</button></span>
            `).join('')}
          </div>
        ` : `<div style="font-size:11px;color:var(--text-faint);">Belum ada yang dipilih</div>`}
        <div class="cat-picker-grid">${catHtml}</div>

        <div style="text-align:left;font-size:11px;color:var(--text-faint);margin-top:6px;">🔔 Ingin diingatkan buka lapak jam berapa? (opsional)</div>
        <input id="edit-reminder" type="time" value="${v.reminder_time ? v.reminder_time.slice(0, 5) : ''}" />

        <div style="text-align:left;background:var(--bg);border:1px solid var(--stroke);border-radius:12px;padding:12px;margin-top:10px;">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12.5px;font-weight:700;">
            <input id="edit-show-whatsapp" type="checkbox" ${v.show_whatsapp !== false ? 'checked' : ''} style="width:17px;height:17px;" />
            📱 Tampilkan nomor WhatsApp saya ke pembeli
          </label>
          <div style="font-size:10.5px;color:var(--text-faint);line-height:1.6;margin-top:8px;">
            Berapa pun pilihannya, pembeli tetap bisa hubungi Anda lewat <b>💬 Chat dalam app</b> — ini cuma soal apakah nomor WA Anda kelihatan juga atau tidak. Bisa diubah kapan saja.
          </div>
          <div style="font-size:10.5px;line-height:1.6;margin-top:8px;padding-top:8px;border-top:1px dashed var(--stroke);">
            <b style="color:#25D366;">✅ Kalau nomor WA ditampilkan:</b> pembeli bisa langsung chat/telpon Anda di WA yang biasa dipakai, lebih cepat & familiar. <b style="color:#f87171;">Risikonya:</b> nomor Anda bisa disimpan/dihubungi orang di luar urusan jual-beli (promosi, spam, dll), dan riwayat chatnya bercampur dengan kontak pribadi Anda.
          </div>
          <div style="font-size:10.5px;line-height:1.6;margin-top:6px;">
            <b style="color:#25D366;">✅ Kalau disembunyikan (chat app saja):</b> nomor pribadi Anda tetap privat, semua pesan jualan rapi di satu tempat (tab "💬 Pesan Pembeli"). <b style="color:#f87171;">Risikonya:</b> Anda perlu buka app ini untuk balas, tidak senotifikasi WA yang biasa Anda cek.
          </div>
        </div>

        <button onclick="window.__saveEditProfile('${vendorId}')">💾 Simpan Perubahan</button>
        <button type="button" onclick="renderPedagang()" style="background:transparent;border:1px solid var(--stroke);color:var(--text-dim);">Batal</button>
      </div>
      <div id="edit-error" style="color:#f87171;font-size:12px;margin-top:8px;"></div>
    </div>
  `;
}

window.__editToggleCategory = function (label) {
  if (editCategories.includes(label)) editCategories = editCategories.filter(c => c !== label);
  else editCategories.push(label);
  renderEditProfile(myVendorId);
};

window.__editPickModeIcon = function (icon) {
  editModeIcon = icon;
  renderEditProfile(myVendorId);
};

window.__saveEditProfile = async function (vendorId) {
  const errEl = document.getElementById('edit-error');
  const name = document.getElementById('edit-name').value.trim();
  const whatsapp = normalizeWhatsapp(document.getElementById('edit-whatsapp').value.trim());

  if (!name) { errEl.textContent = 'Nama usaha wajib diisi.'; return; }
  if (editCategories.length === 0) { errEl.textContent = 'Pilih minimal 1 jenis jualan.'; return; }

  // Sesi baru belum punya PIN di memori -> minta sekali (sama seperti alur toggle status)
  if (myVendorPin === null) {
    const enteredPin = prompt('Masukkan PIN akun Anda untuk konfirmasi:');
    if (enteredPin === null) return;
    const { data: ok } = await sb.rpc('verify_vendor_pin', { p_vendor_id: vendorId, p_pin: enteredPin.trim() });
    if (!ok) { errEl.textContent = 'PIN salah.'; return; }
    myVendorPin = enteredPin.trim();
  }

  errEl.textContent = 'Menyimpan...';
  try {
    const reminderTime = document.getElementById('edit-reminder').value.trim();
    const showWhatsapp = document.getElementById('edit-show-whatsapp').checked;
    const { error } = await sb.rpc('update_vendor_profile', {
      p_vendor_id: vendorId, p_pin: myVendorPin || '', p_name: name,
      p_categories: editCategories, p_mode_icon: editModeIcon, p_whatsapp: whatsapp,
    });
    if (error) throw error;

    // Kolom reminder_time & show_whatsapp diupdate terpisah (di luar RPC update_vendor_profile yang sudah ada).
    await sb.from('vendors').update({ reminder_time: reminderTime || null, show_whatsapp: showWhatsapp }).eq('id', vendorId);

    const v = vendors.find(v => v.id === vendorId);
    v.name = name; v.categories = editCategories; v.category = editCategories[0] || null;
    v.mode_icon = editModeIcon; v.whatsapp = whatsapp; v.reminder_time = reminderTime || null;
    v.show_whatsapp = showWhatsapp;
    showToast('Profil toko berhasil diperbarui! ✅');
    renderPedagang();
  } catch (e) {
    errEl.textContent = 'Gagal menyimpan: ' + e.message;
  }
};

function renderPedagang() {
  if (!myVendorId) {
    main.innerHTML = `
      ${vendors.length ? `
        <div class="vendor-hero" style="text-align:left;">
          <div class="section-label" style="margin-top:0;">Sudah pernah daftar? Masuk ke akun lama</div>
          <div class="setup-form">
            <input id="pick-whatsapp" type="tel" value="${pickWhatsappValue.replace(/"/g, '&quot;')}" oninput="window.__updatePickWhatsapp(this.value)" placeholder="Nomor WhatsApp terdaftar, misal: 81234567890" />
            <div style="text-align:left;font-size:11px;color:var(--text-faint);margin-top:-6px;">Boleh diawali 0 atau langsung 8 — otomatis diubah jadi +62. Contoh: 081234567890 atau 81234567890.</div>
            <input id="pick-pin" type="tel" inputmode="numeric" maxlength="4" placeholder="Masukkan PIN akun ini" />
            <button onclick="window.__pickVendor()">Masuk sebagai pedagang ini</button>
            <a href="#" onclick="window.__forgotPin(); return false;" style="text-align:center;font-size:11.5px;color:var(--text-faint);text-decoration:underline;">
              Lupa PIN? Hubungi admin
            </a>
          </div>
          <div id="pick-error" style="color:#f87171;font-size:12px;margin-top:8px;"></div>
        </div>
        <div class="section-label" style="text-align:center;">— atau daftar baru di bawah —</div>
      ` : ''}

      <div class="vendor-hero">
        <div class="vendor-hero-emoji">🛒</div>
        <div class="vendor-hero-name">Daftar Sebagai Pedagang</div>
        <div class="setup-form">
          <input id="reg-name" type="text" value="${regNameValue.replace(/"/g, '&quot;')}" oninput="window.__updateRegField('name', this.value)" placeholder="Nama usaha, misal: Bakso Pak Slamet" />
          <div style="text-align:left;font-size:11px;color:var(--text-faint);margin-top:2px;">Jual apa saja? (tap untuk pilih, tap lagi untuk batal)</div>
          ${selectedCategories.length ? `
            <div class="selected-cat-strip">
              ${selectedCategories.map(label => `
                <span class="selected-cat-pill">${label} <button type="button" onclick="window.__toggleCategory('${label.replace(/'/g, "\\'")}')">✕</button></span>
              `).join('')}
            </div>
          ` : `<div style="font-size:11px;color:var(--text-faint);">Belum ada yang dipilih — tap ikon di bawah</div>`}
          <div class="cat-picker-grid">
            ${CATEGORY_OPTIONS.map(c => `
              <button type="button" class="cat-picker-item ${selectedCategories.includes(c.label) ? 'picked' : ''}" onclick="window.__toggleCategory('${c.label.replace(/'/g, "\\'")}')">
                <div class="cat-picker-icon-wrap"><img src="icons/${c.icon}.png" alt="${c.label}" /></div>
                <span>${c.label}</span>
              </button>
            `).join('')}
          </div>
          <div style="text-align:left;font-size:11px;color:var(--text-faint);margin-top:2px;">Mode jualan Anda (pilih 1)</div>
          <div class="cat-picker-grid">
            ${VENDOR_MODE_OPTIONS.map(m => `
              <button type="button" class="cat-picker-item ${selectedModeIcon === m.icon ? 'picked' : ''}" onclick="window.__pickModeIcon('${m.icon}')">
                <div class="cat-picker-icon-wrap"><img src="mode_icons/${m.icon}.png" alt="${m.label}" /></div>
                <span>${m.label}</span>
              </button>
            `).join('')}
          </div>
          <input id="reg-whatsapp" type="tel" value="${regWhatsappValue.replace(/"/g, '&quot;')}" oninput="window.__updateRegField('whatsapp', this.value)" placeholder="Nomor WhatsApp — wajib (contoh: 6281234567890)" />
          <input id="reg-pin" type="tel" inputmode="numeric" maxlength="4" value="${regPinValue.replace(/"/g, '&quot;')}" oninput="window.__updateRegField('pin', this.value)" placeholder="Buat PIN 4 digit (untuk keamanan akun)" />
          <div style="text-align:left;font-size:11px;color:var(--text-faint);margin-top:2px;">🔔 Ingin diingatkan buka lapak jam berapa? (opsional)</div>
          <input id="reg-reminder" type="time" value="${regReminderValue}" oninput="window.__updateRegField('reminder', this.value)" />
          <button data-reg-submit onclick="window.__registerVendor()">🟢 Daftar Sekarang</button>
        </div>
        <div id="reg-error" style="color:#f87171;font-size:12px;margin-top:8px;"></div>
      </div>
    `;
    return;
  }

  const v = vendors.find(v => v.id === myVendorId);
  if (!v) { myVendorId = null; localStorage.removeItem('jd_my_vendor_id'); return renderPedagang(); }

  const untilStr = v.active_until
    ? new Date(v.active_until).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    : null;
  const durations = v.is_premium ? [30, 60, 120, 240, 480] : [30, 60, 120, 240];

  main.innerHTML = `
    ${renderAnnouncementBanner(getRelevantAnnouncementsForVendor(v))}
    <div class="vendor-hero">
      <div class="vendor-hero-emoji" style="${vendorIconStyle(v)}">${vendorIconInner(v)}</div>
      <div class="vendor-hero-name">${v.name}</div>
      <div class="vendor-hero-status ${v.active ? 'live' : ''} mono">
        ${v.active ? '🟢 SEDANG JUALAN · sampai ' + untilStr : '🔴 Belum jualan hari ini'}
      </div>

      ${!v.active ? `
        <div style="margin-top:16px;">
          <input type="file" id="photo-input" accept="image/*" capture="environment" style="display:none" onchange="window.__onPhotoSelected(event)" />
          <div id="photo-zone" onclick="document.getElementById('photo-input').click()" style="
            border:1.5px dashed var(--stroke); border-radius:14px; padding:16px;
            text-align:center; cursor:pointer; color:var(--text-dim); font-size:12.5px;">
            ${pendingPhotoPreview
              ? `<img src="${pendingPhotoPreview}" style="width:100%;border-radius:10px;margin-bottom:8px;" /><span style="color:var(--brand);">Ganti foto</span>`
              : '📷 Ambil foto dagangan (opsional)'}
          </div>
          <div style="font-size:10px;color:var(--text-faint);margin-top:5px;text-align:left;">
            Foto dagangan/gerobak saja. Foto tidak pantas akan dihapus tanpa pemberitahuan.
          </div>
        </div>
      ` : ''}

      <button class="big-toggle ${v.active ? 'on' : 'off'}" onclick="window.__toggleStatus()">
        ${v.active
          ? '🔴 SELESAI JUALAN <small>Tekan untuk berhenti</small>'
          : '🟢 SAYA JUALAN <small>Lokasi & status akan aktif</small>'}
      </button>

      ${!v.active ? `
        <div style="font-size:11px;color:var(--text-faint);margin-top:14px;text-align:left;">Berapa lama Anda jualan?</div>
        <div class="duration-row">
          ${durations.map(m => `
            <button class="${pickedDuration === m ? 'picked' : ''}" onclick="window.__setDuration(${m})">
              ${m < 60 ? m + ' mnt' : (m / 60) + ' jam'}
            </button>
          `).join('')}
        </div>
      ` : ''}
    </div>

    <div class="vendor-hero" style="margin-top:14px; text-align:left;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <span style="font-size:20px;">📱</span>
        <div>
          <div style="font-family:'Poppins';font-weight:700;font-size:13.5px;">QR Code & Link Pengikut Baru</div>
          <div style="font-size:11px;color:var(--text-faint);margin-top:1px;">Siapa saja yang scan atau klik ini langsung otomatis mengikuti Anda</div>
        </div>
      </div>
      <div id="vendor-qr-box" style="display:flex;justify-content:center;background:#fff;border-radius:12px;padding:14px;margin-bottom:10px;"></div>
      <button class="follow-btn" style="width:100%;padding:11px;background:#25D366;color:#fff;" onclick="window.__shareStatusImage('${v.id}','${v.name.replace(/'/g, "\\'")}')">
        🖼️ Bagikan
      </button>
    </div>

    <div class="vendor-hero" style="margin-top:14px; text-align:left;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <span style="font-size:20px;">💬</span>
        <div>
          <div style="font-family:'Poppins';font-weight:700;font-size:13.5px;">Pesan Pembeli</div>
          <div style="font-size:11px;color:var(--text-faint);margin-top:1px;">Chat langsung dari pembeli lewat app, gratis, tanpa perlu nomor WA Anda.</div>
        </div>
      </div>
      <div id="vendor-chat-inbox"><div style="color:var(--text-faint);font-size:11.5px;">Memuat pesan...</div></div>
    </div>

    <div class="vendor-hero" style="margin-top:14px; text-align:left;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <span style="font-size:20px;">🎯</span>
        <div>
          <div style="font-family:'Poppins';font-weight:700;font-size:13.5px;">Kampanye: Rekrut & Dapat Premium Gratis</div>
          <div style="font-size:11px;color:var(--text-faint);margin-top:1px;">Ajak 1 pedagang lain (yang benar-benar aktif jualan) + 10 pembeli baru lewat link Anda → 1 bulan Premium GRATIS</div>
        </div>
      </div>
      <div id="campaign-progress" style="margin-bottom:4px;">Memuat progres...</div>
      <div style="font-size:11px;color:var(--text-faint);text-align:center;padding-top:6px;border-top:1px solid var(--stroke);margin-top:6px;">
        💡 Pakai tombol <b style="color:var(--brand);">"Bagikan"</b> di atas untuk kejar target ini
      </div>
    </div>

    <div class="vendor-hero" style="margin-top:14px; text-align:left;">
      ${v.is_premium ? `
        ${(() => {
          if (!v.premium_until) return '';
          const daysLeft = Math.ceil((new Date(v.premium_until) - new Date()) / (1000 * 60 * 60 * 24));
          if (daysLeft > 10) return '';
          const untilStr = new Date(v.premium_until).toLocaleDateString('id-ID', { day: 'numeric', month: 'long' });
          return `
            <div style="background:#FFF3CD;border:1px solid #FFE08A;border-radius:12px;padding:10px 12px;margin-bottom:12px;display:flex;gap:8px;align-items:flex-start;">
              <span style="font-size:16px;">⏳</span>
              <div style="font-size:11.5px;color:#8A6D00;line-height:1.5;">
                ${daysLeft <= 0
                  ? `Premium Anda <b>sudah habis</b>. Hubungi admin untuk perpanjang.`
                  : `Premium Anda akan habis dalam <b>${daysLeft} hari</b> (${untilStr}). Hubungi admin untuk perpanjang.`}
              </div>
            </div>`;
        })()}
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:20px;">⭐</span>
          <div>
            <div style="font-family:'Poppins';font-weight:700;font-size:13.5px;">Akun Premium Aktif</div>
            <div style="font-size:11px;color:var(--text-faint);margin-top:1px;">Terima kasih sudah mendukung JajanDekat!</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;">
          <div style="flex:1;background:var(--bg);border-radius:12px;padding:10px;text-align:center;">
            <div id="premium-follow-count" style="font-family:'Poppins';font-weight:800;font-size:18px;color:var(--brand);">...</div>
            <div style="font-size:10px;color:var(--text-faint);margin-top:2px;">Pengikut</div>
          </div>
          <div style="flex:1;background:var(--bg);border-radius:12px;padding:10px;text-align:center;">
            <div style="font-family:'Poppins';font-weight:800;font-size:18px;color:var(--brand);">8 jam</div>
            <div style="font-size:10px;color:var(--text-faint);margin-top:2px;">Durasi maks.</div>
          </div>
        </div>
      ` : `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
          <span style="font-size:20px;">⭐</span>
          <div>
            <div style="font-family:'Poppins';font-weight:700;font-size:13.5px;">Upgrade ke Premium</div>
            <div style="font-size:11px;color:var(--text-faint);margin-top:1px;">Tampil di atas daftar + badge terpercaya</div>
          </div>
        </div>
        <button onclick="window.__requestPremium('${v.id}')"
           class="follow-btn" style="display:block;text-align:center;width:100%;padding:10px;background:var(--brand);color:#fff;border:none;">
          💬 Hubungi Admin via WhatsApp
        </button>
      `}
    </div>

    <div class="vendor-hero" style="margin-top:14px; text-align:left;">
      ${isPromoActive(v) ? `
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:20px;">🔥</span>
          <div>
            <div style="font-family:'Poppins';font-weight:700;font-size:13.5px;">Promo Lokal Aktif</div>
            <div style="font-size:11px;color:var(--text-faint);margin-top:1px;">Sampai ${new Date(v.promo_until).toLocaleString('id-ID', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} — kartu Anda disorot & tampil lebih atas</div>
          </div>
        </div>
      ` : `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
          <span style="font-size:20px;">🔥</span>
          <div>
            <div style="font-family:'Poppins';font-weight:700;font-size:13.5px;">Promosi Lokal Harian</div>
            <div style="font-size:11px;color:var(--text-faint);margin-top:1px;">Sorot kartu Anda ke posisi atas mulai Rp10rb/hari — cocok buat hari ramai/dagangan baru</div>
          </div>
        </div>
        <button onclick="window.__requestPromo('${v.id}')"
           class="follow-btn" style="display:block;text-align:center;width:100%;padding:10px;background:#F5A623;color:#fff;border:none;">
          💬 Pasang Promosi via WhatsApp
        </button>
      `}
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--stroke);">
        <div style="font-size:11px;color:var(--text-faint);margin-bottom:6px;">Tulisan promo (tampil di kartu Anda saat promo aktif) — contoh: "Diskon 20% khusus hari ini!"</div>
        <div style="display:flex;gap:6px;">
          <input id="promo-text-input" type="text" maxlength="80" value="${(v.promo_text || '').replace(/"/g, '&quot;')}" placeholder="Tulis promo Anda di sini..." style="flex:1;" />
          <button onclick="window.__savePromoText('${v.id}')" style="width:auto;padding:0 14px;">💾</button>
        </div>
        <div id="promo-text-error" style="color:#f87171;font-size:11px;margin-top:4px;"></div>
      </div>
    </div>

    <div class="vendor-hero" style="margin-top:14px; text-align:left;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <span style="font-size:20px;">💬</span>
        <div>
          <div style="font-family:'Poppins';font-weight:700;font-size:13.5px;">Ulasan dari Pembeli (Privat)</div>
          <div style="font-size:11px;color:var(--text-faint);margin-top:1px;">Cuma Anda & admin yang bisa lihat ini — jadikan masukan buat perbaikan</div>
        </div>
      </div>
      <div id="my-reviews-list" style="font-size:12px;color:var(--text-faint);">Memuat ulasan...</div>
    </div>

    <button class="follow-btn" style="margin-top:14px;width:100%;padding:10px;background:var(--surface-2);color:var(--text);" onclick="window.__openEditProfile('${v.id}')">✏️ Edit Profil Toko (nama, mode jualan, kategori)</button>
    <button class="follow-btn" style="margin-top:8px;width:100%;padding:10px;" onclick="window.__logoutVendor()">Ganti akun pedagang</button>
    <a href="privacy.html" style="display:block;text-align:center;font-size:11px;color:var(--text-faint);margin-top:12px;text-decoration:underline;">Kebijakan Privasi</a>
    <a href="terms.html" style="display:block;text-align:center;font-size:11px;color:var(--text-faint);margin-top:6px;text-decoration:underline;">Ketentuan Layanan</a>
  `;

  renderVendorQr(v.id);
  loadMyReviews(v.id);

  if (v.is_premium) {
    sb.from('follows').select('id', { count: 'exact', head: true }).eq('vendor_id', v.id).then(({ count }) => {
      const el = document.getElementById('premium-follow-count');
      if (el) el.textContent = count ?? 0;
    });
  }

  loadCampaignProgress(v.id);
  loadVendorChatInbox(v.id);
}

async function loadVendorChatInbox(vendorId) {
  const el = document.getElementById('vendor-chat-inbox');
  if (!el) return;
  const { data: threads, error } = await sb.from('chat_threads').select('id,buyer_device_id,last_message_at,last_message_preview').eq('vendor_id', vendorId).order('last_message_at', { ascending: false }).limit(30);
  if (!el) return;
  if (error) { el.innerHTML = `<div style="color:#f87171;font-size:11.5px;">Gagal memuat pesan.</div>`; return; }
  if (!threads || !threads.length) { el.innerHTML = `<div style="color:var(--text-faint);font-size:11.5px;">Belum ada pesan dari pembeli.</div>`; return; }

  const threadIds = threads.map(t => t.id);
  const { data: unreadRows } = await sb.from('chat_messages').select('thread_id').eq('sender', 'buyer').is('read_at', null).in('thread_id', threadIds);
  const unreadCount = {};
  (unreadRows || []).forEach(r => { unreadCount[r.thread_id] = (unreadCount[r.thread_id] || 0) + 1; });

  el.innerHTML = threads.map(t => {
    const label = 'Pembeli #' + t.buyer_device_id.slice(-5).toUpperCase();
    const unread = unreadCount[t.id] || 0;
    const timeStr = new Date(t.last_message_at).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `
      <div onclick="window.__openVendorChatThread('${t.id}','${label}')" style="display:flex;align-items:center;gap:8px;padding:10px 4px;border-bottom:1px solid var(--stroke);cursor:pointer;">
        <div style="width:34px;height:34px;border-radius:50%;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">🙋</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:12.5px;font-weight:700;">${label} ${unread ? `<span style="background:#f87171;color:#fff;border-radius:10px;padding:1px 7px;font-size:10px;margin-left:4px;">${unread} baru</span>` : ''}</div>
          <div style="font-size:11px;color:var(--text-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(t.last_message_preview || '')}</div>
        </div>
        <div style="font-size:9.5px;color:var(--text-faint);flex-shrink:0;">${timeStr}</div>
      </div>
    `;
  }).join('');
}

async function loadCampaignProgress(vendorId) {
  const el = document.getElementById('campaign-progress');
  if (!el) return;

  const [{ data: recruitedVendors }, { count: referredBuyers }] = await Promise.all([
    sb.from('vendors').select('id,name,activation_count').eq('referred_by_vendor_id', vendorId),
    sb.from('follows').select('id', { count: 'exact', head: true }).eq('vendor_id', vendorId).eq('via_referral', true),
  ]);

  const validVendorRecruit = (recruitedVendors || []).find(r => r.activation_count >= 3);
  const vendorDone = !!validVendorRecruit;
  const buyerCount = Math.min(referredBuyers ?? 0, 10);
  const buyerDone = buyerCount >= 10;
  const allDone = vendorDone && buyerDone;

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <span style="font-size:14px;">${vendorDone ? '🟢' : '⚪'}</span>
      <span style="font-size:11.5px;">1 pedagang aktif direkrut ${vendorDone ? `(${validVendorRecruit.name})` : '— belum ada yang memenuhi syarat'}</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
      <span style="font-size:14px;">${buyerDone ? '🟢' : '⚪'}</span>
      <span style="font-size:11.5px;">${buyerCount}/10 pembeli baru lewat link Anda</span>
    </div>
    <div style="background:var(--stroke);border-radius:999px;height:7px;overflow:hidden;margin-bottom:6px;">
      <div style="background:${allDone ? 'var(--aktif)' : 'var(--brand)'};height:100%;width:${((buyerCount / 10) * 0.5 + (vendorDone ? 0.5 : 0)) * 100}%;transition:width .3s;"></div>
    </div>
    ${allDone
      ? '<div style="font-size:11.5px;color:var(--aktif);font-weight:700;">🎉 Syarat terpenuhi! Admin akan meninjau dan mengaktifkan Premium Anda dalam 1-2 hari.</div>'
      : '<div style="font-size:10.5px;color:var(--text-faint);">Pedagang dihitung sah setelah aktif jualan minimal 3x. Pembeli dihitung dari yang follow lewat link/QR Anda.</div>'}
  `;
}

async function loadMyReviews(vendorId) {
  const el = document.getElementById('my-reviews-list');
  if (!el) return;
  el.innerHTML = `<button class="follow-btn" style="width:100%;padding:10px;" onclick="window.__revealMyReviews('${vendorId}')">🔒 Tap untuk lihat ulasan (perlu PIN)</button>`;
}

window.__revealMyReviews = async function (vendorId) {
  const el = document.getElementById('my-reviews-list');
  if (!el) return;
  let pin = myVendorPin;
  if (pin === null) {
    pin = prompt('Masukkan PIN akun Anda:');
    if (pin === null) return;
    pin = pin.trim();
  }
  el.innerHTML = 'Memuat...';
  const { data, error } = await sb.rpc('get_my_reviews', { p_vendor_id: vendorId, p_pin: pin });
  if (error) { el.innerHTML = `<span style="color:#f87171;">PIN salah atau gagal memuat.</span>`; return; }
  myVendorPin = pin;
  if (!data || data.length === 0) { el.innerHTML = 'Belum ada ulasan masuk.'; return; }
  el.innerHTML = data.map(r => `
    <div style="padding:8px 0;border-bottom:1px solid var(--stroke);">
      <div style="color:#F5A623;font-size:13px;">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</div>
      ${r.comment ? `<div style="font-size:12px;color:var(--text);margin-top:3px;">${r.comment}</div>` : ''}
      <div style="font-size:10px;color:var(--text-faint);margin-top:2px;">${new Date(r.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
    </div>
  `).join('');
};

function followLinkFor(vendorId) {
  const code = vendorId.slice(0, 6).toUpperCase();
  return `${location.origin}${location.pathname}?follow=${code}`;
}

function renderVendorQr(vendorId) {
  const box = document.getElementById('vendor-qr-box');
  if (!box || typeof QRCode === 'undefined') return;
  box.innerHTML = '';
  new QRCode(box, {
    text: followLinkFor(vendorId),
    width: 160, height: 160,
    colorDark: '#201A13', colorLight: '#ffffff',
  });
}

// ---------- GENERATOR GAMBAR STATUS (canvas, otomatis terisi nama/status/link) ----------
function loadImageSafe(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Generate QR jadi <canvas> tersembunyi (dites: dipakai teks yang SAMA persis dengan QR yang sudah terbukti bisa di-scan di kotak QR utama)
function generateQrCanvas(text, size) {
  return new Promise((resolve) => {
    const temp = document.createElement('div');
    temp.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
    document.body.appendChild(temp);
    try {
      new QRCode(temp, { text, width: size, height: size, colorDark: '#201A13', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
      // qrcodejs merender sinkron, tapi kasih 1 tick biar pasti selesai
      setTimeout(() => {
        const canvas = temp.querySelector('canvas');
        const img = temp.querySelector('img');
        if (canvas) {
          resolve(canvas);
        } else if (img && img.src) {
          const fallbackImg = new Image();
          fallbackImg.onload = () => resolve(fallbackImg);
          fallbackImg.src = img.src;
        } else {
          resolve(null);
        }
        document.body.removeChild(temp);
      }, 50);
    } catch (e) {
      console.error('Gagal generate QR untuk gambar:', e);
      document.body.removeChild(temp);
      resolve(null);
    }
  });
}

async function generateVendorShareImage(v, vendorName) {
  const W = 1120, H = 1400;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  const link = followLinkFor(v.id);
  const isActive = v.active;

  // Latar + border
  ctx.fillStyle = '#FAF7F2';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#FF6B4A';
  ctx.lineWidth = 10;
  roundRect(ctx, 15, 15, W - 30, H - 30, 50);
  ctx.stroke();

  // Brand
  ctx.textAlign = 'center';
  ctx.font = '700 58px sans-serif';
  ctx.fillStyle = '#201A13';
  ctx.fillText('Jajan', W / 2 - 65, 110);
  ctx.fillStyle = '#FF6B4A';
  ctx.fillText('Dekat', W / 2 + 80, 110);
  ctx.font = '400 27px sans-serif';
  ctx.fillStyle = '#8A8072';
  ctx.fillText('Cek dulu, baru jalan.', W / 2, 152);

  // Badge status
  const badgeText = isActive ? '🟢 SEDANG JUALAN SEKARANG' : 'IKUTI SAYA DI JAJANDEKAT';
  const badgeColor = isActive ? '#2FAE60' : '#FF6B4A';
  ctx.font = '700 30px sans-serif';
  const badgeW = ctx.measureText(badgeText).width + 60;
  ctx.fillStyle = badgeColor;
  roundRect(ctx, W / 2 - badgeW / 2, 195, badgeW, 62, 31);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(badgeText, W / 2, 236);

  // ---- Baris dua kolom: kiri (foto+nama+kategori), kanan (kotak QR) ----
  const rowTop = 300;
  const leftX = 70, leftW = 460;
  const rightX = 570, rightW = W - 70 - rightX + 70, boxSize = 420;

  // Kiri: lingkaran foto/ikon
  const circleR = 200, circleCx = leftX + circleR, circleCy = rowTop + circleR;
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath(); ctx.arc(circleCx, circleCy, circleR, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#FFE7DF'; ctx.lineWidth = 8; ctx.stroke();

  const iconSrc = v.photo_url || (v.mode_icon ? `mode_icons/${v.mode_icon}.png` : `icons/${(v.categories && v.categories[0] && categoryIconFile(v.categories[0])) || 'icons/lainnya.png'}`);
  const iconImg = await loadImageSafe(iconSrc);
  if (iconImg) {
    ctx.save();
    ctx.beginPath(); ctx.arc(circleCx, circleCy, circleR - 18, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(iconImg, leftX + 18, rowTop + 18, circleR * 2 - 36, circleR * 2 - 36);
    ctx.restore();
  }

  // Nama & kategori di bawah lingkaran (rata kiri)
  ctx.textAlign = 'left';
  ctx.font = '700 46px sans-serif';
  ctx.fillStyle = '#201A13';
  wrapTextLeft(ctx, vendorName, leftX, circleCy + circleR + 70, leftW, 54);
  ctx.font = '400 30px sans-serif';
  ctx.fillStyle = '#8A8072';
  ctx.fillText((v.categories || []).join(' · ') || 'Pedagang Keliling', leftX, circleCy + circleR + 150);

  // Kanan: kotak QR
  const qrBoxY = rowTop, qrBoxX = rightX;
  ctx.strokeStyle = '#FF6B4A'; ctx.lineWidth = 4;
  roundRect(ctx, qrBoxX, qrBoxY, boxSize, boxSize + 90, 24);
  ctx.stroke();

  // Label pill di atas kotak
  ctx.textAlign = 'center';
  ctx.font = '700 24px sans-serif';
  const pillText = 'SCAN QR PENJUAL';
  const pillW = ctx.measureText(pillText).width + 44;
  const pillX = qrBoxX + boxSize / 2 - pillW / 2, pillY = qrBoxY - 26;
  ctx.fillStyle = '#FF6B4A';
  roundRect(ctx, pillX, pillY, pillW, 52, 26);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(pillText, qrBoxX + boxSize / 2, pillY + 34);

  // QR asli — pakai teks yang SAMA PERSIS dengan kotak QR utama (link) supaya konsisten & sudah teruji
  const qrSize = boxSize - 60;
  const qrCanvas = await generateQrCanvas(link, qrSize);
  if (qrCanvas) {
    ctx.drawImage(qrCanvas, qrBoxX + 30, qrBoxY + 30, qrSize, qrSize);
  } else {
    ctx.font = '400 20px sans-serif';
    ctx.fillStyle = '#B5AC9C';
    wrapText(ctx, 'QR tidak tersedia — buka link manual', qrBoxX + boxSize / 2, qrBoxY + boxSize / 2, boxSize - 60, 28);
  }
  ctx.font = '400 24px sans-serif';
  ctx.fillStyle = '#8A8072';
  wrapText(ctx, 'Scan untuk lihat lokasi & follow', qrBoxX + boxSize / 2, qrBoxY + boxSize + 55, boxSize - 40, 28);

  // Tombol CTA
  const ctaText = '📍 Cek Lokasi Sekarang';
  const btnW = 620, btnH = 92, btnY = H - 205;
  ctx.fillStyle = '#FF6B4A';
  roundRect(ctx, W / 2 - btnW / 2, btnY, btnW, btnH, 24);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = '700 36px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(ctaText, W / 2, btnY + 60);

  // Footer
  ctx.font = '400 27px sans-serif';
  ctx.fillStyle = '#B5AC9C';
  ctx.fillText('🌐 jajandekat.my.id', W / 2, H - 55);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '', lines = [];
  for (const w of words) {
    const test = line + w + ' ';
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w + ' '; }
    else line = test;
  }
  lines.push(line);
  const startY = y - (lines.length - 1) * lineHeight / 2;
  lines.forEach((l, i) => ctx.fillText(l.trim(), x, startY + i * lineHeight));
}

function wrapTextLeft(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '', lines = [];
  for (const w of words) {
    const test = line + w + ' ';
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w + ' '; }
    else line = test;
  }
  lines.push(line);
  lines.forEach((l, i) => ctx.fillText(l.trim(), x, y + i * lineHeight));
}

async function generateShareImage({ badgeText, badgeColor, iconSrc, titleText, subtitleText, ctaText, linkText }) {
  const W = 1080, H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#FAF7F2';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#FF6B4A';
  ctx.lineWidth = 10;
  roundRect(ctx, 15, 15, W - 30, H - 30, 50);
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.font = '700 56px sans-serif';
  ctx.fillStyle = '#201A13';
  ctx.fillText('Jajan', W / 2 - 60, 110);
  ctx.fillStyle = '#FF6B4A';
  ctx.fillText('Dekat', W / 2 + 75, 110);
  ctx.font = '400 26px sans-serif';
  ctx.fillStyle = '#8A8072';
  ctx.fillText('Cek dulu, baru jalan.', W / 2, 150);

  ctx.font = '700 30px sans-serif';
  const badgeW = ctx.measureText(badgeText).width + 60;
  const badgeX = W / 2 - badgeW / 2;
  ctx.fillStyle = badgeColor;
  roundRect(ctx, badgeX, 190, badgeW, 60, 30);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(badgeText, W / 2, 230);

  const iconBoxY = 290, iconBoxSize = 420;
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(W / 2, iconBoxY + iconBoxSize / 2, iconBoxSize / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#FFE7DF';
  ctx.lineWidth = 8;
  ctx.stroke();

  const img = await loadImageSafe(iconSrc);
  if (img) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(W / 2, iconBoxY + iconBoxSize / 2, iconBoxSize / 2 - 20, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, W / 2 - iconBoxSize / 2 + 20, iconBoxY + 20, iconBoxSize - 40, iconBoxSize - 40);
    ctx.restore();
  }

  ctx.font = '700 52px sans-serif';
  ctx.fillStyle = '#201A13';
  wrapText(ctx, titleText, W / 2, iconBoxY + iconBoxSize + 90, W - 160, 60);
  ctx.font = '400 30px sans-serif';
  ctx.fillStyle = '#8A8072';
  ctx.fillText(subtitleText, W / 2, iconBoxY + iconBoxSize + 150);

  const btnW = 560, btnH = 90, btnY = H - 220;
  ctx.fillStyle = '#FF6B4A';
  roundRect(ctx, W / 2 - btnW / 2, btnY, btnW, btnH, 24);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = '700 34px sans-serif';
  ctx.fillText(ctaText, W / 2, btnY + 58);

  ctx.font = '400 26px sans-serif';
  ctx.fillStyle = '#B5AC9C';
  ctx.fillText(linkText, W / 2, H - 60);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

async function shareGeneratedImage(blob, filename, caption) {
  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], text: caption }).catch(() => {});
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    showToast('Gambar tersimpan! Buka galeri untuk kirim manual ke WhatsApp.');
  }
}

// Dipanggil dari layar Pedagang — SATU tombol, QR sudah tertanam di gambar
window.__shareStatusImage = async function (vendorId, vendorName) {
  const v = vendors.find(v => v.id === vendorId);
  if (!v) return;
  showToast('Membuat gambar...');
  const link = followLinkFor(vendorId);
  const blob = await generateVendorShareImage(v, vendorName);
  const caption = v.active ? `${vendorName} lagi jualan sekarang! Cek & follow di: ${link}` : `Yuk follow ${vendorName} di JajanDekat! ${link}`;
  shareGeneratedImage(blob, `jajandekat-${vendorName.replace(/\s+/g, '-')}.png`, caption);
};

// Dipanggil dari layar Pembeli (tombol "Bagikan Aplikasi")
window.__shareAppImage = async function () {
  showToast('Membuat gambar...');
  const blob = await generateShareImage({
    badgeText: '🍜 CARI JAJANAN KELILING',
    badgeColor: '#FF6B4A',
    iconSrc: 'icons/bakso.png',
    titleText: 'Pedagang favoritmu lagi jualan!',
    subtitleText: 'Cek dulu sebelum jalan, gratis tanpa akun',
    ctaText: 'Buka Sekarang',
    linkText: 'jajandekat.my.id',
  });
  const caption = `Cari pedagang keliling yang lagi jualan di sekitarmu — cek dulu, baru jalan! Coba JajanDekat: ${location.origin}${location.pathname}`;
  shareGeneratedImage(blob, 'jajandekat-ajak-teman.png', caption);
};

window.__shareFollowQr = function (vendorId, vendorName) {
  const link = followLinkFor(vendorId);
  const text = `Yuk follow ${vendorName} di JajanDekat biar tahu kapan lagi jualan! Tap link ini: ${link}`;
  if (navigator.share) {
    navigator.share({ title: vendorName, text, url: link }).catch(() => {});
  } else {
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  }
};

let pendingPhotoFile = null;
let pendingPhotoPreview = null;
let pendingAnnImageFile = null;
let pendingAnnImagePreview = null;
let confirmedDuplicateName = false;

window.__onPhotoSelected = function (event) {
  const file = event.target.files[0];
  if (!file) return;
  pendingPhotoFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    pendingPhotoPreview = e.target.result;
    renderPedagang();
  };
  reader.readAsDataURL(file);
};

window.__onAnnouncementImageSelected = function (event) {
  const file = event.target.files[0];
  if (!file) return;
  pendingAnnImageFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    pendingAnnImagePreview = e.target.result;
    const zone = document.getElementById('ann-image-zone');
    if (zone) zone.innerHTML = `<img src="${pendingAnnImagePreview}" style="width:100%;border-radius:10px;" /><div style="margin-top:4px;color:var(--brand);">Ganti gambar</div>`;
  };
  reader.readAsDataURL(file);
};

// Deteksi kabupaten/kota otomatis dari GPS, pakai layanan gratis OpenStreetMap (Nominatim)
function detectRegion() {
  const detection = new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const { latitude, longitude } = pos.coords;
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=10&addressdetails=1`);
        const json = await res.json();
        const addr = json.address || {};
        const region = addr.county || addr.city || addr.state_district || addr.city_district || addr.state || null;
        resolve(region);
      } catch (e) {
        console.error('Gagal deteksi wilayah:', e);
        resolve(null);
      }
    }, () => resolve(null), { timeout: 8000 });
  });
  // Jaga-jaga: kalau fetch reverse-geocode menggantung tanpa batas, jangan sampai macetkan pendaftaran
  const hardTimeout = new Promise((resolve) => setTimeout(() => resolve(null), 10000));
  return Promise.race([detection, hardTimeout]);
}

function normalizeWhatsapp(raw) {
  if (!raw) return raw;
  let n = raw.replace(/[^\d]/g, ''); // buang spasi, strip, tanda +, dll
  if (n.startsWith('0')) n = '62' + n.slice(1);
  else if (!n.startsWith('62')) n = '62' + n;
  return n;
}

window.__registerVendor = async function () {
  if (isRegistering) return; // cegah klik ganda saat masih diproses
  const name = (document.getElementById('reg-name')?.value || regNameValue).trim();
  const categories = selectedCategories;
  const category = categories[0] || null; // kolom lama, dijaga tetap terisi untuk kompatibilitas
  const emoji = selectedEmoji;
  const modeIcon = selectedModeIcon;
  const whatsapp = normalizeWhatsapp((document.getElementById('reg-whatsapp')?.value || regWhatsappValue).trim());
  const pin = (document.getElementById('reg-pin')?.value || regPinValue).trim();
  const reminderTime = (document.getElementById('reg-reminder')?.value || regReminderValue).trim();
  const errEl = document.getElementById('reg-error');

  if (!name) { errEl.textContent = 'Nama usaha wajib diisi.'; return; }
  if (categories.length === 0) { errEl.textContent = 'Pilih minimal 1 jenis jualan.'; return; }
  if (!modeIcon) { errEl.textContent = 'Pilih mode jualan Anda.'; return; }
  if (!whatsapp) { errEl.textContent = 'Nomor WhatsApp wajib diisi (jadi penanda akun Anda).'; return; }
  if (!/^\d{4}$/.test(pin)) { errEl.textContent = 'PIN wajib 4 angka.'; return; }

  // Cegah satu nomor WA didaftarkan dua kali
  const dupe = vendors.find(v => v.whatsapp === whatsapp);
  if (dupe) {
    errEl.textContent = `Nomor ini sudah terdaftar sebagai "${dupe.name}". Masuk pakai PIN di bawah, atau hubungi admin kalau lupa PIN.`;
    return;
  }

  // Nama sama tapi WA beda — boleh lanjut, tapi beri peringatan dulu (butuh klik sekali lagi)
  const nameDupe = vendors.find(v => v.name.trim().toLowerCase() === name.toLowerCase());
  if (nameDupe && !confirmedDuplicateName) {
    errEl.textContent = `Sudah ada pedagang bernama "${nameDupe.name}" terdaftar. Kalau ini memang usaha berbeda, tekan "Daftar Sekarang" sekali lagi untuk lanjut.`;
    confirmedDuplicateName = true;
    return;
  }
  confirmedDuplicateName = false;

  errEl.textContent = 'Mendaftarkan...';
  isRegistering = true;
  const submitBtn = document.querySelector('[data-reg-submit]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '⏳ Mendaftarkan...'; }
  try {
    // Deteksi kode rekrut dari link/QR (?follow=KODE) — link yang sama dipakai untuk rekrut pembeli & pedagang
    const refCode = new URLSearchParams(location.search).get('follow') || referralCodeFromLink;
    let referredByVendorId = null;
    if (refCode) {
      const referrer = vendors.find(v => v.id.toUpperCase().startsWith(refCode.toUpperCase()));
      if (referrer) referredByVendorId = referrer.id;
    }

    const region = await detectRegion(); // otomatis, tidak menghalangi kalau ditolak/gagal

    const { data, error } = await sb
      .from('vendors')
      .insert({ name, category, categories, emoji, mode_icon: modeIcon, whatsapp, pin, referred_by_vendor_id: referredByVendorId, region, reminder_time: reminderTime || null })
      .select('id,name,category,categories,emoji,mode_icon,whatsapp,show_whatsapp,active,active_until,lat,lng,photo_url,is_premium,premium_until,promo_text,reminder_time,created_at')
      .single();

    if (error) {
      const friendly = error.message.includes('vendors_whatsapp_unique')
        ? 'Nomor WhatsApp ini sudah terdaftar. Masuk pakai PIN di bawah, atau hubungi admin kalau lupa PIN.'
        : 'Gagal mendaftar: ' + error.message;
      errEl.textContent = friendly;
      return;
    }

    vendors.push(data);
    myVendorId = data.id;
    myVendorPin = pin;
    localStorage.setItem('jd_my_vendor_id', myVendorId);
    selectedEmoji = '🍜';
    selectedModeIcon = null;
    selectedCategories = [];
    regNameValue = ''; regWhatsappValue = ''; regPinValue = ''; regReminderValue = '';
    Promise.resolve(sb.rpc('link_owner_device', { p_vendor_id: data.id, p_pin: pin, p_device_id: deviceId })).catch(() => {});
    ensurePushSubscription();
    renderPedagang();
  } catch (e) {
    console.error('Error saat daftar:', e);
    errEl.textContent = 'Gagal mendaftar: ' + (e && e.message ? e.message : 'terjadi kesalahan tidak diketahui') + '. Coba lagi.';
  } finally {
    isRegistering = false;
    const btn = document.querySelector('[data-reg-submit]');
    if (btn) { btn.disabled = false; btn.textContent = '🟢 Daftar Sekarang'; }
  }
};

window.__updatePickWhatsapp = function (value) {
  pickWhatsappValue = value;
};

window.__forgotPin = function () {
  const raw = (document.getElementById('pick-whatsapp')?.value || pickWhatsappValue).trim();
  const whatsapp = normalizeWhatsapp(raw);
  const msg = whatsapp
    ? `Halo, saya lupa PIN akun pedagang JajanDekat saya. Nomor WhatsApp terdaftar: ${whatsapp}`
    : `Halo, saya lupa PIN akun pedagang JajanDekat saya.`;
  window.open(`https://wa.me/${ADMIN_WHATSAPP}?text=${encodeURIComponent(msg)}`, '_blank');
};

window.__pickVendor = async function () {
  const whatsappInput = document.getElementById('pick-whatsapp');
  const pinInput = document.getElementById('pick-pin');
  const errEl = document.getElementById('pick-error');

  const whatsapp = normalizeWhatsapp((whatsappInput ? whatsappInput.value : pickWhatsappValue).trim());
  if (!whatsapp) { errEl.textContent = 'Isi nomor WhatsApp yang terdaftar.'; return; }

  const vendor = vendors.find(v => v.whatsapp === whatsapp);
  if (!vendor) { errEl.textContent = 'Nomor ini belum terdaftar. Cek lagi atau daftar baru di bawah.'; return; }

  const enteredPin = pinInput ? pinInput.value.trim() : '';
  errEl.textContent = 'Memeriksa...';

  const { data: ok, error } = await sb.rpc('verify_vendor_pin', { p_vendor_id: vendor.id, p_pin: enteredPin });
  if (error) { errEl.textContent = 'Gagal memeriksa PIN: ' + error.message; return; }
  if (!ok) { errEl.textContent = 'PIN salah. Coba lagi.'; return; }

  myVendorId = vendor.id;
  myVendorPin = enteredPin;
  pickWhatsappValue = '';
  localStorage.setItem('jd_my_vendor_id', myVendorId);
  Promise.resolve(sb.rpc('link_owner_device', { p_vendor_id: myVendorId, p_pin: enteredPin, p_device_id: deviceId })).catch(() => {});
  ensurePushSubscription();
  renderPedagang();
};

window.__logoutVendor = function () {
  myVendorId = null;
  myVendorPin = null;
  localStorage.removeItem('jd_my_vendor_id');
  renderPedagang();
};

window.__setDuration = function (mins) {
  pickedDuration = mins;
  renderPedagang();
};

async function sendPushToFollowers(vendorId, vendorName) {
  try {
    await sb.functions.invoke('send-vendor-push', { body: { vendor_id: vendorId, vendor_name: vendorName } });
  } catch (e) {
    console.error('Gagal kirim notifikasi push:', e); // tidak fatal, status tetap aktif walau notif gagal
  }
}

window.__toggleStatus = async function () {
  const v = vendors.find(v => v.id === myVendorId);
  if (!v) return;

  // Sesi baru (habis refresh/buka app lagi) belum punya PIN di memori -> minta sekali
  if (myVendorPin === null) {
    const enteredPin = prompt('Masukkan PIN akun Anda untuk konfirmasi:');
    if (enteredPin === null) return; // dibatalkan
    const { data: ok, error } = await sb.rpc('verify_vendor_pin', { p_vendor_id: v.id, p_pin: enteredPin.trim() });
    if (error || !ok) { alert('PIN salah.'); return; }
    myVendorPin = enteredPin.trim();
  }
  if (v.active) {
    try {
      await deleteVendorPhotoByUrl(v.photo_url);
      await setVendorStatus(v.id, false);
      v.active = false; v.active_until = null; v.photo_url = null;
    } catch (e) {
      alert('Gagal mengubah status: ' + (e.message || 'PIN mungkin salah.'));
      return;
    }
  } else {
    // Ambil lokasi nyata dari browser (gratis, bawaan HP)
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude, longitude } = pos.coords;
      let photoUrl = null;
      if (pendingPhotoFile) {
        try { photoUrl = await uploadVendorPhoto(v.id, pendingPhotoFile); }
        catch (e) { console.error('Gagal upload foto:', e); }
      }
      try {
        await setVendorStatus(v.id, true, pickedDuration, latitude, longitude, photoUrl);
      } catch (e) {
        alert('Gagal mengaktifkan status: ' + (e.message || 'PIN mungkin salah.'));
        return;
      }
      v.active = true; v.lat = latitude; v.lng = longitude; v.photo_url = photoUrl;
      v.active_until = new Date(Date.now() + pickedDuration * 60000).toISOString();
      pendingPhotoFile = null; pendingPhotoPreview = null;
      sendPushToFollowers(v.id, v.name);
      renderPedagang();
    }, async () => {
      // Kalau lokasi ditolak, tetap aktifkan status tanpa koordinat — tapi beri tahu jelas dulu
      const lanjut = confirm(
        '⚠️ Izin lokasi ditolak/tidak aktif.\n\n' +
        'Anda tetap bisa berstatus "sedang jualan", tapi pembeli TIDAK akan melihat Anda di Peta ' +
        '(cuma muncul di daftar biasa tanpa lokasi).\n\n' +
        'Tekan OK untuk tetap lanjut tanpa lokasi, atau Batal untuk mengaktifkan izin lokasi dulu di pengaturan HP.'
      );
      if (!lanjut) return;

      let photoUrl = null;
      if (pendingPhotoFile) {
        try { photoUrl = await uploadVendorPhoto(v.id, pendingPhotoFile); }
        catch (e) { console.error('Gagal upload foto:', e); }
      }
      try {
        await setVendorStatus(v.id, true, pickedDuration, null, null, photoUrl);
      } catch (e) {
        alert('Gagal mengaktifkan status: ' + (e.message || 'PIN mungkin salah.'));
        return;
      }
      v.active = true; v.photo_url = photoUrl; v.lat = null; v.lng = null;
      v.active_until = new Date(Date.now() + pickedDuration * 60000).toISOString();
      pendingPhotoFile = null; pendingPhotoPreview = null;
      sendPushToFollowers(v.id, v.name);
      renderPedagang();
    });
    return;
  }
  renderPedagang();
};

window.__setCat = function (c) {
  activeCat = c;
  renderPembeli();
};

window.__toggleFollow = async function (vendorId) {
  const isFollowing = followedIds.has(vendorId);
  if (isFollowing) followedIds.delete(vendorId); else followedIds.add(vendorId);
  renderPembeli();
  await toggleFollowDb(vendorId, isFollowing);
  if (!isFollowing) ensurePushSubscription(); // baru follow -> saat inilah momen terbaik minta izin notifikasi
};

// ---------- ERROR SCREEN ----------
function renderError(message) {
  main.innerHTML = `
    <div class="vendor-hero" style="margin-top:24px;">
      <div class="vendor-hero-emoji">⚠️</div>
      <div class="vendor-hero-name">Gagal memuat data</div>
      <div class="vendor-hero-status" style="margin-top:10px; line-height:1.6;">
        ${message}
      </div>
    </div>
  `;
}

// ---------- RATING & ULASAN ----------
let reviewModalRating = 5;

window.__openReviewModal = function (vendorId, vendorName) {
  reviewModalRating = 5;
  const overlay = document.createElement('div');
  overlay.id = 'review-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:200;display:flex;align-items:flex-end;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:var(--surface);width:100%;max-width:480px;border-radius:20px 20px 0 0;padding:20px;">
      <div style="font-family:'Poppins';font-weight:700;font-size:15px;margin-bottom:4px;">Beri Ulasan</div>
      <div style="font-size:11px;color:var(--text-faint);margin-bottom:14px;">${vendorName} · Ulasan Anda privat, hanya dilihat pedagang & admin untuk perbaikan kualitas — tidak ditampilkan ke publik.</div>
      <div id="star-picker" style="display:flex;gap:6px;justify-content:center;font-size:32px;margin-bottom:14px;"></div>
      <textarea id="review-comment" placeholder="Komentar (opsional)..." style="width:100%;min-height:70px;background:var(--bg);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-family:inherit;font-size:13px;resize:vertical;"></textarea>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button onclick="document.getElementById('review-modal-overlay').remove()" style="flex:1;padding:11px;border-radius:10px;border:1px solid var(--stroke);background:transparent;color:var(--text-dim);font-weight:600;">Batal</button>
        <button onclick="window.__submitReview('${vendorId}')" style="flex:2;padding:11px;border-radius:10px;border:none;background:var(--brand);color:#fff;font-weight:700;">Kirim Ulasan</button>
      </div>
      <button onclick="window.__openReportModal('${vendorId}','${vendorName.replace(/'/g, "\\'")}')" style="display:block;width:100%;text-align:center;margin-top:12px;background:none;border:none;color:#f87171;font-size:11px;text-decoration:underline;">
        🚩 Laporkan penyalahgunaan (foto tidak pantas, akun palsu, dll)
      </button>
    </div>
  `;
  document.body.appendChild(overlay);
  renderStarPicker();
};

window.__openReportModal = function (vendorId, vendorName) {
  document.getElementById('review-modal-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'review-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:200;display:flex;align-items:flex-end;justify-content:center;';
  const reasons = ['Foto tidak pantas', 'Diduga akun palsu/hoax', 'Penipuan', 'Konten tidak sesuai', 'Lainnya'];
  overlay.innerHTML = `
    <div style="background:var(--surface);width:100%;max-width:480px;border-radius:20px 20px 0 0;padding:20px;">
      <div style="font-family:'Poppins';font-weight:700;font-size:15px;margin-bottom:4px;">🚩 Laporkan Pedagang</div>
      <div style="font-size:11px;color:var(--text-faint);margin-bottom:14px;">${vendorName} · Laporan langsung ke admin untuk diverifikasi.</div>
      <select id="report-reason" style="width:100%;background:var(--bg);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-family:inherit;font-size:13px;margin-bottom:10px;">
        ${reasons.map(r => `<option value="${r}">${r}</option>`).join('')}
      </select>
      <textarea id="report-detail" placeholder="Jelaskan detail laporan Anda..." style="width:100%;min-height:70px;background:var(--bg);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-family:inherit;font-size:13px;resize:vertical;"></textarea>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button onclick="document.getElementById('review-modal-overlay').remove()" style="flex:1;padding:11px;border-radius:10px;border:1px solid var(--stroke);background:transparent;color:var(--text-dim);font-weight:600;">Batal</button>
        <button onclick="window.__submitReport('${vendorId}')" style="flex:2;padding:11px;border-radius:10px;border:none;background:#f87171;color:#fff;font-weight:700;">Kirim Laporan</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
};

window.__submitReport = async function (vendorId) {
  const reason = document.getElementById('report-reason').value;
  const detail = document.getElementById('report-detail').value.trim();
  try {
    await sb.from('reports').insert({ vendor_id: vendorId, device_id: deviceId, reason, detail: detail || null });
    document.getElementById('review-modal-overlay').remove();
    showToast('Laporan terkirim ke admin. Terima kasih! 🙏');
  } catch (e) {
    alert('Gagal mengirim laporan: ' + e.message);
  }
};

function renderStarPicker() {
  const el = document.getElementById('star-picker');
  if (!el) return;
  el.innerHTML = [1, 2, 3, 4, 5].map(n => `
    <span onclick="window.__setReviewRating(${n})" style="cursor:pointer;color:${n <= reviewModalRating ? '#F5A623' : '#E0DBD2'};">★</span>
  `).join('');
}

window.__setReviewRating = function (n) {
  reviewModalRating = n;
  renderStarPicker();
};

window.__submitReview = async function (vendorId) {
  const comment = document.getElementById('review-comment').value.trim();
  try {
    await sb.rpc('submit_review', { p_vendor_id: vendorId, p_device_id: deviceId, p_rating: reviewModalRating, p_comment: comment || null });
    document.getElementById('review-modal-overlay').remove();
    showToast('Terima kasih atas ulasannya! ⭐');
    vendors = (await fetchVendors()).map(normalizeExpiry);
    if (mode === 'pembeli') renderPembeli();
  } catch (e) {
    alert('Gagal mengirim ulasan: ' + e.message);
  }
};

let tapCount = 0;
let tapTimer = null;
let isSuperAdmin = false;
let adminPasswordCache = null;
let adminVendorData = [];

const brandTapZone = document.getElementById('brand-tap-zone');
if (brandTapZone) {
  brandTapZone.addEventListener('click', () => {
    tapCount++;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { tapCount = 0; }, 1500);
    if (tapCount >= 5) {
      tapCount = 0;
      const pw = prompt('Password admin:');
      if (pw === SUPER_ADMIN_PASSWORD) {
        isSuperAdmin = true;
        adminPasswordCache = pw;
        renderAdminDashboard();
      } else if (pw !== null) {
        alert('Password salah.');
      }
    }
  });
}

window.__requestPremium = async function (vendorId) {
  const v = vendors.find(x => x.id === vendorId);
  if (!v) return;
  try {
    await sb.from('vendor_requests').insert({ vendor_id: vendorId, type: 'premium' });
  } catch (e) { /* tetap lanjut buka WA walau insert gagal */ }
  const msg = 'Halo, saya ' + v.name + ' (ID: ' + v.id + ') mau upgrade ke Premium JajanDekat.';
  window.open(`https://wa.me/${ADMIN_WHATSAPP}?text=${encodeURIComponent(msg)}`, '_blank');
};

window.__requestPromo = async function (vendorId) {
  const v = vendors.find(x => x.id === vendorId);
  if (!v) return;
  try {
    await sb.from('vendor_requests').insert({ vendor_id: vendorId, type: 'promo' });
  } catch (e) { /* tetap lanjut buka WA walau insert gagal */ }
  const msg = 'Halo, saya ' + v.name + ' (ID: ' + v.id + ') mau pasang Promosi Lokal di JajanDekat.';
  window.open(`https://wa.me/${ADMIN_WHATSAPP}?text=${encodeURIComponent(msg)}`, '_blank');
};

window.__savePromoText = async function (vendorId) {
  const errEl = document.getElementById('promo-text-error');
  const text = document.getElementById('promo-text-input').value.trim();

  if (myVendorPin === null) {
    const enteredPin = prompt('Masukkan PIN akun Anda untuk konfirmasi:');
    if (enteredPin === null) return;
    const { data: ok } = await sb.rpc('verify_vendor_pin', { p_vendor_id: vendorId, p_pin: enteredPin.trim() });
    if (!ok) { errEl.textContent = 'PIN salah.'; return; }
    myVendorPin = enteredPin.trim();
  }

  errEl.textContent = 'Menyimpan...';
  try {
    const { error } = await sb.rpc('update_vendor_promo_text', {
      p_vendor_id: vendorId, p_pin: myVendorPin || '', p_promo_text: text || null,
    });
    if (error) throw error;
    const v = vendors.find(v => v.id === vendorId);
    if (v) v.promo_text = text || null;
    errEl.textContent = '';
    showToast('Tulisan promo disimpan! ✅');
  } catch (e) {
    errEl.textContent = 'Gagal menyimpan: ' + e.message;
  }
};

async function renderAdminDashboard() {
  document.getElementById('mode-toggle-wrap').style.display = 'none';
  document.querySelector('nav.bottom').style.display = 'none';

  main.innerHTML = `
    <div class="section-label">🔒 Dashboard Admin</div>
    <div class="admin-tabs">
      <button class="admin-tab active" data-tab="stats" onclick="window.__adminSwitchTab('stats')">📊 Statistik</button>
      <button class="admin-tab" data-tab="vendors" onclick="window.__adminSwitchTab('vendors')">🏪 Pedagang</button>
      <button class="admin-tab" data-tab="articles" onclick="window.__adminSwitchTab('articles')">📝 Artikel</button>
      <button class="admin-tab" data-tab="requests" onclick="window.__adminSwitchTab('requests')">🔔 Permintaan</button>
      <button class="admin-tab" data-tab="reports" onclick="window.__adminSwitchTab('reports')">🚩 Laporan</button>
      <button class="admin-tab" data-tab="announcements" onclick="window.__adminSwitchTab('announcements')">📢 Pengumuman</button>
    </div>

    <div class="admin-panel" data-panel="stats">
      <div id="admin-stats" class="stat-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:18px;">
        <div style="color:var(--text-faint);font-size:11px;grid-column:1/-1;">Memuat statistik...</div>
      </div>
      <div id="admin-stats-extra"></div>
    </div>

    <div class="admin-panel" data-panel="vendors" style="display:none;">
      <input id="admin-search" type="text" placeholder="🔍 Cari nama usaha atau nomor WA (paste dari WA di sini)" oninput="window.__adminSearchVendors(this.value)" style="width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);margin-bottom:10px;font-size:12.5px;" />
      <div id="admin-list" class="vendor-list"><div style="color:var(--text-faint);font-size:12.5px;">Memuat...</div></div>
    </div>

    <div class="admin-panel" data-panel="articles" style="display:none;">
      <div class="section-label" style="margin-top:0;font-size:11px;color:var(--brand);">🕓 Menunggu Review (ditulis AI)</div>
      <div id="admin-articles-pending" style="margin-bottom:14px;"><div style="color:var(--text-faint);font-size:11.5px;">Memuat...</div></div>
      <button class="follow-btn" style="width:100%;padding:10px;margin-bottom:10px;" onclick="window.__adminOpenArticleForm()">✍️ Tulis Artikel Baru</button>
      <div id="admin-articles" class="vendor-list"><div style="color:var(--text-faint);font-size:11.5px;">Memuat artikel...</div></div>
    </div>

    <div class="admin-panel" data-panel="requests" style="display:none;">
      <div id="admin-requests" class="vendor-list"><div style="color:var(--text-faint);font-size:11.5px;">Memuat permintaan...</div></div>
    </div>

    <div class="admin-panel" data-panel="reports" style="display:none;">
      <div id="admin-reports" class="vendor-list"><div style="color:var(--text-faint);font-size:11.5px;">Memuat laporan...</div></div>
    </div>

    <div class="admin-panel" data-panel="announcements" style="display:none;">
      <div class="vendor-hero" style="text-align:left;margin-bottom:10px;">
        <textarea id="ann-message" rows="3" placeholder="Isi pengumuman..." style="width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-family:inherit;font-size:12.5px;resize:vertical;"></textarea>
        <input id="ann-link" type="url" placeholder="Link (opsional) — https://..." style="width:100%;box-sizing:border-box;margin-top:8px;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-size:12.5px;" />
        <input type="file" id="ann-image-input" accept="image/*" style="display:none" onchange="window.__onAnnouncementImageSelected(event)" />
        <div id="ann-image-zone" onclick="document.getElementById('ann-image-input').click()" style="margin-top:8px;border:1.5px dashed var(--stroke);border-radius:12px;padding:12px;text-align:center;color:var(--text-dim);font-size:12px;cursor:pointer;">
          📷 Tambah gambar (opsional)
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <select id="ann-audience" style="flex:1;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-size:12px;">
            <option value="semua">Semua</option>
            <option value="premium">Pedagang Premium</option>
            <option value="biasa">Pedagang Biasa</option>
            <option value="pembeli">Pembeli</option>
          </select>
          <select id="ann-zone-level" onchange="document.getElementById('ann-zone-value-wrap').style.display = this.value === 'nasional' ? 'none' : ''" style="flex:1;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-size:12px;">
            <option value="nasional">Zona: Nasional</option>
            <option value="provinsi">Zona: Provinsi</option>
            <option value="kabupaten">Zona: Kabupaten/Kota</option>
            <option value="kecamatan">Zona: Kecamatan</option>
          </select>
        </div>
        <div id="ann-zone-value-wrap" style="display:none;margin-top:8px;">
          <input id="ann-zone-value" type="text" placeholder="Nama wilayah, misal: Kutai Timur" style="width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-size:12.5px;" />
          <div style="font-size:10px;color:var(--text-faint);margin-top:4px;">Dicocokkan dengan wilayah (kabupaten/kota) yang terdeteksi otomatis saat pedagang daftar. Zona untuk audiens Pembeli belum didukung penuh (lokasi pembeli tidak disimpan).</div>
        </div>
        <button onclick="window.__adminCreateAnnouncement()" style="margin-top:10px;">📢 Kirim Pengumuman</button>
        <div id="ann-error" style="color:#f87171;font-size:12px;margin-top:6px;"></div>
      </div>
      <div id="admin-announcements" class="vendor-list"><div style="color:var(--text-faint);font-size:11.5px;">Memuat pengumuman...</div></div>
    </div>

    <button class="follow-btn" style="margin-top:16px;width:100%;padding:10px;" onclick="window.__exitAdmin()">← Keluar dari Dashboard Admin</button>
  `;

  const { data, error } = await sb.from('vendors').select('id,name,category,categories,emoji,mode_icon,whatsapp,show_whatsapp,active,active_until,lat,lng,photo_url,is_premium,premium_until,promo_until,promo_text,reminder_time,created_at,region,location_updated_at,location_error_message,location_error_at').order('created_at', { ascending: false });
  const listEl = document.getElementById('admin-list');
  const statsEl = document.getElementById('admin-stats');

  if (error) { listEl.innerHTML = `<div style="color:#f87171;font-size:12.5px;">Gagal memuat: ${error.message}</div>`; return; }

  const { count: totalFollows } = await sb.from('follows').select('id', { count: 'exact', head: true });
  const { data: allFollowDevices } = await sb.from('follows').select('device_id');
  const uniqueBuyers = new Set((allFollowDevices || []).map(f => f.device_id)).size;
  const { count: totalReferred } = await sb.from('vendors').select('id', { count: 'exact', head: true }).not('referred_by_vendor_id', 'is', null);
  const totalPedagang = data.length;
  const aktifSekarang = data.filter(v => v.active).length;
  const totalPremium = data.filter(v => v.is_premium).length;

  statsEl.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--stroke);border-radius:12px;padding:10px;text-align:center;">
      <div style="font-family:'Poppins';font-weight:800;font-size:17px;">${totalPedagang}</div>
      <div style="font-size:9.5px;color:var(--text-faint);">Total Pedagang</div>
    </div>
    <div style="background:var(--surface);border:1px solid var(--stroke);border-radius:12px;padding:10px;text-align:center;">
      <div style="font-family:'Poppins';font-weight:800;font-size:17px;color:var(--aktif);">${aktifSekarang}</div>
      <div style="font-size:9.5px;color:var(--text-faint);">Aktif Sekarang</div>
    </div>
    <div style="background:var(--surface);border:1px solid var(--stroke);border-radius:12px;padding:10px;text-align:center;">
      <div style="font-family:'Poppins';font-weight:800;font-size:17px;color:var(--brand);">${totalPremium}</div>
      <div style="font-size:9.5px;color:var(--text-faint);">Premium</div>
    </div>
    <div style="background:var(--surface);border:1px solid var(--stroke);border-radius:12px;padding:10px;text-align:center;">
      <div style="font-family:'Poppins';font-weight:800;font-size:17px;">${totalFollows ?? 0}</div>
      <div style="font-size:9.5px;color:var(--text-faint);">Total Follow</div>
    </div>
    <div style="background:var(--surface);border:1px solid var(--stroke);border-radius:12px;padding:10px;text-align:center;">
      <div style="font-family:'Poppins';font-weight:800;font-size:17px;color:var(--live-icon, var(--aktif));">${uniqueBuyers}</div>
      <div style="font-size:9.5px;color:var(--text-faint);">Pembeli Unik</div>
    </div>
  `;
  // Ringkasan sebaran wilayah (kabupaten/kota), dari deteksi GPS otomatis saat daftar
  const regionCounts = {};
  data.forEach(v => {
    const r = v.region || 'Belum terdeteksi';
    regionCounts[r] = (regionCounts[r] || 0) + 1;
  });
  const sortedRegions = Object.entries(regionCounts).sort((a, b) => b[1] - a[1]);
  const regionHtml = sortedRegions.map(([region, count]) => {
    const pct = Math.round((count / totalPedagang) * 100);
    return `
      <div style="margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:3px;">
          <span style="font-weight:600;">${region}</span>
          <span style="color:var(--text-faint);">${count} pedagang (${pct}%)</span>
        </div>
        <div style="background:var(--stroke);border-radius:999px;height:6px;overflow:hidden;">
          <div style="background:var(--brand);height:100%;width:${pct}%;"></div>
        </div>
      </div>`;
  }).join('');

  // Pertumbuhan pedagang per minggu (6 minggu terakhir)
  const weekBuckets = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const weekStart = new Date(now); weekStart.setDate(now.getDate() - (i + 1) * 7);
    const weekEnd = new Date(now); weekEnd.setDate(now.getDate() - i * 7);
    const count = data.filter(v => {
      const d = new Date(v.created_at);
      return d > weekStart && d <= weekEnd;
    }).length;
    weekBuckets.push({ label: i === 0 ? 'Minggu ini' : `${i} mgu lalu`, count });
  }
  const maxWeekCount = Math.max(1, ...weekBuckets.map(w => w.count));
  const growthHtml = weekBuckets.map(w => `
    <div style="display:flex;flex-direction:column;align-items:center;flex:1;gap:4px;">
      <div style="font-size:10px;font-weight:700;color:var(--text);">${w.count}</div>
      <div style="width:100%;background:var(--stroke);border-radius:6px 6px 0 0;height:60px;display:flex;align-items:flex-end;overflow:hidden;">
        <div style="width:100%;background:var(--brand);border-radius:6px 6px 0 0;height:${(w.count / maxWeekCount) * 100}%;"></div>
      </div>
      <div style="font-size:8.5px;color:var(--text-faint);text-align:center;">${w.label}</div>
    </div>
  `).join('');

  // Kategori terpopuler
  const catCounts = {};
  data.forEach(v => (v.categories || []).forEach(c => { catCounts[c] = (catCounts[c] || 0) + 1; }));
  const topCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const topCatsHtml = topCats.map(([cat, count], i) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;${i < topCats.length - 1 ? 'border-bottom:1px solid var(--stroke);' : ''}">
      <span style="font-size:12px;font-weight:600;">${i + 1}. ${cat}</span>
      <span style="font-size:11px;color:var(--brand);font-weight:700;">${count} pedagang</span>
    </div>
  `).join('');

  document.getElementById('admin-stats-extra').innerHTML = `
    <div style="font-size:11px;color:var(--text-faint);margin:2px 0 4px;">📤 ${totalReferred ?? 0} pedagang bergabung lewat link referral pedagang lain — cek satu-satu di daftar bawah untuk lihat siapa yang berhak dapat bonus.</div>

    <div class="section-label" style="margin-top:4px;">📈 Pertumbuhan Pedagang (6 Minggu Terakhir)</div>
    <div style="background:var(--surface);border:1px solid var(--stroke);border-radius:14px;padding:14px 10px;margin-bottom:14px;display:flex;gap:6px;">
      ${growthHtml}
    </div>

    <div class="section-label" style="margin-top:4px;">🏆 Kategori Terpopuler</div>
    <div style="background:var(--surface);border:1px solid var(--stroke);border-radius:14px;padding:6px 14px;margin-bottom:14px;">
      ${topCatsHtml || '<div style="color:var(--text-faint);font-size:11.5px;padding:8px 0;">Belum ada data.</div>'}
    </div>

    <div class="section-label" style="margin-top:4px;">📍 Sebaran per Kabupaten/Kota</div>
    <div style="background:var(--surface);border:1px solid var(--stroke);border-radius:14px;padding:14px;margin-bottom:14px;">
      ${regionHtml || '<div style="color:var(--text-faint);font-size:11.5px;">Belum ada data.</div>'}
    </div>
  `;
  loadAdminReports();
  loadAdminRequests();
  loadAdminAnnouncements();
  loadAdminArticles();

  adminVendorData = data;
  listEl.innerHTML = renderAdminVendorList(adminVendorData);
}

window.__adminSwitchTab = function (tab) {
  document.querySelectorAll('.admin-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  document.querySelectorAll('.admin-panel').forEach(panel => { panel.style.display = panel.dataset.panel === tab ? '' : 'none'; });
};

function renderAdminVendorList(list) {
  return list.map(v => {
    const premiumUntilStr = v.premium_until ? new Date(v.premium_until).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
    return `
    <div class="vendor-card" id="admin-vendor-${v.id}" style="flex-direction:column;align-items:stretch;gap:10px;">
      <div style="display:flex;gap:10px;align-items:center;">
        <div class="vendor-emoji" style="${vendorIconStyle(v)}">${vendorIconInner(v)}</div>
        <div class="vendor-info">
          <div class="vendor-name">${v.name}${v.is_premium ? ' <span class="premium-badge">⭐</span>' : ''}</div>
          <div class="vendor-sub mono">WA: ${v.whatsapp || '-'} · (PIN tersembunyi — pakai "Reset PIN" kalau perlu)</div>
          <div class="vendor-sub">${(v.categories || []).join(' · ') || '-'} · ${v.active ? '🟢 aktif' : '🔴 tidak aktif'}</div>
          ${v.is_premium ? `<div class="vendor-sub" style="color:var(--brand);">⭐ Premium sampai ${premiumUntilStr || '(tanpa batas — akun lama)'}</div>` : ''}
          ${v.active && v.location_error_message && (!v.location_updated_at || new Date(v.location_error_at) > new Date(v.location_updated_at)) ? `<div class="vendor-sub" style="color:#f87171;">📍⚠️ Lokasi gagal update (${new Date(v.location_error_at).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}): ${escapeHtml(v.location_error_message)}</div>` : ''}
          ${v.active && v.location_updated_at ? `<div class="vendor-sub" style="color:var(--text-faint);">📍 Lokasi terakhir update: ${new Date(v.location_updated_at).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>` : ''}
          ${v.promo_until && new Date(v.promo_until) > new Date() ? `<div class="vendor-sub" style="color:#F5A623;">🔥 Promo sampai ${new Date(v.promo_until).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>` : ''}
        </div>
      </div>
      <div class="admin-row">
        <button class="icon-btn" title="Reset PIN" onclick="window.__adminResetPin('${v.id}','${v.name.replace(/'/g, "\\'")}')">🔑</button>
        ${v.photo_url ? `<button class="icon-btn" title="Hapus Foto" onclick="window.__adminRemovePhoto('${v.id}')">🖼️</button>` : ''}
        <button class="icon-btn danger" title="Hapus Akun" onclick="window.__adminDeleteVendor('${v.id}','${v.name.replace(/'/g, "\\'")}')">🗑️</button>
        <span style="flex:1;"></span>
        ${v.is_premium ? `<button class="admin-cancel-link" onclick="window.__adminCancelPremium('${v.id}')">Cabut Premium</button>` : ''}
        ${v.promo_until && new Date(v.promo_until) > new Date() ? `<button class="admin-cancel-link" onclick="window.__adminCancelPromo('${v.id}')">Cabut Promo</button>` : ''}
      </div>
      <div class="admin-row">
        <span class="label">⭐ Premium</span>
        <select class="admin-select" id="premium-dur-${v.id}">
          <option value="1">1 Bulan</option>
          <option value="3">3 Bulan</option>
          <option value="6">6 Bulan</option>
          <option value="12">1 Tahun</option>
        </select>
        <button class="admin-go-btn" onclick="window.__adminSetPremium('${v.id}', parseInt(document.getElementById('premium-dur-${v.id}').value))">Aktifkan</button>
      </div>
      <div class="admin-row">
        <span class="label">🔥 Promo</span>
        <select class="admin-select" id="promo-dur-${v.id}">
          <option value="1">1 Hari</option>
          <option value="3">3 Hari</option>
          <option value="7">7 Hari</option>
        </select>
        <button class="admin-go-btn" onclick="window.__adminSetPromo('${v.id}', parseInt(document.getElementById('promo-dur-${v.id}').value))">Aktifkan</button>
      </div>
    </div>
  `;
  }).join('') || '<div style="color:var(--text-faint);font-size:12.5px;">Belum ada pedagang terdaftar.</div>';
}

window.__adminSearchVendors = function (query) {
  const q = query.trim().toLowerCase();
  const qDigits = query.replace(/[^\d]/g, '');
  const listEl = document.getElementById('admin-list');
  if (!listEl) return;
  if (!q) { listEl.innerHTML = renderAdminVendorList(adminVendorData); return; }
  const filtered = adminVendorData.filter(v => {
    const nameMatch = (v.name || '').toLowerCase().includes(q);
    const waMatch = qDigits.length >= 3 && (v.whatsapp || '').includes(qDigits.startsWith('0') ? '62' + qDigits.slice(1) : qDigits);
    return nameMatch || waMatch;
  });
  listEl.innerHTML = renderAdminVendorList(filtered);
};

async function loadAdminRequests() {
  const el = document.getElementById('admin-requests');
  if (!el) return;
  try {
    const { data, error } = await sb
      .from('vendor_requests')
      .select('id,type,status,created_at,vendors(id,name,whatsapp,category)')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error) throw error;
    if (!data || data.length === 0) { el.innerHTML = '<div style="color:var(--text-faint);font-size:11.5px;">Belum ada permintaan masuk. 👍</div>'; return; }
    el.innerHTML = data.map(r => {
      const v = r.vendors;
      if (!v) return '';
      const label = r.type === 'premium' ? '⭐ Upgrade Premium' : '🔥 Pasang Promo Lokal';
      return `
      <div class="vendor-card" style="flex-direction:column;align-items:stretch;gap:6px;border-color:#F5A623;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:700;font-size:12.5px;">${v.name}</span>
          <span style="font-size:9.5px;padding:3px 8px;border-radius:999px;background:#FEF3C7;color:#92400E;">${label}</span>
        </div>
        <div style="font-size:11px;color:var(--text-dim);" class="mono">WA: ${v.whatsapp || '-'} · ${v.category || '-'}</div>
        <div style="font-size:9.5px;color:var(--text-faint);">${new Date(r.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;">
          ${r.type === 'premium' ? `
            <button class="follow-btn" onclick="window.__adminHandleRequest('${r.id}','${v.id}','premium',1)">1 Bln</button>
            <button class="follow-btn" onclick="window.__adminHandleRequest('${r.id}','${v.id}','premium',3)">3 Bln</button>
            <button class="follow-btn" onclick="window.__adminHandleRequest('${r.id}','${v.id}','premium',6)">6 Bln</button>
          ` : `
            <button class="follow-btn" onclick="window.__adminHandleRequest('${r.id}','${v.id}','promo',1)">1 Hari</button>
            <button class="follow-btn" onclick="window.__adminHandleRequest('${r.id}','${v.id}','promo',3)">3 Hari</button>
            <button class="follow-btn" onclick="window.__adminHandleRequest('${r.id}','${v.id}','promo',7)">7 Hari</button>
          `}
          <button class="follow-btn" onclick="window.__jumpToVendor('${v.id}','${(v.whatsapp || '').replace(/'/g, "\\'")}')">🔍 Lihat Pedagang</button>
          <button class="follow-btn" style="color:#f87171;" onclick="window.__dismissVendorRequest('${r.id}')">✕ Tutup</button>
        </div>
      </div>
    `;
    }).join('');
  } catch (e) {
    el.innerHTML = `<span style="color:#f87171;font-size:11.5px;">Gagal memuat permintaan: ${e.message}</span>`;
  }
}

window.__adminHandleRequest = async function (requestId, vendorId, type, amount) {
  try {
    if (type === 'premium') await window.__adminSetPremium(vendorId, amount, true);
    else await window.__adminSetPromo(vendorId, amount, true);
    await sb.from('vendor_requests').update({ status: 'selesai' }).eq('id', requestId);
    renderAdminDashboard();
  } catch (e) {
    alert('Gagal memproses permintaan: ' + e.message);
  }
};

window.__dismissVendorRequest = async function (requestId) {
  try {
    await sb.from('vendor_requests').update({ status: 'selesai' }).eq('id', requestId);
    loadAdminRequests();
  } catch (e) {
    alert('Gagal menutup permintaan: ' + e.message);
  }
};

window.__jumpToVendor = function (vendorId, whatsapp) {
  const searchInput = document.getElementById('admin-search');
  if (searchInput) {
    searchInput.value = whatsapp || '';
    window.__adminSearchVendors(searchInput.value);
  }
  const card = document.getElementById(`admin-vendor-${vendorId}`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.style.transition = 'box-shadow 0.3s';
    card.style.boxShadow = '0 0 0 2px #F5A623';
    setTimeout(() => { card.style.boxShadow = ''; }, 2000);
  }
};

async function loadAdminAnnouncements() {
  const el = document.getElementById('admin-announcements');
  if (!el) return;
  try {
    const { data, error } = await sb.from('announcements').select('*').eq('active', true).order('created_at', { ascending: false });
    if (error) throw error;
    if (!data || data.length === 0) { el.innerHTML = '<div style="color:var(--text-faint);font-size:11.5px;">Belum ada pengumuman aktif.</div>'; return; }
    const audienceLabel = { semua: 'Semua', premium: 'Pedagang Premium', biasa: 'Pedagang Biasa', pembeli: 'Pembeli' };
    const zoneLabel = { nasional: 'Nasional', provinsi: 'Provinsi', kabupaten: 'Kabupaten/Kota', kecamatan: 'Kecamatan' };
    el.innerHTML = data.map(a => `
      <div class="vendor-card" style="flex-direction:column;align-items:stretch;gap:6px;">
        ${a.image_url ? `<img src="${a.image_url}" style="width:100%;border-radius:10px;" />` : ''}
        <div style="font-size:12px;white-space:pre-wrap;">${escapeHtml(a.message)}</div>
        <div style="font-size:10px;color:var(--text-faint);">
          🎯 ${audienceLabel[a.audience] || a.audience} · 📍 ${zoneLabel[a.zone_level] || 'Nasional'}${a.zone_value ? ' (' + escapeHtml(a.zone_value) + ')' : ''}
        </div>
        <div style="font-size:9.5px;color:var(--text-faint);">${new Date(a.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
        <button class="follow-btn" style="color:#f87171;" onclick="window.__adminDeactivateAnnouncement('${a.id}')">✕ Nonaktifkan</button>
      </div>
    `).join('');
  } catch (e) {
    el.innerHTML = `<span style="color:#f87171;font-size:11.5px;">Gagal memuat pengumuman: ${e.message}</span>`;
  }
}

window.__adminCreateAnnouncement = async function () {
  const errEl = document.getElementById('ann-error');
  const message = document.getElementById('ann-message').value.trim();
  const link = document.getElementById('ann-link').value.trim();
  const audience = document.getElementById('ann-audience').value;
  const zoneLevel = document.getElementById('ann-zone-level').value;
  const zoneValue = document.getElementById('ann-zone-value').value.trim();

  if (!message) { errEl.textContent = 'Isi pengumuman wajib diisi.'; return; }
  if (zoneLevel !== 'nasional' && !zoneValue) { errEl.textContent = 'Isi nama wilayah untuk zona yang dipilih, atau ganti ke Nasional.'; return; }

  errEl.textContent = 'Mengirim...';
  try {
    let imageUrl = null;
    if (pendingAnnImageFile) {
      imageUrl = await uploadAnnouncementImage(pendingAnnImageFile);
    }
    const { error } = await sb.from('announcements').insert({
      message,
      link: link || null,
      image_url: imageUrl,
      audience,
      zone_level: zoneLevel,
      zone_value: zoneLevel === 'nasional' ? null : zoneValue,
    });
    if (error) throw error;

    pendingAnnImageFile = null; pendingAnnImagePreview = null;
    document.getElementById('ann-message').value = '';
    document.getElementById('ann-link').value = '';
    document.getElementById('ann-zone-value').value = '';
    const zone = document.getElementById('ann-image-zone');
    if (zone) zone.innerHTML = '📷 Tambah gambar (opsional)';
    errEl.textContent = '';
    showToast('Pengumuman terkirim! 📢');
    announcements = await fetchAnnouncements();
    loadAdminAnnouncements();
  } catch (e) {
    errEl.textContent = 'Gagal mengirim: ' + e.message;
  }
};

window.__adminDeactivateAnnouncement = async function (id) {
  if (!confirm('Nonaktifkan pengumuman ini?')) return;
  try {
    await sb.from('announcements').update({ active: false }).eq('id', id);
    announcements = await fetchAnnouncements();
    loadAdminAnnouncements();
  } catch (e) {
    alert('Gagal menonaktifkan: ' + e.message);
  }
};

// ---------- ARTIKEL (ADMIN) ----------
let adminArticlesData = [];
let pendingArticleCoverFile = null;
let pendingArticleCoverPreview = null;
let editingArticleId = null;

async function loadAdminArticles() {
  const el = document.getElementById('admin-articles');
  const pendingEl = document.getElementById('admin-articles-pending');
  if (!el) return;
  try {
    const { data, error } = await sb.from('articles').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    adminArticlesData = data || [];

    const pending = adminArticlesData.filter(a => a.status === 'in_review');
    const rest = adminArticlesData.filter(a => a.status !== 'in_review');

    if (pendingEl) {
      pendingEl.innerHTML = pending.length === 0
        ? '<div style="color:var(--text-faint);font-size:11.5px;">Tidak ada artikel yang menunggu review.</div>'
        : pending.map(a => `
          <div class="vendor-card" style="flex-direction:column;align-items:stretch;gap:8px;border-color:var(--brand);">
            ${a.cover_image ? `<img src="${a.cover_image}" style="width:100%;border-radius:10px;" />` : ''}
            <div style="font-family:'Poppins';font-weight:700;font-size:13px;">${escapeHtml(a.title)}</div>
            ${a.excerpt ? `<div style="font-size:11.5px;color:var(--text-dim);">${escapeHtml(a.excerpt)}</div>` : ''}
            <div style="font-size:9.5px;color:var(--text-faint);">✨ ${a.source === 'ai' ? 'Ditulis AI' : 'Admin'} · ${new Date(a.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="follow-btn" onclick="window.__adminOpenArticleForm('${a.id}')">👀 Baca & Edit</button>
              <button class="follow-btn" style="color:var(--brand);font-weight:700;" onclick="window.__adminApproveArticle('${a.id}')">✅ Setujui & Terbitkan</button>
              <button class="follow-btn" style="color:#f87171;" onclick="window.__adminRejectArticle('${a.id}')">🗑️ Tolak</button>
            </div>
          </div>
        `).join('');
    }

    if (rest.length === 0) { el.innerHTML = '<div style="color:var(--text-faint);font-size:11.5px;">Belum ada artikel.</div>'; return; }
    const statusBadge = { draft: { label: 'DRAF', style: 'background:var(--surface-2);color:var(--text-faint);' }, published: { label: 'TERBIT', style: 'background:var(--brand-dim);color:var(--brand);' }, rejected: { label: 'DITOLAK', style: 'background:#f8717133;color:#f87171;' } };
    el.innerHTML = rest.map(a => {
      const badge = statusBadge[a.status] || statusBadge.draft;
      return `
      <div class="vendor-card" style="flex-direction:column;align-items:stretch;gap:8px;">
        ${a.cover_image ? `<img src="${a.cover_image}" style="width:100%;border-radius:10px;" />` : ''}
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div style="font-family:'Poppins';font-weight:700;font-size:13px;">${escapeHtml(a.title)}</div>
          <span style="flex-shrink:0;font-size:9.5px;font-weight:700;padding:3px 8px;border-radius:999px;${badge.style}">${badge.label}</span>
        </div>
        <div style="font-size:9.5px;color:var(--text-faint);">/${escapeHtml(a.slug)} · ${a.source === 'ai' ? '✨ AI' : '🧑 Admin'} · ${new Date(a.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
        <div class="admin-row" style="margin-top:2px;">
          <button class="follow-btn" style="flex-shrink:0;" onclick="window.__adminOpenArticleForm('${a.id}')">✏️ Edit</button>
          <button class="icon-btn" title="${a.status === 'published' ? 'Jadikan draf' : 'Terbitkan'}" onclick="window.__adminTogglePublishArticle('${a.id}',${a.status !== 'published'})">${a.status === 'published' ? '🙈' : '🚀'}</button>
          <button class="icon-btn danger" title="Hapus" onclick="window.__adminDeleteArticle('${a.id}','${a.title.replace(/'/g, "\\'")}')">🗑️</button>
        </div>
      </div>
    `;
    }).join('');
  } catch (e) {
    el.innerHTML = `<span style="color:#f87171;font-size:11.5px;">Gagal memuat artikel: ${e.message}</span>`;
  }
}

window.__adminApproveArticle = async function (id) {
  try {
    await sb.from('articles').update({ status: 'published', published_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', id);
    showToast('Artikel disetujui & diterbitkan! 🚀');
    loadAdminArticles();
  } catch (e) {
    alert('Gagal menyetujui: ' + e.message);
  }
};

window.__adminRejectArticle = async function (id) {
  try {
    await sb.from('articles').update({ status: 'rejected', updated_at: new Date().toISOString() }).eq('id', id);
    showToast('Artikel ditolak.');
    loadAdminArticles();
  } catch (e) {
    alert('Gagal menolak: ' + e.message);
  }
};

window.__adminOpenArticleForm = function (articleId) {
  const existing = articleId ? adminArticlesData.find(a => a.id === articleId) : null;
  editingArticleId = existing ? existing.id : null;
  pendingArticleCoverFile = null;
  pendingArticleCoverPreview = existing?.cover_image || null;

  document.getElementById('article-form-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'article-form-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:200;display:flex;align-items:flex-end;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:var(--surface);width:100%;max-width:480px;border-radius:20px 20px 0 0;padding:20px;text-align:left;max-height:88vh;overflow-y:auto;box-sizing:border-box;">
      <div style="font-family:'Poppins';font-weight:700;font-size:15px;margin-bottom:12px;">${existing ? '✏️ Edit Artikel' : '✍️ Tulis Artikel Baru'}</div>

      <label style="font-size:11px;color:var(--text-faint);">Judul</label>
      <input id="art-title" type="text" value="${existing ? escapeHtml(existing.title) : ''}" placeholder="Judul artikel..." style="width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-size:13px;margin:4px 0 10px;" />

      <label style="font-size:11px;color:var(--text-faint);">Slug (bagian dari link, otomatis dari judul — boleh diubah)</label>
      <input id="art-slug" type="text" value="${existing ? escapeHtml(existing.slug) : ''}" placeholder="slug-artikel" style="width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-size:12.5px;margin:4px 0 10px;font-family:monospace;" />

      <label style="font-size:11px;color:var(--text-faint);">Ringkasan singkat (opsional, tampil di daftar artikel)</label>
      <textarea id="art-excerpt" rows="2" placeholder="Ringkasan singkat..." style="width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-family:inherit;font-size:12.5px;resize:vertical;margin:4px 0 10px;">${existing ? escapeHtml(existing.excerpt || '') : ''}</textarea>

      <label style="font-size:11px;color:var(--text-faint);">Isi artikel</label>
      <textarea id="art-content" rows="8" placeholder="Tulis isi artikel di sini..." style="width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-family:inherit;font-size:12.5px;resize:vertical;margin:4px 0 10px;">${existing ? escapeHtml(existing.content) : ''}</textarea>

      <label style="font-size:11px;color:var(--text-faint);">Gambar sampul (opsional)</label>
      <input type="file" id="art-cover-input" accept="image/*" style="display:none" onchange="window.__onArticleCoverSelected(event)" />
      <div id="art-cover-zone" onclick="document.getElementById('art-cover-input').click()" style="margin:4px 0 10px;border:1.5px dashed var(--stroke);border-radius:12px;padding:12px;text-align:center;color:var(--text-dim);font-size:12px;cursor:pointer;">
        ${pendingArticleCoverPreview ? `<img src="${pendingArticleCoverPreview}" style="width:100%;border-radius:10px;margin-bottom:6px;" /><span style="color:var(--brand);">Ganti gambar</span>` : '📷 Tambah gambar sampul'}
      </div>

      <label style="font-size:11px;color:var(--text-faint);">Status</label>
      <select id="art-status" style="width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-size:12.5px;margin:4px 0 14px;">
        <option value="draft" ${(!existing || existing.status === 'draft') ? 'selected' : ''}>📝 Draf (belum tampil ke publik)</option>
        <option value="in_review" ${existing?.status === 'in_review' ? 'selected' : ''}>🕐 Menunggu review</option>
        <option value="published" ${existing?.status === 'published' ? 'selected' : ''}>🚀 Terbitkan sekarang</option>
      </select>

      <div id="art-error" style="color:#f87171;font-size:12px;margin-bottom:10px;"></div>

      <div style="display:flex;gap:10px;">
        <button onclick="document.getElementById('article-form-overlay').remove()" style="flex:1;padding:11px;border-radius:10px;border:1px solid var(--stroke);background:transparent;color:var(--text-dim);font-weight:600;">Batal</button>
        <button onclick="window.__adminSaveArticle()" style="flex:2;padding:11px;border-radius:10px;border:none;background:var(--brand);color:#fff;font-weight:700;">${existing ? 'Simpan Perubahan' : 'Simpan Artikel'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const titleInput = document.getElementById('art-title');
  const slugInput = document.getElementById('art-slug');
  if (!existing) {
    titleInput.addEventListener('input', () => { slugInput.value = slugifyArticle(titleInput.value); });
  }
};

window.__onArticleCoverSelected = function (event) {
  const file = event.target.files[0];
  if (!file) return;
  pendingArticleCoverFile = file;
  const reader = new FileReader();
  reader.onload = e => {
    pendingArticleCoverPreview = e.target.result;
    const zone = document.getElementById('art-cover-zone');
    if (zone) zone.innerHTML = `<img src="${pendingArticleCoverPreview}" style="width:100%;border-radius:10px;margin-bottom:6px;" /><span style="color:var(--brand);">Ganti gambar</span>`;
  };
  reader.readAsDataURL(file);
};

window.__adminSaveArticle = async function () {
  const errEl = document.getElementById('art-error');
  const title = document.getElementById('art-title').value.trim();
  const slug = slugifyArticle(document.getElementById('art-slug').value.trim() || title);
  const excerpt = document.getElementById('art-excerpt').value.trim();
  const content = document.getElementById('art-content').value.trim();
  const status = document.getElementById('art-status').value;
  const published = status === 'published';

  if (!title) { errEl.textContent = 'Judul wajib diisi.'; return; }
  if (!slug) { errEl.textContent = 'Slug wajib diisi.'; return; }
  if (!content) { errEl.textContent = 'Isi artikel wajib diisi.'; return; }

  errEl.textContent = 'Menyimpan...';
  try {
    let coverUrl = pendingArticleCoverPreview && pendingArticleCoverFile ? null : (editingArticleId ? adminArticlesData.find(a => a.id === editingArticleId)?.cover_image : null);
    if (pendingArticleCoverFile) {
      coverUrl = await uploadArticleCoverImage(pendingArticleCoverFile);
    }
    const payload = { title, slug, excerpt: excerpt || null, content, cover_image: coverUrl || null, status, updated_at: new Date().toISOString() };
    if (published) payload.published_at = new Date().toISOString();
    if (!editingArticleId) payload.source = 'admin'; // artikel baru lewat form ini selalu ditulis admin sendiri

    let error;
    if (editingArticleId) {
      ({ error } = await sb.from('articles').update(payload).eq('id', editingArticleId));
    } else {
      ({ error } = await sb.from('articles').insert(payload));
    }
    if (error) throw error;

    document.getElementById('article-form-overlay').remove();
    pendingArticleCoverFile = null; pendingArticleCoverPreview = null; editingArticleId = null;
    showToast(published ? 'Artikel diterbitkan! 📝' : 'Artikel disimpan sebagai draf.');
    loadAdminArticles();
  } catch (e) {
    errEl.textContent = 'Gagal menyimpan: ' + (e.message.includes('duplicate') ? 'Slug ini sudah dipakai artikel lain, coba slug lain.' : e.message);
  }
};

window.__adminTogglePublishArticle = async function (id, newState) {
  try {
    await sb.from('articles').update({ status: newState ? 'published' : 'draft', published_at: newState ? new Date().toISOString() : null, updated_at: new Date().toISOString() }).eq('id', id);
    showToast(newState ? 'Artikel diterbitkan! 🚀' : 'Artikel dijadikan draf.');
    loadAdminArticles();
  } catch (e) {
    alert('Gagal mengubah status: ' + e.message);
  }
};

window.__adminDeleteArticle = async function (id, title) {
  if (!confirm(`Hapus artikel "${title}"? Tindakan ini tidak bisa dibatalkan.`)) return;
  try {
    await sb.from('articles').delete().eq('id', id);
    showToast('Artikel dihapus.');
    loadAdminArticles();
  } catch (e) {
    alert('Gagal menghapus: ' + e.message);
  }
};

window.__exitAdmin = function () {
  isSuperAdmin = false;
  document.getElementById('mode-toggle-wrap').style.display = '';
  document.querySelector('nav.bottom').style.display = '';
  render_ExitToNormal();
};
function render_ExitToNormal() { mode === 'pembeli' ? renderPembeli() : renderPedagang(); }

async function loadAdminReports() {
  const el = document.getElementById('admin-reports');
  if (!el) return;
  try {
    const { data, error } = await sb.functions.invoke('admin-action', { body: { password: adminPasswordCache, action: 'list_reports' } });
    if (error) throw error;
    const reports = data.reports || [];
    if (reports.length === 0) { el.innerHTML = '<div style="color:var(--text-faint);font-size:11.5px;">Belum ada laporan masuk. 👍</div>'; return; }
    el.innerHTML = reports.map(r => `
      <div class="vendor-card" style="flex-direction:column;align-items:stretch;gap:6px;${r.status === 'baru' ? 'border-color:#f87171;' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:700;font-size:12.5px;">${r.vendors?.name || '(pedagang dihapus)'}</span>
          <span style="font-size:9.5px;padding:3px 8px;border-radius:999px;background:${r.status === 'baru' ? '#FEE2E2' : r.status === 'diproses' ? '#FEF3C7' : '#DCFCE7'};color:${r.status === 'baru' ? '#DC2626' : r.status === 'diproses' ? '#92400E' : '#16A34A'};">${r.status}</span>
        </div>
        <div style="font-size:11.5px;color:var(--brand);font-weight:600;">${r.reason}</div>
        ${r.detail ? `<div style="font-size:11px;color:var(--text-dim);">${r.detail}</div>` : ''}
        <div style="font-size:9.5px;color:var(--text-faint);">${new Date(r.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
        ${r.status !== 'selesai' ? `
          <div style="display:flex;gap:6px;margin-top:4px;">
            ${r.status === 'baru' ? `<button class="follow-btn" onclick="window.__updateReportStatus('${r.id}','diproses')">Tandai Diproses</button>` : ''}
            <button class="follow-btn" onclick="window.__updateReportStatus('${r.id}','selesai')">Tandai Selesai</button>
          </div>
        ` : ''}
      </div>
    `).join('');
  } catch (e) {
    el.innerHTML = `<span style="color:#f87171;font-size:11.5px;">Gagal memuat laporan: ${e.message}</span>`;
  }
}

window.__updateReportStatus = async function (reportId, status) {
  try {
    await sb.functions.invoke('admin-action', { body: { password: adminPasswordCache, action: 'update_report_status', report_id: reportId, status } });
    loadAdminReports();
  } catch (e) {
    alert('Gagal update status: ' + e.message);
  }
};

async function callAdminAction(action, vendorId, extra = {}) {
  const { data, error } = await sb.functions.invoke('admin-action', {
    body: { password: adminPasswordCache, action, vendor_id: vendorId, ...extra },
  });
  if (error) throw error;
  if (data && data.error) throw new Error(data.error);
  return data;
}

window.__adminResetPin = async function (id, name) {
  try {
    const result = await callAdminAction('reset_pin', id);
    alert(`PIN baru untuk "${name}": ${result.new_pin}\n\nSampaikan ke pedagangnya lewat WhatsApp.`);
    renderAdminDashboard();
  } catch (e) {
    alert('Gagal reset: ' + e.message);
  }
};

window.__adminSetPremium = async function (id, months, silent) {
  try {
    const result = await callAdminAction('set_premium_duration', id, { months });
    const untilStr = new Date(result.premium_until).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    if (!silent) { alert(`Premium diaktifkan sampai ${untilStr}.`); renderAdminDashboard(); }
  } catch (e) {
    alert('Gagal mengaktifkan Premium: ' + e.message);
    throw e;
  }
};

window.__adminCancelPremium = async function (id) {
  if (!confirm('Cabut status Premium pedagang ini?')) return;
  try {
    await callAdminAction('cancel_premium', id);
    renderAdminDashboard();
  } catch (e) {
    alert('Gagal mencabut Premium: ' + e.message);
  }
};

window.__adminSetPromo = async function (id, days, silent) {
  try {
    const result = await callAdminAction('set_promo_duration', id, { days });
    const untilStr = new Date(result.promo_until).toLocaleString('id-ID', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    if (!silent) { alert(`🔥 Promo diaktifkan sampai ${untilStr}.`); renderAdminDashboard(); }
  } catch (e) {
    alert('Gagal mengaktifkan promo: ' + e.message);
    throw e;
  }
};

window.__adminCancelPromo = async function (id) {
  if (!confirm('Cabut status Promo pedagang ini?')) return;
  try {
    await callAdminAction('cancel_promo', id);
    renderAdminDashboard();
  } catch (e) {
    alert('Gagal mencabut promo: ' + e.message);
  }
};

window.__adminRemovePhoto = async function (id) {
  try {
    await callAdminAction('remove_photo', id);
    renderAdminDashboard();
  } catch (e) {
    alert('Gagal hapus foto: ' + e.message);
  }
};

window.__adminDeleteVendor = async function (id, name) {
  if (!confirm(`Yakin hapus akun "${name}"? Ini tidak bisa dibatalkan.`)) return;
  try {
    await callAdminAction('delete_vendor', id);
    renderAdminDashboard();
  } catch (e) {
    alert('Gagal hapus: ' + e.message);
  }
};

// ---------- INIT ----------
async function init() {
  if (initError) {
    renderError('Tidak bisa membuat koneksi ke Supabase. Cek internet Anda, lalu tarik layar ke bawah untuk refresh halaman ini.');
    return;
  }
  if (!isConfigured) { renderSetupNeeded(); return; }
  try {
    vendors = (await fetchVendors()).map(normalizeExpiry);
    const followList = await fetchFollows();
    followedIds = new Set(followList);
    announcements = await fetchAnnouncements();
    subscribeRealtime();

    // Auto-follow kalau buka link/scan QR ajakan pedagang (?follow=KODE)
    const followCode = new URLSearchParams(location.search).get('follow');
    if (followCode) {
      referralCodeFromLink = followCode; // simpan di memori, dipakai lagi kalau nanti daftar jadi pedagang
      const target = vendors.find(v => v.id.toUpperCase().startsWith(followCode.toUpperCase()));
      if (target && !followedIds.has(target.id)) {
        followedIds.add(target.id);
        await toggleFollowDb(target.id, false, true);
        showToast(`Kamu sekarang mengikuti ${target.name}! 🎉`);
      }
      // Bersihkan URL supaya tidak follow ulang kalau di-refresh
      history.replaceState(null, '', location.pathname);
    }

    // Dukungan shortcut app: ?view=peta / ?view=cari / ?mode=pedagang
    const urlParams = new URLSearchParams(location.search);
    const wantMode = urlParams.get('mode');
    const wantView = urlParams.get('view');

    if (wantMode === 'pedagang') {
      mode = 'pedagang';
      btnPedagang.classList.add('active');
      btnPembeli.classList.remove('active');
      renderPedagang();
    } else if (wantView === 'peta' || wantView === 'cari') {
      bottomView = wantView;
      document.querySelectorAll('nav.bottom .nav-item').forEach(n => {
        n.classList.toggle('active', n.dataset.view === wantView);
      });
      renderPembeli();
    } else {
      renderPembeli();
    }

    if (wantMode || wantView) {
      history.replaceState(null, '', location.pathname);
    }
  } catch (e) {
    console.error(e);
    renderError('Terjadi kesalahan saat mengambil data pedagang dari server. Detail: ' + (e && e.message ? e.message : 'tidak diketahui') + '. Tarik layar ke bawah untuk mencoba lagi.');
  }
}
// ---------- TOMBOL INSTAL APLIKASI (PWA) ----------
// ---------- UPDATE LOKASI BERKALA (biar posisi di peta ikut bergerak, bukan statis) ----------
// Catatan: kegagalan di sini dulu diam-diam (cuma console.error), sekarang dicatat
// ke kolom location_error_message/location_error_at di tabel vendors, supaya admin
// bisa lihat dari panel admin siapa yang lokasinya berhenti update dan kenapa.
async function reportLocationError(vendorId, message) {
  console.error('Gagal update lokasi berkala:', message);
  try {
    await sb.from('vendors').update({
      location_error_message: message,
      location_error_at: new Date().toISOString(),
    }).eq('id', vendorId);
  } catch (e) { console.error('Gagal simpan error lokasi ke server:', e); }
}

setInterval(() => {
  if (mode !== 'pedagang' || !myVendorId) return;
  const v = vendors.find(v => v.id === myVendorId);
  if (!v || !v.active) return;
  if (myVendorPin === null) { reportLocationError(v.id, 'PIN belum terisi di sesi ini (belum ada aksi yang minta PIN sejak app dibuka)'); return; }
  if (!navigator.geolocation) { reportLocationError(v.id, 'Browser tidak mendukung geolocation'); return; }
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude, longitude } = pos.coords;
    try {
      await sb.rpc('update_vendor_location', { p_vendor_id: v.id, p_pin: myVendorPin, p_lat: latitude, p_lng: longitude });
      v.lat = latitude; v.lng = longitude;
    } catch (e) {
      reportLocationError(v.id, 'RPC update_vendor_location gagal: ' + (e && e.message ? e.message : 'tidak diketahui'));
    }
  }, (err) => {
    reportLocationError(v.id, 'Izin/GPS gagal (kode ' + (err && err.code) + '): ' + (err && err.message ? err.message : 'tidak diketahui'));
  }, { timeout: 8000 });
}, 5 * 60 * 1000); // tiap 5 menit

// ---------- PENGINGAT "MASIH JUALAN?" (tiap 1 jam, selama app tetap terbuka) ----------
setInterval(async () => {
  if (mode !== 'pedagang' || !myVendorId) return;
  const v = vendors.find(v => v.id === myVendorId);
  if (!v || !v.active) return;
  const masihJualan = confirm(`Masih jualan di sini, "${v.name}"?\n\nTekan OK kalau masih, Batal kalau sudah selesai (biar pembeli tidak salah datang).`);
  if (!masihJualan) {
    try {
      await deleteVendorPhotoByUrl(v.photo_url);
      await setVendorStatus(v.id, false);
      v.active = false; v.active_until = null; v.photo_url = null;
      renderPedagang();
      showToast('Status diubah jadi Selesai Jualan. Sampai jumpa lagi! 👋');
    } catch (e) { console.error(e); }
  }
}, 60 * 60 * 1000); // tiap 1 jam

// ---------- PENGINGAT "SAATNYA BUKA LAPAK" (cek tiap menit, sesuai jam pilihan pedagang) ----------
setInterval(() => {
  if (mode !== 'pedagang' || !myVendorId) return;
  const v = vendors.find(v => v.id === myVendorId);
  if (!v || v.active || !v.reminder_time) return;

  const now = new Date();
  const nowHHMM = now.toTimeString().slice(0, 5); // "HH:MM"
  const reminderHHMM = v.reminder_time.slice(0, 5);
  if (nowHHMM !== reminderHHMM) return;

  const todayKey = `jd_reminder_shown_${v.id}_${now.toISOString().slice(0, 10)}`;
  if (localStorage.getItem(todayKey)) return;
  localStorage.setItem(todayKey, '1');

  showToast(`🔔 Sudah jam ${reminderHHMM} — saatnya buka lapak, ${v.name}!`);
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('JajanDekat', { body: `Sudah jam ${reminderHHMM} — saatnya buka lapak, ${v.name}! 🔔`, icon: 'icons/lainnya.png' }); } catch (e) {}
  }
}, 60 * 1000); // tiap 1 menit

let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallBanner();
});

function showInstallBanner() {
  if (document.getElementById('install-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'install-banner';
  banner.style.cssText = `
    position:fixed; bottom:78px; left:50%; transform:translateX(-50%);
    max-width:440px; width:calc(100% - 32px); background:var(--brand); color:#fff;
    border-radius:14px; padding:12px 14px; display:flex; align-items:center; gap:10px;
    box-shadow:0 10px 30px -8px rgba(0,0,0,.3); z-index:90; font-family:'Inter';
  `;
  banner.innerHTML = `
    <span style="font-size:20px;">📲</span>
    <div style="flex:1;font-size:12.5px;font-weight:600;">Instal JajanDekat ke layar utama HP-mu</div>
    <button id="install-btn" style="background:#fff;color:var(--brand);border:none;border-radius:8px;padding:7px 12px;font-weight:700;font-size:11.5px;">Instal</button>
    <button id="install-dismiss" style="background:transparent;color:#fff;border:none;font-size:16px;padding:0 4px;">✕</button>
  `;
  document.body.appendChild(banner);
  document.getElementById('install-btn').onclick = async () => {
    banner.remove();
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
  };
  document.getElementById('install-dismiss').onclick = () => banner.remove();
}

init();
