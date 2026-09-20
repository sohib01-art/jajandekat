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

// Saklar fitur chat dalam app. false = disembunyikan dari tampilan (fokus ke chat WhatsApp).
// Ubah ke true untuk menghidupkannya lagi. Di server (RLS Supabase) chat tetap dibatasi khusus pedagang Premium.
const CHAT_DALAM_APP_AKTIF = false;

// ---------- WEB PUSH: minta izin & simpan langganan ----------
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

let pushAsked = false;

// Wilayah kasar pembeli (NAMA kabupaten/kecamatan/provinsi, bukan koordinat) untuk menarget notifikasi per wilayah.
// Di-cache di perangkat supaya layanan geocoding tidak dipanggil tiap app dibuka.
const BUYER_REGION_CACHE_KEY = 'jd_buyer_region';
let buyerRegionId = null;

function readBuyerRegionCache() {
  try {
    const c = JSON.parse(localStorage.getItem(BUYER_REGION_CACHE_KEY) || 'null');
    if (!c || !c.ts) return null;
    const ttl = (c.names && c.names.length) ? 6 * 3600 * 1000 : 30 * 60 * 1000; // hasil kosong dicoba lagi lebih cepat
    return (Date.now() - c.ts < ttl) ? c : null;
  } catch (e) { return null; }
}

async function getBuyerRegion() {
  const cached = readBuyerRegionCache();
  if (cached) { buyerRegionId = cached.region_id || null; return cached; }
  if (!buyerLoc) return { names: null, region_id: buyerRegionId };
  let names = null;
  let regionId = null;
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${buyerLoc.lat}&lon=${buyerLoc.lng}&zoom=12&addressdetails=1`);
    const json = await res.json();
    const a = json.address || {};
    const found = [a.city_district, a.suburb, a.municipality, a.county, a.city, a.state_district, a.state].filter(Boolean);
    if (found.length) {
      names = found;
      const { data } = await sb.rpc('resolve_region_ids', { p_names: found });
      regionId = data || null;
    }
  } catch (e) {
    console.error('Gagal deteksi wilayah pembeli:', e);
  }
  const result = { names, region_id: regionId, ts: Date.now() };
  try { localStorage.setItem(BUYER_REGION_CACHE_KEY, JSON.stringify(result)); } catch (e) {}
  buyerRegionId = regionId;
  return result;
}

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// opts.silent = true -> tidak pernah memunculkan dialog izin; hanya menyegarkan langganan
// (dan wilayahnya) kalau izin sudah diberikan sebelumnya.
async function ensurePushSubscription(opts = {}) {
  const silent = !!opts.silent;
  if (!silent) {
    if (pushAsked) return;
    pushAsked = true;
  }
  if (!pushSupported()) return;
  try {
    if (silent && Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      if (silent) return;
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    const json = sub.toJSON();
    const region = await getBuyerRegion();
    const { error } = await sb.rpc('upsert_push_subscription', {
      p_device_id: deviceId,
      p_endpoint: json.endpoint,
      p_p256dh: json.keys.p256dh,
      p_auth: json.keys.auth,
      p_region_names: region && region.names ? region.names : null,
    });
    if (error) throw error;
  } catch (e) {
    console.error('Gagal langganan push:', e);
  }
}

// Ajakan aktifkan notifikasi (tanpa harus follow dulu). Muncul di beranda pembeli selama izin belum diputuskan.
function renderPushPromptBanner() {
  if (!pushSupported() || Notification.permission !== 'default') return '';
  const until = Number(localStorage.getItem('jd_push_prompt_until') || 0);
  if (Date.now() < until) return '';
  return `
    <div class="vendor-hero" style="text-align:left;margin-bottom:10px;">
      <div style="display:flex;gap:8px;align-items:flex-start;">
        <span style="font-size:18px;">🔔</span>
        <div style="flex:1;">
          <div style="font-size:12.5px;line-height:1.5;">Aktifkan notifikasi supaya tahu saat pedagang favoritmu mulai jualan, plus promo &amp; info dari JajanDekat.</div>
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button class="follow-btn" style="background:var(--brand);color:#fff;" onclick="window.__enablePush()">Aktifkan</button>
            <button class="follow-btn" onclick="window.__dismissPushPrompt()">Nanti saja</button>
          </div>
        </div>
      </div>
    </div>`;
}

window.__enablePush = async function () {
  try {
    const perm = await Notification.requestPermission(); // dipanggil langsung dari ketukan pengguna
    if (perm === 'granted') {
      pushAsked = false;
      await ensurePushSubscription();
      showToast('Notifikasi aktif 🔔');
    }
  } catch (e) {
    console.error('Gagal mengaktifkan notifikasi:', e);
  }
  refreshBell();
  if (mode === 'pembeli') renderPembeli();
};

window.__dismissPushPrompt = function () {
  localStorage.setItem('jd_push_prompt_until', String(Date.now() + 7 * 24 * 3600 * 1000));
  if (mode === 'pembeli') renderPembeli();
};

let vendors = [];
let followedIds = new Set();
let mode = 'pembeli';
let activeCat = 'semua';
let map = null;
let markers = {};
let mapDidInitialFit = false;

const main = document.getElementById('main');
const btnPembeli = document.getElementById('btn-pembeli');
const btnPedagang = document.getElementById('btn-pedagang');

// Pasang tombol menu PALING AWAL, sebelum kode lain yang mungkin gagal —
// supaya menu tetap bisa diklik walau ada masalah koneksi/data.
btnPembeli.onclick = () => {
  mode = 'pembeli';
  btnPembeli.classList.add('active'); btnPedagang.classList.remove('active');
  refreshMyChatThreads(); // ganti mode -> daftar thread yang "punya kita" ikut ganti
  renderPembeli();
};
btnPedagang.onclick = () => {
  mode = 'pedagang';
  btnPedagang.classList.add('active'); btnPembeli.classList.remove('active');
  refreshMyChatThreads();
  renderPedagang();
};

// Pasang tombol nav bawah (Beranda / Peta / Cari / Favorit / Akun) — hanya berlaku di mode Pembeli.
// Kunci internal Beranda tetap 'status' (dipakai banyak tempat). Sub-tampilan tanpa tombol sendiri
// ikut menyalakan tombol induknya: 'artikel' -> Akun, 'terdekat' -> Beranda.
let bottomView = 'status';
function setNavActive(view) {
  const navView = view === 'artikel' ? 'akun' : (view === 'terdekat' ? 'status' : view);
  document.querySelectorAll('nav.bottom .nav-item').forEach(n => {
    const on = n.dataset.view === navView;
    n.classList.toggle('active', on);
    if (on) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current');
  });
}
document.querySelectorAll('nav.bottom .nav-item').forEach(el => {
  el.onclick = () => {
    bottomView = el.dataset.view;
    setNavActive(bottomView);
    // Nav bawah selalu membawa ke mode Pembeli
    if (mode !== 'pembeli') {
      mode = 'pembeli';
      btnPembeli.classList.add('active'); btnPedagang.classList.remove('active');
    }
    renderPembeli();
  };
});

// ---------- LONCENG NOTIFIKASI DI HEADER ----------
// Lonceng membuka Kotak Notifikasi (daftar pengumuman). Titik merah = ada pengumuman yang belum dibaca.
// Izin push diatur dari dalam Kotak Notifikasi dan dari tab Akun.
const bellBtn = document.getElementById('btn-bell');
function refreshBell() {
  if (!bellBtn) return;
  bellBtn.hidden = false;
  let n = 0;
  try { n = notifUnreadCount(); } catch (e) { /* data belum siap saat script baru dimuat */ }
  bellBtn.classList.toggle('needs-attention', n > 0);
  bellBtn.setAttribute('aria-label', n > 0 ? `Notifikasi, ${n} belum dibaca` : 'Notifikasi');
}
// Dipakai lonceng di header dan baris Notifikasi di tab Akun
window.__notifTap = async function () {
  if (!pushSupported()) return;
  if (Notification.permission === 'granted') {
    showToast('Notifikasi sudah aktif 🔔');
  } else if (Notification.permission === 'denied') {
    showToast('Notifikasi diblokir. Aktifkan lewat pengaturan situs di browser.');
  } else {
    await window.__enablePush();
  }
  refreshBell();
};
if (bellBtn) {
  bellBtn.onclick = () => window.__openNotifInbox();
  refreshBell();
}

function showToast(text) {
  const t = document.getElementById('toast');
  document.getElementById('toast-text').textContent = text;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3200);
}

// ---------- PANDUAN PENGGUNAAN (popup, muncul otomatis di kunjungan pertama) ----------
let guideActiveTab = mode;

// Aksi navigasi nyata dari langkah panduan — tiap step yang punya "action" bisa ditekan
// dan langsung membawa pengguna ke menu terkait, bukan cuma teks.
function goToBottomView(view) {
  bottomView = view;
  setNavActive(view);
  if (mode !== 'pembeli') {
    mode = 'pembeli';
    btnPembeli.classList.add('active'); btnPedagang.classList.remove('active');
  }
  renderPembeli();
}

function goToPedagangDashboard() {
  mode = 'pedagang';
  btnPedagang.classList.add('active'); btnPembeli.classList.remove('active');
  renderPedagang();
}

const GUIDE_STEPS = {
  pembeli: {
    title: '👤 Panduan untuk Pembeli',
    steps: [
      { icon: '🗺️', text: 'Buka <b>Peta</b> untuk melihat pedagang keliling yang sedang jualan di sekitarmu, lengkap dengan jaraknya.', action: () => goToBottomView('peta') },
      { icon: '🔍', text: 'Pakai <b>Cari</b> untuk menemukan pedagang tertentu berdasarkan nama atau kategori jualan.', action: () => goToBottomView('cari') },
      { icon: '⭐', text: 'Di <b>Beranda</b>, ketuk ♥ pada kartu pedagang untuk mengikuti — kamu akan tahu kapan mereka mulai jualan lagi. Semua pedagang yang kamu ikuti ada di tab <b>Favorit</b>.', action: () => goToBottomView('favorit') },
      { icon: '💬', text: 'Ketuk kartu pedagang di <b>Beranda</b> untuk melihat detailnya, lalu hubungi pedagang langsung lewat WhatsApp.', action: () => goToBottomView('status') },
      { icon: '🍽️', text: 'Di detail pedagang, tekan <b>Lihat menu</b> untuk melihat menu/produk yang mereka jual, sebelum datang.', action: () => goToBottomView('status') },
      { icon: '📰', text: 'Buka tab <b>Akun</b> lalu pilih <b>Artikel</b> untuk tips, rekomendasi kuliner, dan info seputar JajanDekat.', action: () => goToBottomView('akun') },
    ],
  },
  pedagang: {
    title: '🛒 Panduan untuk Pedagang',
    steps: [
      { icon: '📝', text: 'Daftar sebagai pedagang atau masuk ke akun lama lewat menu <b>Pedagang</b>.', action: () => goToPedagangDashboard() },
      { icon: '🟢', text: 'Tekan <b>"Saya Jualan"</b> dan aktifkan GPS supaya lokasimu otomatis muncul di peta pembeli.', action: () => goToPedagangDashboard() },
      { icon: '✏️', text: 'Ubah nama toko, mode jualan, kategori, atau nomor WhatsApp lewat <b>Edit Profil Toko</b>.', action: () => { if (myVendorId) { goToPedagangDashboard(); window.__openEditProfile(myVendorId); } else { goToPedagangDashboard(); } } },
      { icon: '📦', text: 'Tambahkan menu/dagangan lewat <b>Kelola Produk</b> supaya pembeli bisa lihat sebelum datang.', action: () => { if (myVendorId) { goToPedagangDashboard(); window.__openProductManager(myVendorId); } else { goToPedagangDashboard(); } } },
      { icon: '✅', text: 'Ajukan <b>Verifikasi Toko</b> (unggah foto KTP) supaya tokomu tampil dengan badge terpercaya.', action: () => goToPedagangDashboard() },
      { icon: '⭐', text: 'Aktifkan <b>Premium</b> dari dashboard pedagang untuk tampil lebih menonjol.', action: () => goToPedagangDashboard() },
      { icon: '🔥', text: 'Pasang <b>Promosi Lokal</b> harian untuk menyorot kartu tokomu ke posisi atas.', action: () => goToPedagangDashboard() },
      { icon: '🔗', text: 'Bagikan <b>QR/link referral</b> di bagian atas dashboard untuk mengajak pembeli & pedagang baru.', action: () => goToPedagangDashboard() },
      { icon: '❓', text: 'Ada pertanyaan lain? Cek <b>Bantuan & FAQ</b>.', action: () => window.__openFaqModal() },
    ],
  },
};

function guideStepsHtml(tabKey) {
  return GUIDE_STEPS[tabKey].steps.map((s, i) => `
    <div onclick="window.__runGuideStepAction('${tabKey}',${i})" style="display:flex;gap:10px;align-items:flex-start;margin-bottom:14px;${s.action ? 'cursor:pointer;' : ''}">
      <div style="font-size:18px;flex-shrink:0;">${s.icon}</div>
      <div style="flex:1;font-size:12.5px;line-height:1.55;color:var(--text-dim);">${s.text}</div>
      ${s.action ? '<div style="flex-shrink:0;color:var(--brand);font-size:13px;margin-top:1px;">→</div>' : ''}
    </div>
  `).join('');
}

window.__runGuideStepAction = function (tabKey, stepIndex) {
  const step = GUIDE_STEPS[tabKey]?.steps?.[stepIndex];
  if (!step || !step.action) return;
  document.getElementById('guide-modal-overlay')?.remove();
  step.action();
};

window.__switchGuideTab = function (tabKey) {
  guideActiveTab = tabKey;
  const modal = document.getElementById('guide-modal-overlay');
  if (!modal) return;
  modal.querySelector('#guide-title').textContent = GUIDE_STEPS[tabKey].title;
  modal.querySelector('#guide-steps').innerHTML = guideStepsHtml(tabKey);
  modal.querySelectorAll('.guide-tab-btn').forEach(btn => {
    const active = btn.dataset.tab === tabKey;
    btn.style.background = active ? 'var(--brand)' : 'transparent';
    btn.style.color = active ? '#fff' : 'var(--text-dim)';
  });
};

window.__openGuideModal = function (preferredTab) {
  document.getElementById('guide-modal-overlay')?.remove();
  guideActiveTab = preferredTab || mode || 'pembeli';
  const overlay = document.createElement('div');
  overlay.id = 'guide-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:250;display:flex;align-items:flex-end;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:var(--surface);width:100%;max-width:480px;border-radius:20px 20px 0 0;padding:20px;max-height:80vh;overflow-y:auto;box-sizing:border-box;">
      <div style="display:flex;gap:8px;margin-bottom:16px;">
        <button class="guide-tab-btn" data-tab="pembeli" onclick="window.__switchGuideTab('pembeli')" style="flex:1;padding:9px;border-radius:10px;border:1px solid var(--stroke);font-weight:700;font-size:12.5px;cursor:pointer;">👤 Pembeli</button>
        <button class="guide-tab-btn" data-tab="pedagang" onclick="window.__switchGuideTab('pedagang')" style="flex:1;padding:9px;border-radius:10px;border:1px solid var(--stroke);font-weight:700;font-size:12.5px;cursor:pointer;">🛒 Pedagang</button>
      </div>
      <div id="guide-title" style="font-family:'Poppins';font-weight:700;font-size:15px;margin-bottom:14px;"></div>
      <div id="guide-steps"></div>
      <button onclick="document.getElementById('guide-modal-overlay').remove()" style="width:100%;margin-top:6px;padding:12px;border-radius:10px;border:none;background:var(--brand);color:#fff;font-weight:700;font-size:13px;">Mengerti, tutup</button>
    </div>
  `;
  document.body.appendChild(overlay);
  window.__switchGuideTab(guideActiveTab);
};

// Dulu ada tombol ❓ mengambang di kiri-bawah, tapi posisinya numpuk di atas kartu
// "Pilihan JajanDekat" pas discroll (nutupin nama/rating pedagang). Panduan tetap bisa
// dibuka lewat tab Akun ("❓ Bantuan & FAQ") atau sheet detail pedagang, jadi tombol
// mengambangnya dihapus saja — cukup tampil otomatis sekali di kunjungan pertama.
function maybeShowGuideOnFirstVisit() {
  if (localStorage.getItem('jd_guide_seen')) return;
  localStorage.setItem('jd_guide_seen', '1');
  window.__openGuideModal(mode);
}

// ---------- FAQ PEDAGANG (dari tabel `faq`, diisi via admin) ----------
let faqOpenId = null;

window.__openFaqModal = async function () {
  document.getElementById('faq-modal-overlay')?.remove();
  faqOpenId = null;
  const overlay = document.createElement('div');
  overlay.id = 'faq-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:250;display:flex;align-items:flex-end;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:var(--surface);width:100%;max-width:480px;border-radius:20px 20px 0 0;padding:20px;max-height:80vh;overflow-y:auto;box-sizing:border-box;">
      <div style="font-family:'Poppins';font-weight:700;font-size:15px;margin-bottom:14px;">❓ Bantuan & FAQ</div>
      <div id="faq-list">${'<div style="color:var(--text-faint);font-size:12.5px;">Memuat FAQ...</div>'}</div>
      <button onclick="document.getElementById('faq-modal-overlay').remove()" style="width:100%;margin-top:14px;padding:12px;border-radius:10px;border:none;background:var(--brand);color:#fff;font-weight:700;font-size:13px;">Tutup</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const el = document.getElementById('faq-list');
  try {
    const { data, error } = await sb.from('faq').select('id,question,answer,category').eq('active', true).order('sort_order', { ascending: true });
    if (error) throw error;
    if (!el) return; // modal sudah ditutup sebelum data selesai dimuat
    if (!data || data.length === 0) {
      el.innerHTML = '<div style="color:var(--text-faint);font-size:12.5px;">Belum ada FAQ tersedia.</div>';
      return;
    }
    el.innerHTML = data.map(f => `
      <div style="border:1px solid var(--stroke);border-radius:12px;margin-bottom:8px;overflow:hidden;">
        <button onclick="window.__toggleFaqItem('${f.id}')" style="width:100%;text-align:left;padding:12px;background:var(--bg);border:none;color:var(--text);font-weight:600;font-size:12.5px;display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:pointer;">
          <span>${escapeHtml(f.question)}</span>
          <span id="faq-caret-${f.id}" style="flex-shrink:0;color:var(--text-faint);">▾</span>
        </button>
        <div id="faq-answer-${f.id}" style="display:none;padding:0 12px 12px;font-size:12px;color:var(--text-dim);line-height:1.55;">${escapeHtml(f.answer)}</div>
      </div>
    `).join('');
  } catch (e) {
    if (el) el.innerHTML = `<div style="color:#f87171;font-size:12.5px;">Gagal memuat FAQ: ${e.message}</div>`;
  }
};

window.__toggleFaqItem = function (id) {
  const answerEl = document.getElementById(`faq-answer-${id}`);
  const caretEl = document.getElementById(`faq-caret-${id}`);
  if (!answerEl) return;
  const isOpen = faqOpenId === id;
  // Tutup jawaban yang sedang terbuka sebelumnya (satu jawaban terbuka dalam satu waktu)
  if (faqOpenId && faqOpenId !== id) {
    const prevAnswer = document.getElementById(`faq-answer-${faqOpenId}`);
    const prevCaret = document.getElementById(`faq-caret-${faqOpenId}`);
    if (prevAnswer) prevAnswer.style.display = 'none';
    if (prevCaret) prevCaret.textContent = '▾';
  }
  answerEl.style.display = isOpen ? 'none' : 'block';
  if (caretEl) caretEl.textContent = isOpen ? '▾' : '▴';
  faqOpenId = isOpen ? null : id;
};

// ---------- KATALOG PRODUK (PUBLIK, dilihat pembeli) ----------
window.__openProductCatalog = async function (vendorId, vendorName) {
  document.getElementById('product-catalog-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'product-catalog-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:230;display:flex;align-items:flex-end;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:var(--surface);width:100%;max-width:480px;border-radius:20px 20px 0 0;padding:20px;max-height:80vh;overflow-y:auto;box-sizing:border-box;">
      <div style="font-family:'Poppins';font-weight:700;font-size:15px;margin-bottom:14px;">🍽️ Menu ${escapeHtml(vendorName)}</div>
      <div id="product-catalog-list"><div style="color:var(--text-faint);font-size:12.5px;">Memuat menu...</div></div>
      <button onclick="document.getElementById('product-catalog-overlay').remove()" style="width:100%;margin-top:14px;padding:12px;border-radius:10px;border:none;background:var(--brand);color:#fff;font-weight:700;font-size:13px;">Tutup</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const el = document.getElementById('product-catalog-list');
  try {
    const { data, error } = await sb.from('products').select('id,name,price,description,photo_url').eq('vendor_id', vendorId).eq('active', true).order('sort_order', { ascending: true });
    if (error) throw error;
    if (!el) return;
    if (!data || data.length === 0) {
      el.innerHTML = '<div style="color:var(--text-faint);font-size:12.5px;">Pedagang ini belum menambahkan menu.</div>';
      return;
    }
    el.innerHTML = data.map(p => `
      <div style="display:flex;gap:10px;border:1px solid var(--stroke);border-radius:12px;padding:10px;margin-bottom:8px;align-items:center;">
        ${p.photo_url ? `<img src="${p.photo_url}" style="width:54px;height:54px;border-radius:10px;object-fit:cover;flex-shrink:0;" />` : `<div style="width:54px;height:54px;border-radius:10px;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;">🍽️</div>`}
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:12.5px;">${escapeHtml(p.name)}</div>
          ${p.price != null ? `<div style="font-size:12px;color:var(--brand);font-weight:700;margin-top:2px;">Rp${Number(p.price).toLocaleString('id-ID')}</div>` : ''}
          ${p.description ? `<div style="font-size:11px;color:var(--text-faint);margin-top:2px;">${escapeHtml(p.description)}</div>` : ''}
        </div>
      </div>
    `).join('');
  } catch (e) {
    if (el) el.innerHTML = `<div style="color:#f87171;font-size:12.5px;">Gagal memuat menu: ${e.message}</div>`;
  }
};

// ---------- KELOLA PRODUK (PEDAGANG) ----------
let myProductsData = [];
let pendingProductPhotoFile = null;
let pendingProductPhotoPreview = null;
let editingProductId = null;

window.__openProductManager = async function (vendorId) {
  document.getElementById('product-manager-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'product-manager-overlay';
  overlay.dataset.vendorId = vendorId;
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:230;display:flex;align-items:flex-end;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:var(--surface);width:100%;max-width:480px;border-radius:20px 20px 0 0;padding:20px;max-height:82vh;overflow-y:auto;box-sizing:border-box;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <div style="font-family:'Poppins';font-weight:700;font-size:15px;">📦 Kelola Produk</div>
        <button onclick="window.__openProductForm(null)" style="padding:8px 12px;border-radius:10px;border:none;background:var(--brand);color:#fff;font-weight:700;font-size:12px;">+ Tambah</button>
      </div>
      <div id="product-manager-list"><div style="color:var(--text-faint);font-size:12.5px;">Memuat produk...</div></div>
      <button onclick="document.getElementById('product-manager-overlay').remove()" style="width:100%;margin-top:14px;padding:12px;border-radius:10px;border:1px solid var(--stroke);background:transparent;color:var(--text-dim);font-weight:600;font-size:13px;">Tutup</button>
    </div>
  `;
  document.body.appendChild(overlay);
  await loadMyProducts(vendorId);
};

async function loadMyProducts(vendorId) {
  const el = document.getElementById('product-manager-list');
  if (!el) return;
  try {
    const { data, error } = await sb.from('products').select('*').eq('vendor_id', vendorId).order('sort_order', { ascending: true });
    if (error) throw error;
    myProductsData = data || [];
    if (!el) return;
    if (myProductsData.length === 0) {
      el.innerHTML = '<div style="color:var(--text-faint);font-size:12.5px;">Belum ada produk. Tekan "+ Tambah" untuk mulai.</div>';
      return;
    }
    el.innerHTML = myProductsData.map(p => `
      <div style="display:flex;gap:10px;border:1px solid var(--stroke);border-radius:12px;padding:10px;margin-bottom:8px;align-items:center;${!p.active ? 'opacity:.5;' : ''}">
        ${p.photo_url ? `<img src="${p.photo_url}" style="width:50px;height:50px;border-radius:10px;object-fit:cover;flex-shrink:0;" />` : `<div style="width:50px;height:50px;border-radius:10px;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;">🍽️</div>`}
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:12.5px;">${escapeHtml(p.name)}${!p.active ? ' <span style="color:var(--text-faint);font-weight:400;">(nonaktif)</span>' : ''}</div>
          ${p.price != null ? `<div style="font-size:11.5px;color:var(--brand);font-weight:700;">Rp${Number(p.price).toLocaleString('id-ID')}</div>` : ''}
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;">
          <button class="icon-btn" title="Edit" onclick="window.__openProductForm('${p.id}')">✏️</button>
          <button class="icon-btn" title="${p.active ? 'Sembunyikan' : 'Tampilkan'}" onclick="window.__toggleProductActive('${p.id}',${!p.active})">${p.active ? '🙈' : '👁️'}</button>
          <button class="icon-btn danger" title="Hapus" onclick="window.__deleteProduct('${p.id}','${p.name.replace(/'/g, "\\'")}')">🗑️</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    if (el) el.innerHTML = `<div style="color:#f87171;font-size:12.5px;">Gagal memuat produk: ${e.message}</div>`;
  }
}

window.__openProductForm = function (productId) {
  const vendorId = document.getElementById('product-manager-overlay')?.dataset.vendorId;
  const existing = productId ? myProductsData.find(p => p.id === productId) : null;
  editingProductId = existing ? existing.id : null;
  pendingProductPhotoFile = null;
  pendingProductPhotoPreview = existing?.photo_url || null;

  document.getElementById('product-form-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'product-form-overlay';
  overlay.dataset.vendorId = vendorId;
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:240;display:flex;align-items:flex-end;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:var(--surface);width:100%;max-width:480px;border-radius:20px 20px 0 0;padding:20px;max-height:88vh;overflow-y:auto;box-sizing:border-box;">
      <div style="font-family:'Poppins';font-weight:700;font-size:15px;margin-bottom:12px;">${existing ? '✏️ Edit Produk' : '➕ Tambah Produk'}</div>

      <label style="font-size:11px;color:var(--text-faint);">Nama produk</label>
      <input id="prod-name" type="text" value="${existing ? escapeHtml(existing.name) : ''}" placeholder="Misal: Bakso Urat Jumbo" style="width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-size:13px;margin:4px 0 10px;" />

      <label style="font-size:11px;color:var(--text-faint);">Harga (Rp, opsional)</label>
      <input id="prod-price" type="number" inputmode="numeric" value="${existing && existing.price != null ? existing.price : ''}" placeholder="Misal: 15000" style="width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-size:13px;margin:4px 0 10px;" />

      <label style="font-size:11px;color:var(--text-faint);">Deskripsi (opsional)</label>
      <textarea id="prod-desc" rows="2" placeholder="Deskripsi singkat..." style="width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-family:inherit;font-size:12.5px;resize:vertical;margin:4px 0 10px;">${existing ? escapeHtml(existing.description || '') : ''}</textarea>

      <label style="font-size:11px;color:var(--text-faint);">Foto produk (opsional)</label>
      <input type="file" id="prod-photo-input" accept="image/*" style="display:none" onchange="window.__onProductPhotoSelected(event)" />
      <div id="prod-photo-zone" onclick="document.getElementById('prod-photo-input').click()" style="margin:4px 0 10px;border:1.5px dashed var(--stroke);border-radius:12px;padding:12px;text-align:center;color:var(--text-dim);font-size:12px;cursor:pointer;">
        ${pendingProductPhotoPreview ? `<img src="${pendingProductPhotoPreview}" style="width:100%;max-width:160px;border-radius:10px;margin-bottom:6px;" /><span style="color:var(--brand);">Ganti foto</span>` : '📷 Tambah foto produk'}
      </div>

      <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;margin-bottom:14px;cursor:pointer;">
        <input id="prod-active" type="checkbox" ${!existing || existing.active ? 'checked' : ''} style="width:17px;height:17px;" />
        Tampilkan ke pembeli
      </label>

      <div id="prod-error" style="color:#f87171;font-size:12px;margin-bottom:10px;"></div>

      <div style="display:flex;gap:10px;">
        <button onclick="document.getElementById('product-form-overlay').remove()" style="flex:1;padding:11px;border-radius:10px;border:1px solid var(--stroke);background:transparent;color:var(--text-dim);font-weight:600;">Batal</button>
        <button onclick="window.__saveProduct()" style="flex:2;padding:11px;border-radius:10px;border:none;background:var(--brand);color:#fff;font-weight:700;">${existing ? 'Simpan Perubahan' : 'Simpan Produk'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
};

window.__onProductPhotoSelected = function (event) {
  const file = event.target.files[0];
  if (!file) return;
  pendingProductPhotoFile = file;
  const reader = new FileReader();
  reader.onload = e => {
    pendingProductPhotoPreview = e.target.result;
    const zone = document.getElementById('prod-photo-zone');
    if (zone) zone.innerHTML = `<img src="${pendingProductPhotoPreview}" style="width:100%;max-width:160px;border-radius:10px;margin-bottom:6px;" /><span style="color:var(--brand);">Ganti foto</span>`;
  };
  reader.readAsDataURL(file);
};

window.__saveProduct = async function () {
  const errEl = document.getElementById('prod-error');
  const vendorId = document.getElementById('product-form-overlay')?.dataset.vendorId;
  const name = document.getElementById('prod-name').value.trim();
  const priceRaw = document.getElementById('prod-price').value.trim();
  const description = document.getElementById('prod-desc').value.trim();
  const active = document.getElementById('prod-active').checked;

  if (!name) { errEl.textContent = 'Nama produk wajib diisi.'; return; }
  if (!vendorId) { errEl.textContent = 'Sesi toko tidak ditemukan, coba buka ulang.'; return; }

  errEl.textContent = 'Menyimpan...';
  try {
    let photoUrl = pendingProductPhotoPreview && pendingProductPhotoFile ? null : (editingProductId ? myProductsData.find(p => p.id === editingProductId)?.photo_url : null);
    if (pendingProductPhotoFile) {
      photoUrl = await uploadProductImage(vendorId, pendingProductPhotoFile);
    }
    const payload = {
      vendor_id: vendorId, name, price: priceRaw ? Number(priceRaw) : null,
      description: description || null, photo_url: photoUrl || null, active,
      updated_at: new Date().toISOString(),
    };

    let error;
    if (editingProductId) {
      ({ error } = await sb.from('products').update(payload).eq('id', editingProductId));
    } else {
      ({ error } = await sb.from('products').insert(payload));
    }
    if (error) throw error;

    document.getElementById('product-form-overlay').remove();
    pendingProductPhotoFile = null; pendingProductPhotoPreview = null; editingProductId = null;
    showToast('Produk berhasil disimpan! 📦');
    await loadMyProducts(vendorId);
  } catch (e) {
    errEl.textContent = 'Gagal menyimpan: ' + e.message;
  }
};

window.__toggleProductActive = async function (id, newState) {
  const vendorId = document.getElementById('product-manager-overlay')?.dataset.vendorId;
  try {
    await sb.from('products').update({ active: newState, updated_at: new Date().toISOString() }).eq('id', id);
    if (vendorId) await loadMyProducts(vendorId);
  } catch (e) {
    alert('Gagal mengubah status: ' + e.message);
  }
};

window.__deleteProduct = async function (id, name) {
  if (!confirm(`Hapus produk "${name}"? Tindakan ini tidak bisa dibatalkan.`)) return;
  const vendorId = document.getElementById('product-manager-overlay')?.dataset.vendorId;
  try {
    await sb.from('products').delete().eq('id', id);
    showToast('Produk dihapus.');
    if (vendorId) await loadMyProducts(vendorId);
  } catch (e) {
    alert('Gagal menghapus: ' + e.message);
  }
};

// ---------- VERIFIKASI TOKO (upload KTP, ditinjau admin) ----------
window.__openVerificationForm = async function (vendorId) {
  document.getElementById('verify-form-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'verify-form-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:230;display:flex;align-items:flex-end;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:var(--surface);width:100%;max-width:480px;border-radius:20px 20px 0 0;padding:20px;max-height:85vh;overflow-y:auto;box-sizing:border-box;">
      <div style="font-family:'Poppins';font-weight:700;font-size:15px;margin-bottom:6px;">✅ Ajukan Verifikasi Toko</div>
      <div style="font-size:11.5px;color:var(--text-faint);margin-bottom:14px;">Verifikasi ditinjau manual oleh admin, biasanya selesai 1-2 hari kerja setelah diajukan.</div>

      <label style="font-size:11px;color:var(--text-faint);">Nama usaha resmi (opsional, kalau beda dari nama toko)</label>
      <input id="verify-business-name" type="text" placeholder="Nama usaha resmi..." style="width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-size:13px;margin:4px 0 10px;" />

      <label style="font-size:11px;color:var(--text-faint);">Nomor NIB (opsional)</label>
      <input id="verify-nib" type="text" placeholder="Nomor Induk Berusaha..." style="width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-size:13px;margin:4px 0 10px;" />

      <label style="font-size:11px;color:var(--text-faint);">Foto KTP (wajib)</label>
      <input type="file" id="verify-ktp-input" accept="image/*" capture="environment" style="display:none" onchange="window.__onKtpPhotoSelected(event)" />
      <div id="verify-ktp-zone" onclick="document.getElementById('verify-ktp-input').click()" style="margin:4px 0 10px;border:1.5px dashed var(--stroke);border-radius:12px;padding:12px;text-align:center;color:var(--text-dim);font-size:12px;cursor:pointer;">
        📷 Ambil/unggah foto KTP
      </div>
      <div style="font-size:10px;color:var(--text-faint);margin:-6px 0 10px;">Foto KTP hanya dilihat admin untuk verifikasi, tidak ditampilkan ke publik.</div>

      <div id="verify-error" style="color:#f87171;font-size:12px;margin-bottom:10px;"></div>

      <div style="display:flex;gap:10px;">
        <button onclick="document.getElementById('verify-form-overlay').remove()" style="flex:1;padding:11px;border-radius:10px;border:1px solid var(--stroke);background:transparent;color:var(--text-dim);font-weight:600;">Batal</button>
        <button onclick="window.__submitVerification('${vendorId}')" style="flex:2;padding:11px;border-radius:10px;border:none;background:var(--brand);color:#fff;font-weight:700;">Ajukan Verifikasi</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
};

let pendingKtpFile = null;

window.__onKtpPhotoSelected = function (event) {
  const file = event.target.files[0];
  if (!file) return;
  pendingKtpFile = file;
  const zone = document.getElementById('verify-ktp-zone');
  if (zone) zone.innerHTML = `<span style="color:var(--brand);">✅ Foto KTP terpilih — tap untuk ganti</span>`;
};

window.__submitVerification = async function (vendorId) {
  const errEl = document.getElementById('verify-error');
  const businessName = document.getElementById('verify-business-name').value.trim();
  const nib = document.getElementById('verify-nib').value.trim();

  if (!pendingKtpFile) { errEl.textContent = 'Foto KTP wajib diunggah.'; return; }

  if (myVendorPin === null) {
    const enteredPin = prompt('Masukkan PIN akun Anda untuk konfirmasi:');
    if (enteredPin === null) return;
    const { data: ok } = await sb.rpc('verify_vendor_pin', { p_vendor_id: vendorId, p_pin: enteredPin.trim() });
    if (!ok) { errEl.textContent = 'PIN salah.'; return; }
    myVendorPin = enteredPin.trim();
  }

  errEl.textContent = 'Mengunggah & mengirim pengajuan...';
  try {
    const ktpUrl = await uploadKtpImage(vendorId, pendingKtpFile);
    const { error } = await sb.rpc('submit_vendor_verification', {
      p_vendor_id: vendorId, p_pin: myVendorPin || '',
      p_business_name: businessName, p_business_nib: nib, p_ktp_photo_url: ktpUrl,
    });
    if (error) throw error;

    const v = vendors.find(v => v.id === vendorId);
    if (v) v.verification_status = 'pending';
    document.getElementById('verify-form-overlay').remove();
    pendingKtpFile = null;
    showToast('Pengajuan verifikasi terkirim! ✅');
    renderPedagang();
  } catch (e) {
    errEl.textContent = 'Gagal mengirim: ' + e.message;
  }
};

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
  const { data, error } = await withTimeout(sb.from('vendors').select('id,name,category,categories,custom_tags,emoji,mode_icon,whatsapp,show_whatsapp,active,active_until,lat,lng,photo_url,is_premium,premium_until,promo_until,promo_text,promo_text_pending,promo_text_note,reminder_time,created_at,region,region_id,rating_avg,rating_count,verification_status,fixed_lat,fixed_lng,schedule_text,location_note,default_open,jam_buka,jam_tutup,buka_24jam,hari_buka,tutup_libur_nasional').order('name'), 10000, 'Ambil data pedagang');
  if (error) { console.error(error); throw error; }
  return data;
}

async function fetchFollows() {
  const { data, error } = await withTimeout(sb.rpc('jd_get_my_follows', { p_device_id: deviceId }), 10000, 'Ambil data pengikut');
  if (error) { console.error(error); throw error; }
  return data.map(f => f.vendor_id);
}

async function toggleFollowDb(vendorId, isFollowing, viaReferral = false) {
  if (isFollowing) {
    await sb.rpc('jd_unfollow_vendor', { p_device_id: deviceId, p_vendor_id: vendorId });
  } else {
    await sb.rpc('jd_follow_vendor', { p_device_id: deviceId, p_vendor_id: vendorId, p_via_referral: viaReferral });
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
  // Nama file tetap (bukan pakai timestamp) + upsert:true supaya tiap kali pedagang
  // ganti foto, file lama di Supabase Storage langsung ketimpa (bukan menumpuk file baru).
  // Jadi tiap pedagang cuma makan storage untuk 1 foto, seberapa pun sering mereka ganti.
  const path = `${vendorId}/foto.jpg`;
  const { error } = await sb.storage.from('vendor-photos').upload(path, blob, {
    contentType: 'image/jpeg', upsert: true
  });
  if (error) throw error;
  const { data } = sb.storage.from('vendor-photos').getPublicUrl(path);
  // ?t= di belakang URL cuma buat mematahkan cache browser/CDN (nama filenya sama persis),
  // supaya foto baru langsung kelihatan, bukan foto lama yang ke-cache.
  return `${data.publicUrl}?t=${Date.now()}`;
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

async function uploadProductImage(vendorId, file) {
  const blob = await compressImage(file, 800, 0.75, true);
  const path = `products/${vendorId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const { error } = await sb.storage.from('vendor-photos').upload(path, blob, {
    contentType: 'image/jpeg', upsert: true
  });
  if (error) throw error;
  const { data } = sb.storage.from('vendor-photos').getPublicUrl(path);
  return data.publicUrl;
}

async function uploadKtpImage(vendorId, file) {
  // KTP tidak perlu dicrop persegi & kualitas cukup ringan — cukup jelas terbaca admin.
  // PENTING: KTP adalah dokumen identitas, jadi harus masuk bucket privat 'vendor-verifications',
  // BUKAN 'vendor-photos' yang publik. getPublicUrl() di sini sengaja tetap dipakai supaya format
  // string URL yang disimpan konsisten dengan kolom ktp_photo_url yang sudah ada; URL ini tidak
  // bisa diakses langsung dari luar (bucket privat, tanpa policy SELECT publik) — untuk melihat
  // isinya, admin perlu buka lewat Supabase Studio (pakai service role) atau signed URL.
  const blob = await compressImage(file, 1200, 0.75, false);
  const path = `${vendorId}/${Date.now()}-ktp.jpg`;
  const { error } = await sb.storage.from('vendor-verifications').upload(path, blob, {
    contentType: 'image/jpeg', upsert: true
  });
  if (error) throw error;
  const { data } = sb.storage.from('vendor-verifications').getPublicUrl(path);
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
    // Foto asli terakhir dibiarkan (tidak di-null-kan) supaya jadi default berikutnya.
    v.active = false; v.active_until = null;
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

// Ikon "Semua" di baris kategori (mengikuti warna teks tile: putih di tile oranye, oranye di tile aktif)
const CAT_ALL_ICON_SVG = '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="2.2"/><rect x="13" y="3" width="8" height="8" rx="2.2"/><rect x="3" y="13" width="8" height="8" rx="2.2"/><rect x="13" y="13" width="8" height="8" rx="2.2"/></svg>';

function renderPembeli() {
  refreshBell();
  if (bottomView === 'peta') return renderPetaView();
  if (bottomView === 'cari') return renderCariView();
  if (bottomView === 'favorit') return renderFavoritView();
  if (bottomView === 'akun') return renderAkunView();
  if (bottomView === 'terdekat') return renderTerdekatView();
  if (bottomView === 'artikel') return artikelDetailSlug ? renderArtikelDetailView(artikelDetailSlug) : renderArtikelListView();

  const followed = vendors.filter(v => followedIds.has(v.id));

  // Ketuk story = buka detail pedagang (dulu: berhenti mengikuti tanpa sengaja). Berhenti mengikuti lewat ♥ di kartu atau tombol Mengikuti di sheet.
  const storyHtml = followed.map(v => `
    <button class="story ${v.active ? 'on' : ''}" onclick="window.__openVendorSheet('${v.id}')">
      <div class="story-avatar">
        <div class="story-ring" style="${vendorIconStyle(v)}">${vendorIconInner(v)}</div>
        ${v.active ? '<span class="story-dot"></span>' : ''}
      </div>
      <div class="story-name">${escapeHtml(v.name)}</div>
      <div class="story-sub">${escapeHtml((v.categories || [])[0] || '')}</div>
    </button>
  `).join('');

  const catList = ['semua', ...Array.from(new Set(vendors.flatMap(v => v.categories || []))).sort()];
  const catRowHtml = catList.map(c => `
    <button class="cat-chip ${activeCat === c ? 'active' : ''}" onclick="window.__setCat('${c.replace(/'/g, "\\'")}')">
      <div class="cat-circle">${c === 'semua' ? CAT_ALL_ICON_SVG : categoryIconImgTag(c, CATEGORY_OPTIONS.find(x => x.label === c)?.icon || c, '')}</div>
      <div class="cat-label">${c === 'semua' ? 'Semua' : c}</div>
    </button>
  `).join('');
  const filteredVendors = activeCat === 'semua' ? vendors : vendors.filter(v => (v.categories || []).includes(activeCat));

  main.innerHTML = `
    ${renderPushPromptBanner()}
    <div class="sec-head"><h2>Kategori</h2></div>
    <div class="cat-row">${catRowHtml}</div>
    ${renderBannerSlider(getRelevantBannersForBuyer())}
    ${renderPromoTodayHtml(filteredVendors)}
    <div class="sec-head"><h2>Pedagang yang kamu ikuti</h2>${followed.length ? '<button onclick="window.__goView(\'favorit\')">Lihat semua ›</button>' : ''}</div>
    <div class="stories">${storyHtml || '<div style="color:var(--text-faint);font-size:12px;padding:8px 0;">Belum ada yang diikuti.</div>'}</div>
    <div class="sec-head"><h2><svg class="sec-star" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.400 6.100 20.500l1.200-6.500L2.500 9.400l6.600-.9L12 2.500Z" fill="#FFB400"/></svg>Pilihan JajanDekat</h2></div>
    ${renderVendorCarouselHtml(filteredVendors)}
    ${renderNearbyHtml(filteredVendors)}
    <div class="sec-head"><h2>Semua pedagang</h2></div>
    ${renderVendorGridHtml(filteredVendors)}
  `;
  initAnnSlider();
}

// Chat dalam app KHUSUS pedagang Premium yang masih aktif.
// Aturan yang sama juga dipaksa di server (RLS Supabase: jd_vendor_premium_aktif), jadi ini hanya untuk tampilan.
function vendorChatEnabled(v) {
  if (!CHAT_DALAM_APP_AKTIF) return false;
  return !!(v && v.is_premium && (!v.premium_until || new Date(v.premium_until) > new Date()));
}

// Link WhatsApp pedagang (kosong kalau nomor tidak ada atau disembunyikan pedagang).
function vendorWaUrl(v) {
  if (!v || v.show_whatsapp === false || !v.whatsapp) return '';
  return `https://wa.me/${v.whatsapp}?text=${encodeURIComponent(`Halo ${v.name}, saya lihat lapak Anda di JajanDekat. Saya mau tanya-tanya, apakah masih jualan?`)}`;
}

function isPromoActive(v) {
  return v.promo_until && new Date(v.promo_until) > new Date();
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Konversi markdown sederhana (##, **, *, list, paragraf) ke HTML aman (escape dulu, baru format)
function renderMarkdownSafe(raw) {
  const escaped = escapeHtml(raw || '');
  const lines = escaped.split(/\r?\n/);
  const htmlParts = [];
  let listBuffer = [];
  const flushList = () => {
    if (listBuffer.length) { htmlParts.push(`<ul style="margin:6px 0 12px;padding-left:20px;">${listBuffer.join('')}</ul>`); listBuffer = []; }
  };
  const inlineFormat = (text) => text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { flushList(); continue; }
    const h3 = trimmed.match(/^###\s+(.*)/);
    const h2 = trimmed.match(/^##\s+(.*)/);
    const h1 = trimmed.match(/^#\s+(.*)/);
    const li = trimmed.match(/^[-*]\s+(.*)/);
    if (h3) { flushList(); htmlParts.push(`<h4 style="font-family:'Poppins';font-weight:700;font-size:14.5px;margin:14px 0 6px;">${inlineFormat(h3[1])}</h4>`); }
    else if (h2) { flushList(); htmlParts.push(`<h3 style="font-family:'Poppins';font-weight:700;font-size:15.5px;margin:16px 0 6px;">${inlineFormat(h2[1])}</h3>`); }
    else if (h1) { flushList(); htmlParts.push(`<h2 style="font-family:'Poppins';font-weight:800;font-size:17px;margin:16px 0 8px;">${inlineFormat(h1[1])}</h2>`); }
    else if (li) { listBuffer.push(`<li style="margin-bottom:4px;">${inlineFormat(li[1])}</li>`); }
    else { flushList(); htmlParts.push(`<p style="margin:0 0 12px;">${inlineFormat(trimmed)}</p>`); }
  }
  flushList();
  return htmlParts.join('');
}

// ---------- ARTIKEL (PUBLIK) ----------
async function renderArtikelListView() {
  main.innerHTML = `<div class="section-label">📰 Artikel</div>
    <a href="https://whatsapp.com/channel/0029Vb8okwd4inorfK4UCQ3Z" target="_blank" style="display:flex;align-items:center;gap:10px;background:#25D366;color:#fff;border-radius:14px;padding:12px 14px;margin-bottom:14px;text-decoration:none;box-shadow:var(--shadow);">
      <span style="font-size:22px;flex-shrink:0;">📢</span>
      <div style="flex:1;">
        <div style="font-family:'Poppins';font-weight:700;font-size:12.5px;">Ikuti Channel WhatsApp JajanDekat</div>
        <div style="font-size:11px;opacity:.9;">Info promo, tips, & update terbaru langsung di WhatsApp-mu</div>
      </div>
      <span style="font-size:16px;flex-shrink:0;">›</span>
    </a>
    <div class="vendor-list" id="artikel-list"><div style="color:var(--text-faint);font-size:12.5px;">Memuat artikel...</div></div>`;
  const el = document.getElementById('artikel-list');
  try {
    const { data, error } = await sb.from('articles').select('id,title,slug,excerpt,cover_image,created_at').eq('status', 'published').order('created_at', { ascending: false });
    if (error) throw error;
    if (!data || data.length === 0) { el.innerHTML = '<div style="color:var(--text-faint);font-size:12.5px;padding:12px 0;">Belum ada artikel.</div>'; return; }
    el.innerHTML = data.map(a => `
      <div class="vendor-card" style="flex-direction:column;align-items:stretch;gap:8px;cursor:pointer;" onclick="window.__openArtikel('${a.slug}')">
        ${a.cover_image ? `<img src="${a.cover_image}" style="width:100%;border-radius:10px;" />` : ''}
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
    const { data, error } = await sb.from('articles').select('*').eq('slug', slug).eq('status', 'published').single();
    if (error || !data) throw error || new Error('Artikel tidak ditemukan.');
    main.innerHTML = `
      <button class="follow-btn" style="margin-bottom:12px;" onclick="window.__backFromArtikel()">← Kembali ke Artikel</button>
      ${data.cover_image ? `<img src="${data.cover_image}" style="width:100%;border-radius:12px;margin-bottom:12px;" />` : ''}
      <div style="font-family:'Poppins';font-weight:800;font-size:18px;margin-bottom:6px;">${escapeHtml(data.title)}</div>
      <div style="font-size:10.5px;color:var(--text-faint);margin-bottom:14px;">${new Date(data.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
      <div style="font-size:13.5px;line-height:1.7;">${renderMarkdownSafe(data.content)}</div>
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

// ---------- WILAYAH (tabel regions: provinsi → kabupaten/kota → kecamatan) ----------
let regionsById = new Map();
async function fetchRegions() {
  try {
    const { data, error } = await sb.from('regions').select('id,name,level,parent_id');
    if (error) throw error;
    regionsById = new Map((data || []).map(r => [r.id, r]));
  } catch (e) {
    console.error('Gagal ambil daftar wilayah:', e);
  }
}

function regionChain(regionId) { // wilayah itu + semua induknya sampai provinsi
  const chain = [];
  let cur = regionId ? regionsById.get(regionId) : null;
  let guard = 0;
  while (cur && guard++ < 6) {
    chain.push(cur);
    cur = cur.parent_id ? regionsById.get(cur.parent_id) : null;
  }
  return chain;
}
function regionIsWithin(regionId, rootId) {
  return regionChain(regionId).some(r => r.id === rootId);
}

// Pengumuman zona hanya cocok kalau wilayah perangkat DIKETAHUI dan berada di dalam zona itu (sama dengan aturan pengiriman push di server).
function announcementMatchesRegion(a, regionId, fallbackText) {
  if (!a.zone_level || a.zone_level === 'nasional') return true;
  if (a.region_id) return !!regionId && regionIsWithin(regionId, a.region_id);
  if (!a.zone_value) return true;
  // Pengumuman lama (belum punya region_id): cocokkan nama zona dengan SEMUA tingkat wilayah, bukan hanya kabupaten
  const zv = String(a.zone_value).toLowerCase();
  const names = regionChain(regionId).map(r => r.name.toLowerCase());
  if (fallbackText) names.push(String(fallbackText).toLowerCase());
  return names.some(n => n.includes(zv));
}

function regionOptionsHtml(rootLabel, selectedId = '') {
  const all = [...regionsById.values()];
  const kids = (pid) => all.filter(r => (r.parent_id || null) === pid).sort((a, b) => a.name.localeCompare(b.name, 'id'));
  const walk = (pid, depth) => kids(pid).map(r =>
    `<option value="${r.id}" ${r.id === selectedId ? 'selected' : ''}>${'— '.repeat(depth)}${escapeHtml(r.name)}</option>` + walk(r.id, depth + 1)
  ).join('');
  return `<option value="">${rootLabel}</option>` + walk(null, 0);
}

function getRelevantAnnouncementsForVendor(v) {
  const audienceType = v.is_premium ? 'premium' : 'biasa';
  return announcements.filter(a => {
    if (a.audience !== 'semua' && a.audience !== audienceType) return false;
    return announcementMatchesRegion(a, v.region_id, v.region);
  });
}

function getRelevantAnnouncementsForBuyer() {
  return announcements.filter(a =>
    (a.audience === 'semua' || a.audience === 'pembeli') && announcementMatchesRegion(a, buyerRegionId, null)
  );
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
          ${a.link && /^\?(vendor|artikel)=[A-Za-z0-9_%.-]+$/.test(a.link) ? `<button class="follow-btn" style="margin-top:6px;" onclick="window.__openInternalLink('${a.link}')">Selengkapnya →</button>` : ''}
        </div>
      </div>
    </div>
  `).join('');
}

// ---------- KOTAK NOTIFIKASI (lonceng di header) ----------
// Pengumuman tidak lagi jadi kartu di beranda: tampil di sini, plus push kalau admin mencentangnya.
function currentNotifList() {
  if (mode === 'pedagang' && myVendorId) {
    const v = vendors.find(x => x.id === myVendorId);
    if (v) return getRelevantAnnouncementsForVendor(v);
  }
  return getRelevantAnnouncementsForBuyer();
}
function notifSeenAt() { return parseInt(localStorage.getItem('jd_notif_seen_at') || '0', 10) || 0; }
function notifUnreadCount() {
  const seen = notifSeenAt();
  return currentNotifList().filter(a => new Date(a.created_at).getTime() > seen).length;
}
function notifRelTime(iso) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'baru saja';
  if (m < 60) return `${m} menit lalu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam lalu`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} hari lalu`;
  return new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

function notifInboxHtml(list, seen) {
  const perm = pushSupported() ? Notification.permission : null;
  const permHtml = perm === 'default'
    ? `<div class="nb-perm"><div>🔔 Aktifkan notifikasi supaya pengumuman baru langsung sampai ke HP-mu.</div><button class="near-btn" onclick="window.__nbEnablePush()">Aktifkan</button></div>`
    : perm === 'denied'
      ? `<div class="nb-perm nb-perm-off">Notifikasi diblokir di browser. Aktifkan lewat pengaturan situs kalau ingin menerima pengumuman langsung.</div>`
      : '';
  const items = list.length ? list.map(a => `
    <div class="nb-item ${new Date(a.created_at).getTime() > seen ? 'unread' : ''}">
      <div class="nb-time">${notifRelTime(a.created_at)}</div>
      ${a.image_url ? `<img class="nb-img" src="${escapeHtml(a.image_url)}" alt="" loading="lazy" />` : ''}
      <div class="nb-msg">${escapeHtml(a.message)}</div>
      ${a.link && /^https?:\/\//.test(a.link) ? `<a class="nb-link" href="${escapeHtml(a.link)}" target="_blank" rel="noopener">Selengkapnya →</a>` : ''}
      ${a.link && /^\?(vendor|artikel)=[A-Za-z0-9_%.-]+$/.test(a.link) ? `<button class="follow-btn" style="margin-top:6px;" onclick="window.__nbOpenLink('${a.link}')">Selengkapnya →</button>` : ''}
    </div>`).join('') : '<div class="nb-empty">Belum ada pengumuman.</div>';
  return permHtml + items;
}

window.__closeNotifInbox = function () { document.getElementById('nb-overlay')?.remove(); };
window.__nbOpenLink = function (link) { window.__closeNotifInbox(); window.__openInternalLink(link); };
window.__nbEnablePush = async function () {
  await window.__enablePush();
  refreshBell();
  if (document.getElementById('nb-overlay')) window.__openNotifInbox();
};

window.__openNotifInbox = async function () {
  document.getElementById('nb-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'nb-overlay';
  overlay.className = 'nb-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) window.__closeNotifInbox(); };
  document.body.appendChild(overlay);

  const seenSnapshot = notifSeenAt(); // yang baru saat dibuka tetap ditandai di daftar, walau sudah dianggap terbaca
  const draw = () => {
    overlay.innerHTML = `
      <div class="nb-sheet" role="dialog" aria-label="Kotak Notifikasi">
        <div class="nb-head"><h2>Notifikasi</h2><button class="nb-close" aria-label="Tutup" onclick="window.__closeNotifInbox()">✕</button></div>
        <div class="nb-body">${notifInboxHtml(currentNotifList(), seenSnapshot)}</div>
      </div>`;
  };
  const markSeen = () => {
    const newest = Math.max(0, ...currentNotifList().map(a => new Date(a.created_at).getTime()));
    if (newest > notifSeenAt()) localStorage.setItem('jd_notif_seen_at', String(newest));
    refreshBell();
  };
  draw(); markSeen();
  try { // ambil yang terbaru dari server, jangan menimpa kalau gagal
    const fresh = await fetchAnnouncements();
    if (fresh.length && document.getElementById('nb-overlay')) { announcements = fresh; draw(); markSeen(); }
  } catch (e) {}
};

window.__dismissAnnouncement = function (id) {
  const dismissed = JSON.parse(localStorage.getItem('jd_dismissed_ann') || '[]');
  dismissed.push(id);
  localStorage.setItem('jd_dismissed_ann', JSON.stringify(dismissed));
  if (mode === 'pedagang') renderPedagang(); else renderPembeli();
};

// ---------- SLIDER BANNER BERANDA ----------
// Sumber data: tabel `banners` (dikelola dari Dashboard Admin lewat Edge Function admin-banners).
// RLS di server sudah menyaring banner aktif & dalam jadwal tayang (start_at/end_at); urutan mengikuti sort_order.
// Maks. ANN_SLIDER_MAX slide, rasio 8:3, geser manual + auto-slide. Pengumuman (tabel `announcements`) tetap kartu teks seperti biasa.
const ANN_SLIDER_MAX = 4;
const ANN_SLIDER_INTERVAL_MS = 5500;
let banners = [];
let bannersFetchedAt = 0;
let annSliderIdx = 0;
let annSliderTimer = null;
let annSliderPausedUntil = 0;
const bannerViewed = new Set(); // tayangan dihitung sekali per banner per sesi/perangkat

// null = gagal ambil (jangan timpa daftar yang sudah ada)
async function fetchBanners() {
  try {
    const { data, error } = await sb.from('banners')
      .select('id,title,image_url,link,audience,zone_level,zone_value,region_id,sort_order,start_at,end_at,created_at')
      .order('sort_order', { ascending: true }).order('created_at', { ascending: true });
    if (error) { console.error('Gagal ambil banner:', error); return null; }
    return data || [];
  } catch (e) { console.error('Gagal ambil banner:', e); return null; }
}

function bannerIsLive(b) {
  const now = Date.now();
  return (!b.start_at || new Date(b.start_at).getTime() <= now) && (!b.end_at || new Date(b.end_at).getTime() > now);
}
function getRelevantBannersForBuyer() {
  return banners.filter(b => (b.audience === 'semua' || b.audience === 'pembeli') && bannerIsLive(b) && announcementMatchesRegion(b, buyerRegionId, null));
}
function getRelevantBannersForVendor(v) {
  return banners.filter(b => (b.audience === 'semua' || b.audience === 'pedagang') && bannerIsLive(b) && announcementMatchesRegion(b, v.region_id, v.region));
}

function trackBanner(id, kind) {
  try {
    if (kind === 'view') { if (bannerViewed.has(id)) return; bannerViewed.add(id); }
    const r = sb.rpc('track_banner', { p_id: id, p_kind: kind });
    if (r && r.then) r.then(() => {}, () => {});
  } catch (e) {}
}

function renderBannerSlider(list) {
  const slides = list.slice(0, ANN_SLIDER_MAX);
  if (!slides.length) return '';
  const slideHtml = slides.map((b, i) => `
    <button type="button" class="ann-slide" data-banner-id="${escapeHtml(String(b.id))}" onclick="window.__bannerTap('${b.id}')"
      aria-label="${escapeHtml((b.title || 'Banner').slice(0, 120))}" ${b.link ? '' : 'style="cursor:default"'}>
      <img src="${escapeHtml(b.image_url)}" alt="" ${i === 0 ? '' : 'loading="lazy"'} decoding="async" draggable="false" />
    </button>`).join('');
  const dotsHtml = slides.length > 1
    ? `<div class="ann-dots">${slides.map((_, i) => `<button type="button" class="ann-dot ${i === 0 ? 'on' : ''}" aria-label="Slide ${i + 1}" onclick="window.__annSlideGo(${i})"></button>`).join('')}</div>`
    : '';
  return `<div class="ann-slider" id="ann-slider"><div class="ann-track" id="ann-track">${slideHtml}</div>${dotsHtml}</div>`;
}

window.__bannerTap = function (id) {
  const b = banners.find(x => String(x.id) === String(id));
  if (!b) return;
  trackBanner(b.id, 'click');
  if (!b.link) return;
  if (/^https:\/\//i.test(b.link)) window.open(b.link, '_blank', 'noopener');
  else openInternalLink(b.link);
};

function annSliderGoTo(i, smooth = true) {
  const track = document.getElementById('ann-track');
  if (!track) return;
  const slides = track.querySelectorAll('.ann-slide');
  if (!slides.length) return;
  annSliderIdx = ((i % slides.length) + slides.length) % slides.length;
  track.scrollTo({ left: slides[annSliderIdx].offsetLeft, behavior: smooth ? 'smooth' : 'auto' });
  annSliderSyncDots();
}

function annSliderSyncDots() {
  document.querySelectorAll('#ann-slider .ann-dot').forEach((d, i) => d.classList.toggle('on', i === annSliderIdx));
  const slide = document.querySelectorAll('#ann-track .ann-slide')[annSliderIdx];
  if (slide && slide.dataset.bannerId && !document.hidden) trackBanner(slide.dataset.bannerId, 'view');
}

window.__annSlideGo = function (i) {
  annSliderPausedUntil = Date.now() + ANN_SLIDER_INTERVAL_MS * 2; // setelah disentuh, jeda dulu
  annSliderGoTo(i);
};

function initAnnSlider() {
  if (annSliderTimer) { clearInterval(annSliderTimer); annSliderTimer = null; }
  const track = document.getElementById('ann-track');
  if (!track) return;
  const slides = track.querySelectorAll('.ann-slide');
  if (annSliderIdx >= slides.length) annSliderIdx = 0;
  annSliderGoTo(annSliderIdx, false); // render ulang (realtime) tidak melempar pengguna balik ke slide 1
  if (slides.length < 2) return;

  // Sinkronkan titik saat digeser manual
  let scrollRaf = null;
  track.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null;
      let best = 0, bestDist = Infinity;
      slides.forEach((sl, i) => {
        const d = Math.abs(sl.offsetLeft - track.scrollLeft);
        if (d < bestDist) { bestDist = d; best = i; }
      });
      if (best !== annSliderIdx) { annSliderIdx = best; annSliderSyncDots(); }
    });
  }, { passive: true });

  // Jeda saat disentuh / kursor di atas slider
  const pause = () => { annSliderPausedUntil = Date.now() + ANN_SLIDER_INTERVAL_MS * 2; };
  track.addEventListener('touchstart', pause, { passive: true });
  track.addEventListener('pointerdown', pause, { passive: true });
  track.addEventListener('mouseenter', pause);

  // Auto-slide: dimatikan kalau pengguna memilih "kurangi gerakan"
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  annSliderTimer = setInterval(() => {
    if (!document.getElementById('ann-track')) { clearInterval(annSliderTimer); annSliderTimer = null; return; }
    if (document.hidden || Date.now() < annSliderPausedUntil) return;
    annSliderGoTo(annSliderIdx + 1);
  }, ANN_SLIDER_INTERVAL_MS);
}

// Segarkan daftar banner berkala (banner baru / sudah berakhir / diubah urutannya) tanpa mengganggu halaman lain
async function refreshBanners(force = false) {
  if (!sb || (!force && Date.now() - bannersFetchedAt < 3 * 60 * 1000)) return;
  bannersFetchedAt = Date.now();
  const fresh = await fetchBanners();
  if (fresh === null) return;
  const sig = (l) => l.map(b => [b.id, b.image_url, b.sort_order, b.link, b.audience, b.region_id, b.start_at, b.end_at].join('|')).join(',');
  if (sig(fresh) === sig(banners)) return;
  banners = fresh;
  if (document.querySelector('.admin-panel')) return; // Dashboard Admin sedang terbuka: jangan ganti layarnya
  if (mode === 'pembeli' && !['peta', 'cari', 'favorit', 'akun', 'terdekat', 'artikel'].includes(bottomView)) renderPembeli();
}
function scheduleBannerRefresh() {
  setInterval(() => refreshBanners(), 10 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBanners(); });
}

// ---------- CHAT DALAM APP (pedagang <-> pembeli, gratis lewat Supabase Realtime) ----------
const QUICK_REPLIES_BUYER = ['Masih jualan? 🙋', 'Ready berapa banyak?', 'Ongkir ke sini berapa?', 'Boleh COD?', 'Lokasi tepatnya di mana?'];
const QUICK_REPLIES_VENDOR = ['Iya masih, silakan 🙏', 'Otw ke lokasi', 'Sebentar ya, masih disiapin', 'Stok habis, besok lagi ya', 'Boleh, langsung datang aja'];

let currentChatThreadId = null;
let currentChatChannel = null;
let currentChatIsVendor = false;
let chatPollTimer = null;
let chatSeenMessageIds = new Set();

// ---------- NOTIFIKASI CHAT GLOBAL (bukan cuma pas modal chat lagi kebuka) ----------
// Sebelumnya bunyi/toast pesan baru CUMA jalan selagi modal chat thread itu terbuka —
// jadi kalau lagi di Beranda/Peta/tab lain, pesan baru nggak kerasa sama sekali.
// Ini nyimpen daftar thread_id milik kita sendiri (sebagai pembeli/perangkat ini, atau
// sebagai pedagang yang lagi login), lalu dengar INSERT baru di seluruh tabel chat_messages
// dan cocokkan sendiri di sisi klien (server sudah membolehkan baca bebas per thread yang
// sama seperti dipakai polling chat yang sudah ada, jadi tidak menambah celah baru).
let myThreadIds = new Set();
let myThreadVendorName = {};
let globalChatChannel = null;
let globalChatPollTimer = null;
let lastGlobalChatCheckAt = null;
let globalChatNotifiedIds = new Set();

async function refreshMyChatThreads() {
  if (!CHAT_DALAM_APP_AKTIF) return;
  try {
    if (mode === 'pedagang' && myVendorId) {
      const { data } = await sb.from('chat_threads').select('id').eq('vendor_id', myVendorId);
      myThreadIds = new Set((data || []).map(t => t.id));
    } else {
      const { data } = await sb.from('chat_threads').select('id,vendor_id').eq('buyer_device_id', deviceId);
      myThreadIds = new Set((data || []).map(t => t.id));
      (data || []).forEach(t => {
        const v = vendors.find(x => x.id === t.vendor_id);
        if (v) myThreadVendorName[t.id] = v.name;
      });
    }
  } catch (e) { console.error('Gagal ambil daftar thread chat sendiri:', e); }
}

function handleGlobalIncomingChat(m) {
  if (!myThreadIds.has(m.thread_id)) return; // bukan thread kita, abaikan
  if (globalChatNotifiedIds.has(m.id)) return; // sudah pernah diproses (realtime & polling bisa dobel)
  globalChatNotifiedIds.add(m.id);
  if (currentChatThreadId === m.thread_id) return; // sudah ditangani listener modal yang lagi kebuka
  const asVendor = mode === 'pedagang';
  const fromOther = (asVendor && m.sender === 'buyer') || (!asVendor && m.sender === 'vendor');
  if (!fromOther) return;
  playChatDing();
  const label = asVendor ? 'Ada pesan baru dari pembeli' : `Pesan baru dari ${myThreadVendorName[m.thread_id] || 'pedagang'}`;
  showToast(`💬 ${label}`);
  // Kalau tab lagi tidak aktif/di-minimize dan izin notifikasi browser sudah ada,
  // tampilkan juga sebagai notifikasi sistem (mirip pengingat "saatnya buka lapak").
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { new Notification('JajanDekat', { body: label + (m.message ? ': ' + m.message.slice(0, 60) : ''), icon: 'icons/lainnya.png' }); } catch (e) {}
  }
}

function startGlobalChatWatch() {
  if (!CHAT_DALAM_APP_AKTIF) return; // chat disembunyikan: tidak perlu Realtime & polling
  if (globalChatChannel) { sb.removeChannel(globalChatChannel); globalChatChannel = null; }
  if (globalChatPollTimer) { clearInterval(globalChatPollTimer); globalChatPollTimer = null; }
  lastGlobalChatCheckAt = new Date().toISOString(); // jangan bunyi buat pesan LAMA yang sudah ada
  refreshMyChatThreads();
  globalChatChannel = sb.channel('global_chat_watch')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, (payload) => {
      handleGlobalIncomingChat(payload.new);
    })
    .subscribe();

  // Cadangan kalau Realtime tidak sampai ke kunci anon (RLS Supabase kadang memblokir jalur
  // postgres_changes untuk anon tanpa sesi auth asli — persis seperti dicatat di modal chat
  // per-thread yang sudah pakai fallback serupa). Tanpa ini, kalaupun logika di atas benar,
  // notifnya bisa TIDAK PERNAH bunyi sama sekali karena event realtime-nya sendiri tidak sampai.
  globalChatPollTimer = setInterval(async () => {
    // Refresh daftar thread di TIAP siklus (bukan cuma pas ganti mode/login) — supaya
    // otomatis pulih sendiri kalau sempat ke-refresh lebih dulu daripada link_owner_device
    // kelar (race condition login pedagang), dan langsung nangkep thread baru dari
    // pembeli lain yang belum pernah chat sebelumnya.
    await refreshMyChatThreads();
    if (!myThreadIds.size) return;
    try {
      const { data, error } = await sb.from('chat_messages').select('*')
        .in('thread_id', Array.from(myThreadIds))
        .gt('created_at', lastGlobalChatCheckAt)
        .order('created_at', { ascending: true });
      if (error || !data || !data.length) return;
      data.forEach(m => { lastGlobalChatCheckAt = m.created_at; handleGlobalIncomingChat(m); });
    } catch (e) { /* koneksi sempat gagal, coba lagi siklus berikutnya */ }
  }, 8000);
}

// Browser modern nge-block AudioContext berbunyi kalau belum pernah ada interaksi user
// SAMA SEKALI (autoplay policy) — konteksnya nyangkut "suspended" terus. Ini "membangunkan"-nya
// sekali di sentuhan/klik pertama pengguna di mana pun dalam app, supaya nanti pas notifikasi
// chat masuk sendiri (dipicu dari timer/network, bukan dari tap pengguna), suaranya sudah siap.
let chatAudioUnlocked = false;
function unlockChatAudioOnce() {
  if (chatAudioUnlocked) return;
  chatAudioUnlocked = true;
  try {
    chatAudioCtx = chatAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (chatAudioCtx.state === 'suspended') chatAudioCtx.resume();
  } catch (e) {}
  document.removeEventListener('pointerdown', unlockChatAudioOnce);
  document.removeEventListener('touchstart', unlockChatAudioOnce);
}
document.addEventListener('pointerdown', unlockChatAudioOnce, { once: true });
document.addEventListener('touchstart', unlockChatAudioOnce, { once: true });

// Bunyi notifikasi chat — dibuat langsung dari kode (bukan file audio), jadi tetap
// single-file dan tidak perlu hosting aset tambahan.
let chatAudioCtx = null;
function playChatDing() {
  try {
    chatAudioCtx = chatAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = chatAudioCtx;
    if (ctx.state === 'suspended') ctx.resume(); // jaga-jaga kalau browser nyuspend lagi di tengah jalan
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
  if (existing) { myThreadIds.add(existing.id); return existing.id; }
  const { data, error } = await sb.from('chat_threads').insert({ vendor_id: vendorId, buyer_device_id: buyerDeviceId }).select('id').single();
  if (error) throw error;
  myThreadIds.add(data.id);
  return data.id;
}

window.__openChatModal = async function (vendorId, vendorName) {
  if (!CHAT_DALAM_APP_AKTIF) { showToast('Chat dalam app belum tersedia. Hubungi pedagang lewat WhatsApp ya.'); return; }
  const vObj = vendors.find(x => x.id === vendorId);
  if (vObj && !vendorChatEnabled(vObj)) { showToast('Chat dalam app khusus untuk pedagang Premium.'); return; }
  try {
    const threadId = await getOrCreateChatThread(vendorId, deviceId);
    openChatUI(threadId, { asVendor: false, title: vendorName, quickReplies: QUICK_REPLIES_BUYER });
  } catch (e) {
    const rls = /row-level security/i.test(e.message || '');
    alert(rls ? 'Chat dalam app khusus untuk pedagang Premium.' : 'Gagal membuka chat: ' + e.message);
  }
};

window.__openVendorChatThread = function (threadId, buyerLabel) {
  if (!CHAT_DALAM_APP_AKTIF) return;
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
    sendChatPushNotification(threadId, sender, text); // best-effort: sampai ke HP lawan bicara walau app-nya lagi ditutup
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

function sortVendorsForDisplay(list) {
  return [...list].sort((a, b) => {
    // Aktif jualan selalu di atas; di antara yang aktif, premium/promo diprioritaskan.
    if (!!vendorIsShowable(b) !== !!vendorIsShowable(a)) return (vendorIsShowable(b) ? 1 : 0) - (vendorIsShowable(a) ? 1 : 0);
    const scoreA = (a.is_premium ? 2 : 0) + (isPromoActive(a) ? 1 : 0);
    const scoreB = (b.is_premium ? 2 : 0) + (isPromoActive(b) ? 1 : 0);
    return scoreB - scoreA;
  });
}

// ---------- LOKASI EFEKTIF PEDAGANG (live GPS vs lokasi mangkal tetap) ----------
// Sebelumnya "kelihatan di peta/daftar" = HARUS v.active (toggle "mulai jualan" nyala +
// GPS live). Sekarang toko yang sudah simpan lokasi mangkal tetap (fixed_lat/fixed_lng)
// tetap kelihatan walau lagi tidak live, SELAMA belum ditutup sendiri (default_open
// false). Semua tempat yang dulu ngecek "v.active && v.lat && v.lng" ganti pakai ini,
// biar satu sumber kebenaran.
function vendorDisplayLatLng(v) {
  if (v.active && v.lat && v.lng) return { lat: v.lat, lng: v.lng, live: true };
  if (v.default_open !== false && v.fixed_lat && v.fixed_lng) return { lat: v.fixed_lat, lng: v.fixed_lng, live: false };
  return null;
}
function vendorIsShowable(v) {
  return !!vendorDisplayLatLng(v);
}

// ---------- HARI BUKA & TANGGAL MERAH ----------
// hari_buka: array angka 0=Minggu .. 6=Sabtu (NULL/kosong/7 hari penuh = buka setiap hari).
// tutup_libur_nasional: true = toko tutup di tanggal merah (libur nasional, cuti bersama TIDAK dihitung).
const HARI_SINGKAT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const HARI_PANJANG = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const HARI_URUTAN = [1, 2, 3, 4, 5, 6, 0]; // tampilan mulai dari Senin
let liburNasionalMap = {}; // { 'YYYY-MM-DD': 'Nama hari libur' }, diisi dari tabel libur_nasional

function normalizeHariBuka(days) {
  if (!Array.isArray(days)) return null;
  const set = [...new Set(days.map(Number).filter(d => d >= 0 && d <= 6))].sort((a, b) => a - b);
  return set.length && set.length < 7 ? set : null; // null = setiap hari
}
function formatHariBuka(days) {
  const set = normalizeHariBuka(days);
  if (!set) return null;
  const order = HARI_URUTAN.filter(d => set.includes(d));
  const runs = [];
  let run = [order[0]];
  for (let i = 1; i < order.length; i++) {
    if (HARI_URUTAN.indexOf(order[i]) === HARI_URUTAN.indexOf(order[i - 1]) + 1) run.push(order[i]);
    else { runs.push(run); run = [order[i]]; }
  }
  runs.push(run);
  return runs.map(r => r.length >= 3
    ? `${HARI_SINGKAT[r[0]]}–${HARI_SINGKAT[r[r.length - 1]]}`
    : r.map(d => HARI_SINGKAT[d]).join(', ')).join(', ');
}
function localDateKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
async function loadLiburNasional() {
  try {
    const { data, error } = await sb.from('libur_nasional').select('tanggal,nama');
    if (error) throw error;
    liburNasionalMap = Object.fromEntries((data || []).map(r => [r.tanggal, r.nama]));
  } catch (e) { console.error('Gagal memuat libur nasional:', e); } // fitur pelengkap, jangan blokir aplikasi
}
// Catatan "tutup hari ini" untuk pembeli. Pedagang yang menyalakan mode jualan (v.active) dianggap buka,
// apa pun jadwalnya. Tanggal memakai jam perangkat pembeli.
function vendorClosedTodayNote(v) {
  if (v.active) return null;
  const now = new Date();
  if (v.tutup_libur_nasional) {
    const nama = liburNasionalMap[localDateKey(now)];
    if (nama) return `Tutup hari ini · ${nama}`;
  }
  const hari = normalizeHariBuka(v.hari_buka);
  if (hari && !hari.includes(now.getDay())) return `Tutup hari ini · libur hari ${HARI_PANJANG[now.getDay()]}`;
  return null;
}

// Label jadwal siap-tampil: hari buka · jam (24 jam / jam_buka–jam_tutup) · tanggal merah · schedule_text lama
// (schedule_text bebas teks dijaga tetap tampil untuk toko yang belum isi ulang).
function vendorScheduleLabel(v) {
  const jam = v.buka_24jam
    ? 'Buka 24 Jam'
    : (v.jam_buka && v.jam_tutup ? `${v.jam_buka.slice(0, 5)} – ${v.jam_tutup.slice(0, 5)}` : null);
  const parts = [formatHariBuka(v.hari_buka), jam, v.tutup_libur_nasional ? 'Tutup tanggal merah' : null, v.schedule_text].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

// ---------- JARAK PEMBELI <-> PEDAGANG ----------
let buyerLoc = null; // { lat, lng } — diisi kalau pembeli izinkan lokasi
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function formatDistance(meters) {
  if (meters < 950) return Math.round(meters / 10) * 10 + ' m';
  return (meters / 1000).toFixed(1) + ' km';
}
function tryLocateBuyer(onFail) {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      buyerLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (mode === 'pembeli') renderPembeli();
      const regionBefore = buyerRegionId;
      getBuyerRegion().then(() => {
        ensurePushSubscription({ silent: true }); // kalau notifikasi sudah aktif, perbarui wilayah langganan
        if (buyerRegionId !== regionBefore && mode === 'pembeli') renderPembeli(); // filter pengumuman per zona
      }).catch(() => {});
    },
    (err) => { if (onFail) onFail(err); /* tanpa onFail: pembeli menolak/gagal lokasi — diamkan, jarak cukup disembunyikan */ },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
  );
}

// Ikon kecil untuk kartu & sheet (inline SVG supaya ikut warna teks)
const VP_ICON_CROWN = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8Z"/></svg>';
const VP_ICON_PIN = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 6.2 12.2 6.5 12.5.3.3.7.3 1 0C12.8 21.2 19 14.2 19 9a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z"/></svg>';
const VP_ICON_CHAT = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/></svg>';
const VP_ICON_HEART = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';

function vendorPhotoStyle(v) {
  if (v.photo_url) return `background-image:url('${v.photo_url}');`;
  if (v.mode_icon) return `background-image:url('mode_icons/${v.mode_icon}.png');`;
  return '';
}
function vendorDistanceLabel(v) {
  const p = vendorDisplayLatLng(v);
  return (buyerLoc && p) ? formatDistance(haversineMeters(buyerLoc.lat, buyerLoc.lng, p.lat, p.lng)) : null;
}

// Kartu pedagang: foto + lencana, nama, rating · kategori, jarak + tombol Chat.
// Aksi lain (menu, WhatsApp, peta, ulasan) ada di sheet detail: window.__openVendorSheet.
function renderVendorCardHtml(v, opts = {}) {
  const compact = !!opts.compact;
  const following = followedIds.has(v.id);
  const hasPhoto = !!v.photo_url;
  const distanceLabel = vendorDistanceLabel(v);
  const showable = vendorIsShowable(v);
  const cats = v.categories || [];
  const catLabel = cats.length ? escapeHtml(cats[0]) + (cats.length > 1 ? ` +${cats.length - 1}` : '') : '';
  const locLabel = distanceLabel || (v.region ? escapeHtml(v.region) : '');
  const nameJs = v.name.replace(/'/g, "\\'");
  return `
    <div class="vp-card ${compact ? 'vp-card-compact' : ''} ${isPromoActive(v) ? 'vp-card-promo' : ''}" onclick="if(!event.target.closest('button,a')) window.__openVendorSheet('${v.id}')">
      <div class="vp-photo-wrap">
        <div class="vp-photo ${!showable ? 'inactive' : ''}" style="${vendorPhotoStyle(v)}">${hasPhoto || v.mode_icon ? '' : (v.emoji || '🍜')}</div>
        <div class="vp-badges-top">
          ${v.is_premium ? `<span class="vp-pill vp-pill-premium">${VP_ICON_CROWN}Unggulan</span>` : ''}
          ${isPromoActive(v) ? '<span class="vp-pill vp-pill-promo">🔥 Promo</span>' : ''}
          ${v.verification_status === 'verified' ? '<span class="vp-verified" title="Toko Terverifikasi">✓</span>' : ''}
        </div>
        <button class="vp-heart ${following ? 'on' : ''}" aria-label="${following ? 'Berhenti mengikuti' : 'Ikuti'} ${escapeHtml(v.name)}" aria-pressed="${following}" onclick="window.__toggleFollow('${v.id}')">${VP_ICON_HEART}</button>
        <div class="vp-status-pill ${showable ? 'on' : 'off'}">${showable ? '<span class="vp-status-dot"></span>Sedang buka' : 'Belum buka'}</div>
      </div>
      <div class="vp-body">
        <div class="vp-name">${escapeHtml(v.name)}</div>
        <div class="vp-rating-line">
          ${v.rating_count > 0 ? `<span class="vp-rating">⭐ ${v.rating_avg} <span class="vp-rating-count">(${v.rating_count})</span></span>` : ''}
          ${catLabel ? `<span class="vp-cat">${catLabel}</span>` : ''}
        </div>
        ${isPromoActive(v) && v.promo_text ? `<div class="vp-promo-text">🔥 ${escapeHtml(v.promo_text)}</div>` : ''}
        ${vendorScheduleLabel(v) ? `<div class="vp-schedule" style="font-size:10.5px;color:var(--text-faint);margin-top:2px;">🕐 ${escapeHtml(vendorScheduleLabel(v))}</div>` : ''}
        ${vendorClosedTodayNote(v) ? `<div class="vp-closed">${escapeHtml(vendorClosedTodayNote(v))}</div>` : ''}
        <div class="vp-foot">
          ${locLabel ? `<span class="vp-loc">${VP_ICON_PIN}<span>${locLabel}</span></span>` : ''}
          ${vendorChatEnabled(v) ? `<button class="vp-chat-btn" onclick="window.__openChatModal('${v.id}','${nameJs}')">${VP_ICON_CHAT}Chat</button>` : (vendorWaUrl(v) ? `<a class="vp-chat-btn" href="${vendorWaUrl(v)}" target="_blank" rel="noopener" style="text-decoration:none;background:#25D366;box-shadow:0 6px 12px -6px rgba(37,211,102,.7);"><img src="icons/icon_chat_wa.png" alt="" style="width:16px;height:16px;">WhatsApp</a>` : '')}
        </div>
      </div>
    </div>
  `;
}

function renderVendorListHtml(list) {
  if (!list.length) return '<div style="color:var(--text-faint);font-size:13px;">Tidak ada pedagang.</div>';
  const sorted = sortVendorsForDisplay(list);
  return `<div class="vp-list">${sorted.map(v => renderVendorCardHtml(v)).join('')}</div>`;
}

// Baris atas beranda: carousel horizontal, maksimal 7 pedagang unggulan (aktif + premium/promo diprioritaskan)
function renderVendorCarouselHtml(list) {
  const top7 = sortVendorsForDisplay(list).slice(0, 7);
  if (!top7.length) return '';
  return `<div class="vp-carousel">${top7.map(v => `<div class="vp-carousel-item">${renderVendorCardHtml(v, { compact: true })}</div>`).join('')}</div>`;
}

// Bagian bawah beranda: grid 2 kolom untuk semua pedagang, scroll ke bawah bebas
function renderVendorGridHtml(list) {
  if (!list.length) return '<div style="color:var(--text-faint);font-size:13px;">Tidak ada pedagang.</div>';
  const sorted = sortVendorsForDisplay(list);
  return `<div class="vp-grid">${sorted.map(v => renderVendorCardHtml(v, { compact: true })).join('')}</div>`;
}


// ---------- PROMO HARI INI (beranda) ----------
// Otomatis dari data pedagang: tampil selama promo_until belum lewat, hilang sendiri saat berakhir.
// Kalau tidak ada promo aktif, seluruh panel tidak dirender. Tidak butuh kerja admin.
function promoTimeLeftLabel(until) {
  const ms = new Date(until) - new Date();
  if (!(ms > 0)) return '';
  const h = Math.floor(ms / 3600000);
  if (h < 1) return 'sisa < 1 jam';
  if (h < 24) return `sisa ${h} jam`;
  return `sisa ${Math.ceil(h / 24)} hari`;
}

function renderPromoTodayHtml(list) {
  const promos = list.filter(isPromoActive).map(v => {
    const p = vendorDisplayLatLng(v);
    const d = (buyerLoc && p) ? haversineMeters(buyerLoc.lat, buyerLoc.lng, p.lat, p.lng) : Infinity;
    return { v, d };
  }).sort((a, b) => {
    const sa = vendorIsShowable(a.v) ? 1 : 0, sb2 = vendorIsShowable(b.v) ? 1 : 0;
    if (sa !== sb2) return sb2 - sa;            // yang sedang buka dulu
    return a.d === b.d ? 0 : (a.d < b.d ? -1 : 1); // lalu yang terdekat
  }).slice(0, 8).map(x => x.v);
  if (!promos.length) return '';
  return `
    <div class="sec-head"><h2>🔥 Promo Hari Ini</h2><span class="sec-count sec-count-promo">${promos.length} promo aktif</span></div>
    <div class="pr-row">${promos.map(v => {
      const showable = vendorIsShowable(v);
      const loc = vendorDistanceLabel(v) || (v.region ? escapeHtml(v.region) : '');
      const left = promoTimeLeftLabel(v.promo_until);
      return `
      <button class="pr-card" onclick="window.__openVendorSheet('${v.id}')">
        <span class="pr-photo ${showable ? '' : 'inactive'}" style="${vendorPhotoStyle(v)}">${v.photo_url || v.mode_icon ? '' : (v.emoji || '🍜')}
          ${left ? `<span class="pr-left">⏳ ${left}</span>` : ''}
        </span>
        <span class="pr-name">${escapeHtml(v.name)}</span>
        <span class="pr-text">${v.promo_text ? escapeHtml(v.promo_text) : 'Sedang ada promo'}</span>
        <span class="pr-loc">${loc ? VP_ICON_PIN + loc : ''}</span>
      </button>`;
    }).join('')}</div>`;
}

// ---------- PEDAGANG TERDEKAT (beranda) + halaman "Lihat semua" ----------
const NEARBY_MAX_M = 10000; // hanya pedagang aktif dalam radius 10 km yang dianggap "terdekat"

function nearbyVendors(list) {
  if (!buyerLoc) return [];
  return list
    .filter(vendorIsShowable)
    .map(v => { const p = vendorDisplayLatLng(v); return { v, d: haversineMeters(buyerLoc.lat, buyerLoc.lng, p.lat, p.lng) }; })
    .filter(x => x.d <= NEARBY_MAX_M)
    .sort((a, b) => a.d - b.d)
    .map(x => x.v);
}

window.__enableLocation = function () {
  if (!navigator.geolocation) { showToast('Browser ini tidak mendukung lokasi.'); return; }
  tryLocateBuyer(() => showToast('Lokasi tidak bisa diakses. Izinkan lokasi di pengaturan browser.'));
};

window.__goView = function (view) { goToBottomView(view); window.scrollTo(0, 0); };

function nearbyEmptyHtml() {
  if (!buyerLoc) {
    return `<div class="near-empty">
      <div class="near-empty-text">Aktifkan lokasi untuk melihat pedagang yang sedang jualan di dekatmu.</div>
      <button class="near-btn" onclick="window.__enableLocation()">Aktifkan lokasi</button>
    </div>`;
  }
  return `<div class="near-empty"><div class="near-empty-text">Belum ada pedagang yang sedang jualan dalam radius ${NEARBY_MAX_M / 1000} km.</div></div>`;
}

function renderVendorMiniCardHtml(v) {
  const cats = v.categories || [];
  return `
    <button class="vm-card" onclick="window.__openVendorSheet('${v.id}')">
      <span class="vm-photo" style="${vendorPhotoStyle(v)}">${v.photo_url || v.mode_icon ? '' : (v.emoji || '🍜')}
        <span class="vp-status-pill on vm-pill"><span class="vp-status-dot"></span>Sedang buka</span>
      </span>
      <span class="vm-name">${escapeHtml(v.name)}</span>
      <span class="vm-rating">${v.rating_count > 0 ? `⭐ ${v.rating_avg} <span class="vp-rating-count">(${v.rating_count})</span>` : escapeHtml(cats[0] || '')}</span>
      <span class="vm-loc">${VP_ICON_PIN}${vendorDistanceLabel(v) || ''}</span>
    </button>`;
}

function renderNearbyHtml(list) {
  const near = nearbyVendors(list);
  const more = near.length > 3 ? '<button onclick="window.__goView(\'terdekat\')">Lihat semua ›</button>' : '';
  return `
    <div class="sec-head"><h2>Pedagang terdekat</h2>${more}</div>
    ${near.length ? `<div class="vm-row ${near.length > 3 ? 'scroll' : ''}">${near.slice(0, 6).map(renderVendorMiniCardHtml).join('')}</div>` : nearbyEmptyHtml()}
  `;
}

function renderTerdekatView() {
  const near = nearbyVendors(vendors);
  main.innerHTML = `
    <div class="sec-head"><button class="sec-back" onclick="window.__goView('status')">‹ Beranda</button></div>
    <div class="sec-head"><h2>Pedagang terdekat</h2>${near.length ? `<span class="sec-count">${near.length} sedang buka</span>` : ''}</div>
    ${near.length ? `<div class="vp-grid">${near.map(v => renderVendorCardHtml(v, { compact: true })).join('')}</div>` : nearbyEmptyHtml()}
  `;
}

// ---------- FAVORIT (tab "Favorit" = pedagang yang diikuti) ----------
function renderFavoritView() {
  const favs = sortVendorsForDisplay(vendors.filter(v => followedIds.has(v.id)));
  const openCount = favs.filter(v => v.active).length;
  main.innerHTML = `
    <div class="sec-head"><h2>Favoritmu</h2>${favs.length ? `<span class="sec-count">${openCount} sedang buka</span>` : ''}</div>
    ${favs.length
      ? `<div class="vp-grid">${favs.map(v => renderVendorCardHtml(v, { compact: true })).join('')}</div>`
      : `<div class="empty-state">
           <div class="empty-title">Belum ada favorit</div>
           <div class="empty-text">Ketuk ♥ di kartu pedagang untuk mengikutinya. Kamu akan tahu saat mereka mulai jualan.</div>
           <button class="near-btn" onclick="window.__goView('status')">Lihat pedagang</button>
         </div>`}
  `;
}

// ---------- AKUN (tab "Akun": pembeli tidak punya login, jadi ini pusat pengaturan & bantuan) ----------
window.__openArtikelList = function () { artikelDetailSlug = null; window.__goView('artikel'); };
window.__goPedagang = function () { goToPedagangDashboard(); window.scrollTo(0, 0); };

function renderAkunView() {
  const perm = pushSupported() ? Notification.permission : null;
  const row = (icon, title, sub, onclick) => `
    <button class="acc-row" onclick="${onclick}">
      <span class="acc-ico">${icon}</span>
      <span class="acc-text"><span class="acc-title">${title}</span>${sub ? `<span class="acc-sub">${sub}</span>` : ''}</span>
      <span class="acc-chev">›</span>
    </button>`;
  const notifSub = perm === 'granted' ? 'Aktif' : perm === 'denied' ? 'Diblokir di browser' : 'Belum aktif · ketuk untuk mengaktifkan';
  main.innerHTML = `
    <div class="acc-hero">
      <div class="acc-avatar">🧑</div>
      <div>
        <div class="acc-name">Pembeli JajanDekat</div>
        <div class="acc-note">${followedIds.size ? `Mengikuti ${followedIds.size} pedagang` : 'Belum mengikuti pedagang'} · tanpa perlu akun</div>
      </div>
    </div>
    <div class="acc-list">
      ${perm ? row('🔔', 'Notifikasi', notifSub, 'window.__notifTap()') : ''}
      ${row('📰', 'Artikel', 'Tips dan info kuliner', 'window.__openArtikelList()')}
      ${row('🧭', 'Panduan penggunaan', '', "window.__openGuideModal('pembeli')")}
      ${row('❓', 'Bantuan &amp; FAQ', '', 'window.__openFaqModal()')}
      ${row('📤', 'Bagikan aplikasi', 'Ajak teman dan pedagang', 'window.__shareApp()')}
      ${row('🛒', 'Ingin berjualan?', 'Buka mode Pedagang', 'window.__goPedagang()')}
    </div>
  `;
}

// ---------- SHEET DETAIL PEDAGANG ----------
window.__closeVendorSheet = function () {
  document.getElementById('vendor-sheet-overlay')?.remove();
};

window.__openVendorSheet = function (vendorId, opts = {}) {
  const v = vendors.find(x => x.id === vendorId);
  if (!v) return;
  document.getElementById('vendor-sheet-overlay')?.remove();

  const following = followedIds.has(v.id);
  const untilStr = v.active_until
    ? new Date(v.active_until).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    : null;
  const distanceLabel = vendorDistanceLabel(v);
  const cats = (v.categories || []).map(escapeHtml).join(' · ');
  const canMap = vendorIsShowable(v);
  const canWa = v.show_whatsapp !== false && v.whatsapp;
  const waUrl = canWa ? `https://wa.me/${v.whatsapp}?text=${encodeURIComponent(`Halo ${v.name}, saya lihat lapak Anda di JajanDekat. Saya mau tanya-tanya, apakah masih jualan?`)}` : '';

  const overlay = document.createElement('div');
  overlay.id = 'vendor-sheet-overlay';
  overlay.className = 'vs-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) window.__closeVendorSheet(); };
  overlay.innerHTML = `
    <div class="vs-sheet ${opts.still ? 'still' : ''}" role="dialog" aria-modal="true" aria-label="${escapeHtml(v.name)}">
      <div class="vs-photo-wrap">
        <div class="vs-photo ${!canMap ? 'inactive' : ''}" style="${vendorPhotoStyle(v)}">${v.photo_url || v.mode_icon ? '' : (v.emoji || '🍜')}</div>
        <button class="vs-close" aria-label="Tutup" onclick="window.__closeVendorSheet()">✕</button>
        <div class="vp-badges-top">
          ${v.is_premium ? `<span class="vp-pill vp-pill-premium">${VP_ICON_CROWN}Unggulan</span>` : ''}
          ${isPromoActive(v) ? '<span class="vp-pill vp-pill-promo">🔥 Promo</span>' : ''}
          ${v.verification_status === 'verified' ? '<span class="vp-verified" title="Toko Terverifikasi">✓</span>' : ''}
        </div>
      </div>
      <div class="vs-body">
        <div class="vs-title">${escapeHtml(v.name)}</div>
        <div class="vs-meta">
          ${v.rating_count > 0 ? `<span class="vp-rating">⭐ ${v.rating_avg} <span class="vp-rating-count">(${v.rating_count} ulasan)</span></span>` : '<span class="vs-muted">Belum ada ulasan</span>'}
          ${cats ? `<span class="vs-muted">${cats}</span>` : ''}
        </div>
        <div class="vs-status ${canMap && !vendorClosedTodayNote(v) ? 'on' : ''}">
          <span class="vs-status-dot"></span>${v.active ? 'Sedang buka' + (untilStr ? ' · sampai ' + untilStr : '') : (vendorClosedTodayNote(v) ? 'Tutup hari ini' : (canMap ? 'Sedang buka' : 'Belum buka'))}
        </div>
        ${vendorScheduleLabel(v) ? `<div class="vs-line">🕐 <span>${escapeHtml(vendorScheduleLabel(v))}</span></div>` : ''}
        ${vendorClosedTodayNote(v) ? `<div class="vs-line vs-closed">${escapeHtml(vendorClosedTodayNote(v))}</div>` : ''}
        ${distanceLabel ? `<div class="vs-line">${VP_ICON_PIN}<span>${distanceLabel} dari kamu</span></div>` : ''}
        ${v.region ? `<div class="vs-line">${VP_ICON_PIN}<span>${escapeHtml(v.region)}</span></div>` : ''}
        ${v.location_note ? `<div class="vs-line vs-muted">📍 ${escapeHtml(v.location_note)}</div>` : ''}
        ${!canMap ? '<div class="vs-line vs-muted">Lokasi belum tersedia</div>' : ''}
        ${isPromoActive(v) && v.promo_text ? `<div class="vs-promo">🔥 ${escapeHtml(v.promo_text)}</div>` : ''}
        <div class="vs-actions">
          ${vendorChatEnabled(v) ? `<button class="vs-btn primary wide" onclick="window.__vsAct('chat','${v.id}')">${VP_ICON_CHAT}Chat di JajanDekat</button>` : ''}
          ${canWa ? `<a class="vs-btn wa${vendorChatEnabled(v) ? '' : ' wide'}" href="${waUrl}" target="_blank" rel="noopener"><img class="vs-ic" src="icons/icon_chat_wa.png" alt="">WhatsApp</a>` : ''}
          <button class="vs-btn" onclick="window.__vsAct('menu','${v.id}')"><span class="vs-emoji">🍽️</span>Lihat menu</button>
          ${canMap ? `<button class="vs-btn" onclick="window.__vsAct('map','${v.id}')"><img class="vs-ic" src="icons/icon_map.png" alt="">Lihat di peta</button>` : ''}
          <button class="vs-btn ${following ? 'on' : ''}" onclick="window.__vsAct('follow','${v.id}')">${following ? '<img class="vs-ic" src="icons/icon_check.png" alt="">Mengikuti' : '<span class="vs-emoji">➕</span>Ikuti'}</button>
          <button class="vs-btn ghost wide" onclick="window.__vsAct('review','${v.id}')">💬 Beri ulasan atau masukan</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
};

window.__vsAct = async function (kind, id) {
  const v = vendors.find(x => x.id === id);
  if (!v) return;
  if (kind === 'follow') {
    await window.__toggleFollow(id);
    window.__openVendorSheet(id, { still: true }); // segarkan tombol Ikuti tanpa animasi ulang
    return;
  }
  window.__closeVendorSheet();
  if (kind === 'chat') window.__openChatModal(id, v.name);
  else if (kind === 'menu') window.__openProductCatalog(id, v.name);
  else if (kind === 'review') window.__openReviewModal(id, v.name);
  else if (kind === 'map') window.__goToVendorOnMap(id);
};

window.__goToVendorOnMap = function (id) {
  const v = vendors.find(x => x.id === id);
  const p = v && vendorDisplayLatLng(v);
  bottomView = 'peta';
  setNavActive('peta');
  if (mode !== 'pembeli') {
    mode = 'pembeli';
    btnPembeli.classList.add('active'); btnPedagang.classList.remove('active');
  }
  renderPembeli();
  setTimeout(() => {
    if (map && p) {
      map.setView([p.lat, p.lng], 16);
      if (markers[id]) markers[id].openPopup();
    }
  }, 200);
};

// ---------- LINK DARI NOTIFIKASI / PENGUMUMAN (?vendor= / ?artikel= / ?ann=) ----------
function openVendorFromLink(vendorId) {
  const key = String(vendorId).toLowerCase();
  const v = vendors.find(x => String(x.id).toLowerCase() === key);
  if (!v) { renderPembeli(); showToast('Pedagang tidak ditemukan.'); return; }
  // Posisi diambil dari data terbaru (sudah di-fetch saat app dibuka), bukan dari isi notifikasi
  if (v.active && v.lat && v.lng) {
    window.__goToVendorOnMap(v.id, v.lat, v.lng);
  } else {
    goToBottomView('status');
    showToast(`${v.name} sedang tidak berjualan.`);
    window.__openReviewModal(v.id, v.name);
  }
}

function openArtikelFromLink(slug) {
  artikelDetailSlug = String(slug); // kalau slug tidak ada, halaman detail menampilkan "Artikel tidak ditemukan"
  goToBottomView('artikel');
}

function openAnnouncementFromLink(id) {
  const ann = announcements.find(a => a.id === id);
  if (!ann) { goToBottomView('status'); showToast('Pengumuman ini sudah tidak aktif.'); return; }
  if (ann.audience === 'premium' || ann.audience === 'biasa') goToPedagangDashboard();
  else goToBottomView('status');
  window.__openNotifInbox(); // pengumuman kini dibaca di Kotak Notifikasi, bukan kartu beranda
}

function openInternalLink(link) {
  const raw = String(link);
  if (/^app:/.test(raw)) { // tujuan halaman aplikasi (dipakai banner): app:daftar | promo | peta | cari | favorit | terdekat | artikel
    const page = raw.slice(4);
    if (page === 'daftar') { goToPedagangDashboard(); return true; }
    if (page === 'promo') { // halaman pedagang, langsung sorot kartu "Promosi Lokal Harian" (kalau sudah login)
      goToPedagangDashboard();
      const focus = () => {
        const el = document.getElementById('vendor-promo-card');
        if (!el) return false;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('promo-pulse');
        setTimeout(() => el.classList.remove('promo-pulse'), 2600);
        return true;
      };
      setTimeout(() => { if (!focus()) setTimeout(focus, 500); }, 200);
      return true;
    }
    if (['peta', 'cari', 'favorit', 'terdekat', 'artikel'].includes(page)) { goToBottomView(page); window.scrollTo(0, 0); return true; }
    return false;
  }
  const p = new URLSearchParams(String(link).replace(/^\?/, ''));
  if (p.get('vendor')) { openVendorFromLink(p.get('vendor')); return true; }
  if (p.get('artikel')) { openArtikelFromLink(p.get('artikel')); return true; }
  if (p.get('ann')) { openAnnouncementFromLink(p.get('ann')); return true; }
  return false;
}
window.__openInternalLink = function (link) { openInternalLink(link); };

// ---------- PETA VIEW (tab "Peta") ----------
function renderPetaView() {
  const activeVendors = vendors.filter(vendorIsShowable);
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
      v.name.toLowerCase().includes(q) || (v.categories || []).some(c => c.toLowerCase().includes(q)) || (v.custom_tags || []).some(t => t.toLowerCase().includes(q))
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
  vendors.filter(vendorIsShowable).forEach(v => {
    const p = vendorDisplayLatLng(v);
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
      ${vendorChatEnabled(v) ? `<button onclick="window.__openChatModal('${v.id}','${v.name.replace(/'/g, "\\'")}')"
         style="display:inline-block;margin-top:6px;background:var(--brand);color:#fff;border:none;text-decoration:none;
         font-size:11.5px;font-weight:700;padding:6px 10px;border-radius:8px;cursor:pointer;">
        💬 Chat di App
      </button>` : ''}
      ${v.whatsapp && v.show_whatsapp !== false ? `
        <a href="https://wa.me/${v.whatsapp}?text=${encodeURIComponent(`Halo ${v.name}, saya lihat lapak Anda di JajanDekat. Saya mau tanya-tanya, apakah masih jualan?`)}" target="_blank"
           style="display:inline-block;margin-top:6px;margin-left:4px;background:#25D366;color:#fff;text-decoration:none;
           font-size:11.5px;font-weight:700;padding:6px 10px;border-radius:8px;">
          📱 WhatsApp
        </a>
      ` : ''}
      <div style="font-size:9px;color:#999;margin-top:5px;">Transaksi langsung dengan pedagang, di luar tanggung jawab JajanDekat.</div>
    `;
    markers[v.id] = L.marker([p.lat, p.lng], { icon }).addTo(map).bindPopup(popupHtml);
  });

  // Peta dulu selalu diam di lokasi/zoom default (kadang jauh dari pedagang/pembeli),
  // jadi marker yang ada bisa kelewat kalau di luar area yang kelihatan. Sekali saja,
  // begitu datanya sudah ada, fokuskan ke marker pedagang (atau ke lokasi pembeli kalau
  // belum ada pedagang aktif) — supaya sesudah itu pembeli bebas geser/zoom sendiri.
  if (!mapDidInitialFit) {
    const markerList = Object.values(markers);
    if (markerList.length) {
      map.fitBounds(L.featureGroup(markerList).getBounds(), { padding: [40, 40], maxZoom: 16 });
      mapDidInitialFit = true;
    } else if (buyerLoc) {
      map.setView([buyerLoc.lat, buyerLoc.lng], 14);
      mapDidInitialFit = true;
    }
  }
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
let regTagsValue = '';
let regScheduleValue = '';
let regLocationNoteValue = '';
let regFixedLat = null;
let regFixedLng = null;
let regJamBukaValue = '08:00';
let regJamTutupValue = '21:00';
let regBuka24Value = false;
let regHariBukaValue = [0, 1, 2, 3, 4, 5, 6];
let regTutupLiburValue = false;
let catPickerQuery = '';
let regStep = 0;
let knownTagSuggestions = [];

// ---------- Bagian form bersama: pengingat, lokasi mangkal, jam operasional, catatan ----------
// Dipakai di langkah 5 pendaftaran (p:'reg') dan Edit Profil Toko (p:'edit') supaya tampilannya
// selalu sama. ID elemen mengikuti pola `${p}-...` (reg-reminder, edit-jam-buka, dst).
const JD_ICON_PATHS = {
  bell: '<path d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9Z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  pin: '<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  note: '<path d="M6 4h12v16H6z"/><path d="M9 9h6M9 13h6M9 17h3"/>',
};
function jdIcon(name) {
  return `<span class="jd-sec-ico" aria-hidden="true"><svg viewBox="0 0 24 24">${JD_ICON_PATHS[name]}</svg></span>`;
}
function jdEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
// Pilihan jam pengingat tiap 30 menit (03.00–23.30). Nilai lama di luar kelipatan 30 menit tetap ditampilkan.
function jdReminderOptions(current) {
  const times = [];
  for (let m = 3 * 60; m <= 23 * 60 + 30; m += 30) {
    times.push(String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'));
  }
  if (current && !times.includes(current)) { times.push(current); times.sort(); }
  return '<option value="">Tanpa pengingat</option>' +
    times.map(t => `<option value="${t}"${t === current ? ' selected' : ''}>${t.replace(':', '.')}</option>`).join('');
}
function readHariFromDom(p) {
  const row = document.getElementById(p + '-hari-row');
  if (!row) return null;
  return [...row.querySelectorAll('.jd-day[aria-pressed="true"]')].map(b => Number(b.dataset.d)).sort((a, b) => a - b);
}
function applyHariToDom(p, days) {
  const row = document.getElementById(p + '-hari-row');
  if (row) row.querySelectorAll('.jd-day').forEach(b => b.setAttribute('aria-pressed', days.includes(Number(b.dataset.d)) ? 'true' : 'false'));
  if (p === 'reg') regHariBukaValue = days.slice(); // simpan agar tidak hilang saat wizard dirender ulang
}
window.__toggleHari = function (p, d) {
  const now = readHariFromDom(p) || [];
  const next = now.includes(d) ? now.filter(x => x !== d) : [...now, d];
  if (!next.length) return; // minimal 1 hari buka
  applyHariToDom(p, next);
};
window.__setHariPreset = function (p, kind) {
  applyHariToDom(p, kind === 'semua' ? [0, 1, 2, 3, 4, 5, 6] : kind === 'sen-sab' ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5]);
};
function renderJadwalFields(cfg) {
  const p = cfg.p;
  // Di pendaftaran, nilai disimpan ke variabel wizard tiap kali berubah; di Edit Profil dibaca saat simpan.
  const track = (field, evt) => cfg.track ? ` ${evt}="window.__updateRegField('${field}', this.value)"` : '';
  return `
    <div class="jd-form${cfg.track ? '' : ' jd-form-edit'}">

      <section class="jd-sec">
        <div class="jd-sec-head">
          ${jdIcon('bell')}
          <div>
            <div class="jd-sec-title">Pengingat buka lapak</div>
            <div class="jd-sec-help">Kami kirim notifikasi supaya kamu tidak lupa menyalakan mode jualan.</div>
          </div>
        </div>
        <div class="jd-field">
          <label class="jd-label" for="${p}-reminder">Ingatkan saya pada jam</label>
          <select id="${p}-reminder"${track('reminder', 'onchange')}>${jdReminderOptions(cfg.reminder || '')}</select>
        </div>
      </section>

      <section class="jd-sec">
        <div class="jd-sec-head">
          ${jdIcon('pin')}
          <div>
            <div class="jd-sec-title">Lokasi mangkal</div>
            <div class="jd-sec-help">Untuk toko menetap atau pedagang yang biasa mangkal di satu titik. Tokomu tetap muncul di peta walau mode jualan belum dinyalakan.</div>
          </div>
        </div>
        <div class="jd-loc${cfg.hasLoc ? ' is-set' : ''}" id="${p}-location-box">
          <div class="jd-loc-status" id="${p}-location-status">${cfg.hasLoc ? 'Lokasi tersimpan' : 'Belum ada lokasi tersimpan'}</div>
          <button type="button" class="jd-btn-outline" onclick="${cfg.onCapture}()">${cfg.hasLoc ? 'Perbarui dengan lokasi saya sekarang' : 'Pakai lokasi saya sekarang'}</button>
        </div>
      </section>

      <section class="jd-sec">
        <div class="jd-sec-head">
          ${jdIcon('clock')}
          <div>
            <div class="jd-sec-title">Hari &amp; jam buka</div>
            <div class="jd-sec-help" id="${p}-jam-hint">${cfg.buka24 ? 'Tokomu tampil sebagai “Buka 24 jam” di hari buka.' : 'Isi jika hari dan jam bukamu biasanya tetap.'}</div>
          </div>
        </div>
        <div class="jd-field">
          <span class="jd-label" id="${p}-hari-label">Hari buka</span>
          <div class="jd-days" id="${p}-hari-row" role="group" aria-labelledby="${p}-hari-label">
            ${HARI_URUTAN.map(d => `<button type="button" class="jd-day" data-d="${d}" aria-pressed="${(normalizeHariBuka(cfg.hari) || [0, 1, 2, 3, 4, 5, 6]).includes(d)}" onclick="window.__toggleHari('${p}', ${d})">${HARI_SINGKAT[d]}</button>`).join('')}
          </div>
          <div class="jd-presets">
            <button type="button" class="jd-preset" onclick="window.__setHariPreset('${p}', 'semua')">Setiap hari</button>
            <button type="button" class="jd-preset" onclick="window.__setHariPreset('${p}', 'sen-sab')">Sen–Sab</button>
            <button type="button" class="jd-preset" onclick="window.__setHariPreset('${p}', 'sen-jum')">Sen–Jum</button>
          </div>
        </div>
        <label class="jd-switch-row">
          <span class="jd-switch-text"><b>Buka 24 jam</b><small>Tanpa jam tutup</small></span>
          <input id="${p}-buka24" class="jd-switch" type="checkbox" role="switch" ${cfg.buka24 ? 'checked' : ''} onchange="${cfg.onToggle}(this.checked)" />
        </label>
        <div class="jd-time-row" id="${p}-jam-wrap"${cfg.buka24 ? ' style="display:none;"' : ''}>
          <div class="jd-field">
            <label class="jd-label" for="${p}-jam-buka">Jam buka</label>
            <input id="${p}-jam-buka" type="time" value="${jdEsc(cfg.jamBuka)}"${track('jamBuka', 'oninput')} />
          </div>
          <div class="jd-field">
            <label class="jd-label" for="${p}-jam-tutup">Jam tutup</label>
            <input id="${p}-jam-tutup" type="time" value="${jdEsc(cfg.jamTutup)}"${track('jamTutup', 'oninput')} />
          </div>
        </div>
        <label class="jd-switch-row">
          <span class="jd-switch-text"><b>Tutup saat tanggal merah</b><small>Libur nasional saja, cuti bersama tidak dihitung</small></span>
          <input id="${p}-libur" class="jd-switch" type="checkbox" role="switch" ${cfg.tutupLibur ? 'checked' : ''}${track('liburNasional', 'onchange').replace('this.value', 'this.checked')} />
        </label>
      </section>

      <section class="jd-sec">
        <div class="jd-sec-head">
          ${jdIcon('note')}
          <div>
            <div class="jd-sec-title">Catatan untuk pembeli</div>
            <div class="jd-sec-help">Info tambahan yang tampil di halaman tokomu.</div>
          </div>
        </div>
        <div class="jd-field">
          <label class="jd-label" for="${p}-schedule">Catatan jadwal</label>
          <input id="${p}-schedule" type="text" value="${jdEsc(cfg.schedule)}"${track('schedule', 'oninput')} placeholder="mis. Libur setiap Jumat" />
        </div>
        <div class="jd-field">
          <label class="jd-label" for="${p}-location-note">Catatan lokasi</label>
          <input id="${p}-location-note" type="text" value="${jdEsc(cfg.locationNote)}"${track('locationNote', 'oninput')} placeholder="mis. Depan gerbang sekolah" />
        </div>
      </section>

    </div>
  `;
}

window.__updateCatPickerQuery = function (value) {
  catPickerQuery = value;
  renderPedagang();
  // Fokus & posisi kursor tetap di kolom cari setelah re-render
  requestAnimationFrame(() => {
    const el = document.getElementById('reg-cat-search');
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  });
};

// Navigasi wizard pendaftaran (geser sisi ke sisi). delta: 1 = lanjut, -1 = kembali.
// Tidak lewat renderPedagang() supaya transisi geser terlihat mulus (bukan render ulang).
window.__regWizardGo = function (delta) {
  const stepErr = document.getElementById('reg-step-error');
  if (stepErr) stepErr.textContent = '';
  if (delta > 0) {
    if (regStep === 0) {
      const name = (document.getElementById('reg-name')?.value || '').trim();
      if (!name) { if (stepErr) stepErr.textContent = 'Nama usaha wajib diisi.'; return; }
    } else if (regStep === 1) {
      if (selectedCategories.length === 0) { if (stepErr) stepErr.textContent = 'Pilih minimal 1 jenis jualan.'; return; }
    } else if (regStep === 2) {
      if (!selectedModeIcon) { if (stepErr) stepErr.textContent = 'Pilih mode jualan Anda.'; return; }
    } else if (regStep === 3) {
      const wa = (document.getElementById('reg-whatsapp')?.value || '').trim();
      const pin = (document.getElementById('reg-pin')?.value || '').trim();
      if (!wa) { if (stepErr) stepErr.textContent = 'Nomor WhatsApp wajib diisi.'; return; }
      if (!/^\d{6}$/.test(pin)) { if (stepErr) stepErr.textContent = 'PIN wajib 6 angka.'; return; }
    }
  }
  regStep = Math.max(0, Math.min(4, regStep + delta));
  const track = document.getElementById('reg-wizard-track');
  if (track) track.style.transform = `translateX(-${regStep * 100}%)`;
  document.querySelectorAll('.reg-dot').forEach((d, i) => {
    d.classList.toggle('active', i === regStep);
    d.classList.toggle('done', i < regStep);
  });
};
let isRegistering = false;

window.__updateRegField = function (field, value) {
  if (field === 'name') regNameValue = value;
  if (field === 'whatsapp') regWhatsappValue = value;
  if (field === 'pin') regPinValue = value;
  if (field === 'reminder') regReminderValue = value;
  if (field === 'tags') regTagsValue = value;
  if (field === 'schedule') regScheduleValue = value;
  if (field === 'locationNote') regLocationNoteValue = value;
  if (field === 'jamBuka') regJamBukaValue = value;
  if (field === 'jamTutup') regJamTutupValue = value;
  if (field === 'liburNasional') regTutupLiburValue = !!value;
};

// Toggle "Buka 24 Jam" di form pendaftaran — langsung ubah tampilan (sembunyikan kotak
// jam) tanpa render ulang seluruh wizard, biar transisi geser antar step tetap mulus.
window.__toggleRegBuka24 = function (checked) {
  regBuka24Value = checked;
  const wrap = document.getElementById('reg-jam-wrap');
  if (wrap) wrap.style.display = checked ? 'none' : '';
  const hint = document.getElementById('reg-jam-hint');
  if (hint) hint.textContent = checked ? 'Tokomu tampil sebagai “Buka 24 jam” di hari buka.' : 'Isi jika hari dan jam bukamu biasanya tetap.';
};

// Simpan "lokasi mangkal" saat daftar — dipakai buat toko menetap MAUPUN keliling yang
// biasanya tetap mangkal di 1 titik. Sengaja ambil dari GPS device (bukan bikin picker
// peta baru), konsisten dengan cara ambil lokasi live di alur "mulai jualan".
window.__captureRegLocation = function () {
  const statusEl = document.getElementById('reg-location-status');
  if (!navigator.geolocation) { if (statusEl) statusEl.textContent = 'Browser ini tidak mendukung lokasi.'; return; }
  if (statusEl) statusEl.textContent = 'Mengambil lokasi…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      regFixedLat = pos.coords.latitude;
      regFixedLng = pos.coords.longitude;
      if (statusEl) statusEl.textContent = 'Lokasi tersimpan dari posisi sekarang';
      document.getElementById('reg-location-box')?.classList.add('is-set');
    },
    () => { if (statusEl) statusEl.textContent = 'Gagal mengambil lokasi. Izinkan akses lokasi lalu coba lagi.'; },
    { enableHighAccuracy: true, timeout: 10000 }
  );
};

async function loadKnownTagSuggestions() {
  try {
    // Tabel tag_suggestions dikunci RLS (tidak ada policy publik) — baca lewat RPC.
    const { data, error } = await sb.rpc('jd_get_tag_suggestions');
    if (error) throw error;
    knownTagSuggestions = (data || []).map(r => r.tag_display);
  } catch (e) { /* diamkan, autocomplete opsional */ }
}

// Simpan tag baru lewat RPC jd_log_tag_suggestion (dedupe+count sudah ditangani di server;
// tabel tag_suggestions sendiri tidak lagi bisa ditulis langsung dari client).
async function logTagSuggestions(rawTagsString) {
  const tags = (rawTagsString || '').split(',').map(t => t.trim()).filter(Boolean);
  for (const tag of tags) {
    try {
      await sb.rpc('jd_log_tag_suggestion', { p_tag: tag });
    } catch (e) { /* jangan blokir alur pendaftaran/edit kalau ini gagal */ }
  }
}
function parseTagsInput(rawTagsString) {
  return (rawTagsString || '').split(',').map(t => t.trim()).filter(Boolean);
}
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
  // Makanan Siap Saji / Jajanan
  { label: 'Bakso', icon: 'bakso', group: 'Makanan Siap Saji' },
  { label: 'Mi Ayam', icon: 'mi_ayam', group: 'Makanan Siap Saji' },
  { label: 'Siomay', icon: 'siomay', group: 'Makanan Siap Saji' },
  { label: 'Sate', icon: 'sate', group: 'Makanan Siap Saji' },
  { label: 'Gorengan', icon: 'gorengan', group: 'Makanan Siap Saji' },
  { label: 'Kebab', icon: 'kebab', group: 'Makanan Siap Saji' },
  { label: 'Nasi', icon: 'nasi', group: 'Makanan Siap Saji' },
  { label: 'Jajanan', icon: 'jajanan', group: 'Makanan Siap Saji' },
  // Minuman & Camilan
  { label: 'Minuman', icon: 'minuman', group: 'Minuman & Camilan' },
  { label: 'Kopi', icon: 'kopi', group: 'Minuman & Camilan' },
  { label: 'Roti & Kue', icon: 'roti_kue', group: 'Minuman & Camilan' },
  { label: 'Snack & Camilan', icon: 'snack_camilan', group: 'Minuman & Camilan' },
  // Bahan Makanan Segar
  { label: 'Buah', icon: 'buah', group: 'Bahan Makanan Segar' },
  { label: 'Sayur', icon: 'sayur', group: 'Bahan Makanan Segar' },
  { label: 'Ikan & Seafood', icon: 'ikan_seafood', group: 'Bahan Makanan Segar' },
  { label: 'Ayam & Daging', icon: 'ayam_daging', group: 'Bahan Makanan Segar' },
  { label: 'Telur', icon: 'telur', group: 'Bahan Makanan Segar' },
  { label: 'Sembako', icon: 'sembako', group: 'Bahan Makanan Segar' },
  { label: 'Warung', icon: 'warung', group: 'Bahan Makanan Segar' },
  { label: 'Toko Kelontong', icon: 'toko_kelontong', group: 'Bahan Makanan Segar' },
  // Fashion & Aksesoris
  { label: 'Pakaian', icon: 'pakaian', group: 'Fashion & Aksesoris' },
  { label: 'Sepatu & Sandal', icon: 'sepatu_sandal', group: 'Fashion & Aksesoris' },
  { label: 'Tas & Koper', icon: 'tas_koper', group: 'Fashion & Aksesoris' },
  { label: 'Aksesoris', icon: 'aksesoris', group: 'Fashion & Aksesoris' },
  { label: 'Kosmetik', icon: 'kosmetik', group: 'Fashion & Aksesoris' },
  // Barang & Perlengkapan
  { label: 'HP & Aksesoris', icon: 'hp_aksesoris', group: 'Barang & Perlengkapan' },
  { label: 'Elektronik', icon: 'elektronik', group: 'Barang & Perlengkapan' },
  { label: 'Alat Tulis', icon: 'alat_tulis', group: 'Barang & Perlengkapan' },
  { label: 'Mainan', icon: 'mainan', group: 'Barang & Perlengkapan' },
  { label: 'Bunga & Tanaman', icon: 'bunga_tanaman', group: 'Barang & Perlengkapan' },
  { label: 'Peralatan & Perkakas', icon: 'peralatan_perkakas', group: 'Barang & Perlengkapan' },
  { label: 'Rumah Tangga', icon: 'rumah_tangga', group: 'Barang & Perlengkapan' },
  { label: 'Sabun & Perawatan', icon: 'sabun_perawatan', group: 'Barang & Perlengkapan' },
  // Kebutuhan Harian
  { label: 'BBM Eceran', icon: 'bbm_eceran', group: 'Kebutuhan Harian' },
  { label: 'Gas LPG', icon: 'gas_lpg', group: 'Kebutuhan Harian' },
  { label: 'Air Galon', icon: 'air_galon', group: 'Kebutuhan Harian' },
  { label: 'Pulsa & Token', icon: 'pulsa_token', group: 'Kebutuhan Harian' },
  // Jasa & Layanan
  { label: 'Fotokopi & Percetakan', icon: 'fotokopi_percetakan', group: 'Jasa & Layanan' },
  { label: 'Pangkas Rambut', icon: 'pangkas_rambut', group: 'Jasa & Layanan' },
  { label: 'Laundry', icon: 'laundry', group: 'Jasa & Layanan' },
  { label: 'Bengkel / Jasa Perbaikan', icon: 'bengkel_jasa_perbaikan', group: 'Jasa & Layanan' },
  { label: 'Jasa Antar', icon: 'jasa_antar', group: 'Jasa & Layanan' },
  { label: 'Jasa Keliling', icon: 'jasa_keliling', group: 'Jasa & Layanan' },
  { label: 'Bunga, Hadiah & Dekorasi', icon: 'bunga_hadiah_dekorasi', group: 'Jasa & Layanan' },
  { label: 'Kerajinan', icon: 'kerajinan', group: 'Jasa & Layanan' },
  // Lainnya
  { label: 'Lainnya', icon: 'lainnya', group: 'Lainnya' },
];
const CATEGORY_GROUP_ORDER = ['Makanan Siap Saji', 'Minuman & Camilan', 'Bahan Makanan Segar', 'Fashion & Aksesoris', 'Barang & Perlengkapan', 'Kebutuhan Harian', 'Jasa & Layanan', 'Lainnya'];

// Render grid kategori terkelompok + kolom cari di atas. selectedLabels: array label yg lagi dipilih.
// toggleFn: nama fungsi global (string) yang dipanggil onclick, mis. "window.__toggleCategory".
function renderCategoryPickerGrouped(selectedLabels, toggleFn, query) {
  const q = (query || '').trim().toLowerCase();
  const matches = q ? CATEGORY_OPTIONS.filter(c => c.label.toLowerCase().includes(q)) : CATEGORY_OPTIONS;
  if (q && matches.length === 0) {
    return '<div style="font-size:11.5px;color:var(--text-faint);padding:10px 0;">Gak ketemu — coba tulis di kolom tag di bawah.</div>';
  }
  const groups = q ? [...new Set(matches.map(c => c.group))] : CATEGORY_GROUP_ORDER;
  return groups.map(g => {
    const items = matches.filter(c => c.group === g);
    if (items.length === 0) return '';
    return `
      <div style="font-size:10.5px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.03em;margin:10px 0 6px;">${g}</div>
      <div class="cat-picker-grid">
        ${items.map(c => `
          <button type="button" class="cat-picker-item ${selectedLabels.includes(c.label) ? 'picked' : ''}" onclick="${toggleFn}('${c.label.replace(/'/g, "\\'")}')">
            <div class="cat-picker-icon-wrap">${categoryIconImgTag(c.label, c.icon, '')}</div>
            <span>${c.label}</span>
          </button>
        `).join('')}
      </div>
    `;
  }).join('');
}
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
const CATEGORY_EMOJI_FALLBACK = { kebab: '🌯' };
function categoryIconImgTag(label, iconKey, cls) {
  const fallback = CATEGORY_EMOJI_FALLBACK[iconKey];
  const onerr = fallback
    ? `this.replaceWith(Object.assign(document.createElement('span'),{textContent:'${fallback}',style:'font-size:22px;'}))`
    : '';
  return `<img class="${cls}" src="icons/${iconKey}.png" alt="${label}" onerror="${onerr}" />`;
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
let editCatPickerQuery = '';
let editFixedLat = null;
let editFixedLng = null;

window.__openEditProfile = function (vendorId) {
  const v = vendors.find(v => v.id === vendorId);
  if (!v) return;
  editCategories = [...(v.categories || [])];
  editModeIcon = v.mode_icon || null;
  editCatPickerQuery = '';
  editFixedLat = v.fixed_lat || null;
  editFixedLng = v.fixed_lng || null;
  renderEditProfile(vendorId);
};

// Sama seperti di form daftar: ambil dari GPS device, bukan bikin picker peta baru.
window.__captureEditLocation = function () {
  const statusEl = document.getElementById('edit-location-status');
  if (!navigator.geolocation) { if (statusEl) statusEl.textContent = 'Browser ini tidak mendukung lokasi.'; return; }
  if (statusEl) statusEl.textContent = 'Mengambil lokasi…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      editFixedLat = pos.coords.latitude;
      editFixedLng = pos.coords.longitude;
      if (statusEl) statusEl.textContent = 'Lokasi diperbarui. Tekan Simpan Perubahan untuk menyimpan.';
      document.getElementById('edit-location-box')?.classList.add('is-set');
    },
    () => { if (statusEl) statusEl.textContent = 'Gagal mengambil lokasi. Izinkan akses lokasi lalu coba lagi.'; },
    { enableHighAccuracy: true, timeout: 10000 }
  );
};

window.__updateEditCatPickerQuery = function (vendorId, value) {
  editCatPickerQuery = value;
  renderEditProfile(vendorId);
  requestAnimationFrame(() => {
    const el = document.getElementById('edit-cat-search');
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  });
};

function renderEditProfile(vendorId) {
  const v = vendors.find(v => v.id === vendorId);
  if (!v) return;

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
        <input id="edit-cat-search" type="text" value="${editCatPickerQuery.replace(/"/g, '&quot;')}" oninput="window.__updateEditCatPickerQuery('${vendorId}', this.value)" placeholder="🔍 Cari kategori, misal: rujak" style="margin-top:8px;" />
        <div style="text-align:left;font-size:11px;color:var(--text-faint);margin-top:6px;">Jualan lain yang belum ada di daftar? Tulis di sini (pisahkan koma)</div>
        <input id="edit-tags" type="text" list="tag-suggestions-list" value="${(v.custom_tags || []).join(', ').replace(/"/g, '&quot;')}" placeholder="misal: rujak serut, es duren" />
        <datalist id="tag-suggestions-list">${knownTagSuggestions.map(t => `<option value="${t.replace(/"/g, '&quot;')}"></option>`).join('')}</datalist>
        ${renderCategoryPickerGrouped(editCategories, 'window.__editToggleCategory', editCatPickerQuery)}

        ${renderJadwalFields({ p: 'edit', track: false, reminder: v.reminder_time ? v.reminder_time.slice(0, 5) : '', hasLoc: !!editFixedLat, buka24: !!v.buka_24jam, jamBuka: v.jam_buka ? v.jam_buka.slice(0, 5) : '', jamTutup: v.jam_tutup ? v.jam_tutup.slice(0, 5) : '', hari: v.hari_buka, tutupLibur: !!v.tutup_libur_nasional, schedule: v.schedule_text || '', locationNote: v.location_note || '', onToggle: 'window.__toggleEditBuka24', onCapture: 'window.__captureEditLocation' })}

        ${editFixedLat ? `
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12.5px;font-weight:700;margin-top:10px;background:var(--bg);border:1px solid var(--stroke);border-radius:12px;padding:12px;">
            <input id="edit-default-open" type="checkbox" ${v.default_open !== false ? 'checked' : ''} style="width:17px;height:17px;" />
            🟢 Tampilkan sebagai "Buka" di lokasi mangkal (kalau lagi tidak jualan sama sekali, misal cuti, matikan dulu)
          </label>
        ` : ''}

        <div style="text-align:left;background:var(--bg);border:1px solid var(--stroke);border-radius:12px;padding:12px;margin-top:10px;">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12.5px;font-weight:700;">
            <input id="edit-show-whatsapp" type="checkbox" ${v.show_whatsapp !== false ? 'checked' : ''} style="width:17px;height:17px;" />
            📱 Tampilkan nomor WhatsApp saya ke pembeli
          </label>
          <div style="font-size:10.5px;color:var(--text-faint);line-height:1.6;margin-top:8px;">
            ${vendorChatEnabled(v) ? 'Berapa pun pilihannya, pembeli tetap bisa hubungi Anda lewat <b>💬 Chat dalam app</b> — ini cuma soal apakah nomor WA Anda kelihatan juga atau tidak.' : 'WhatsApp adalah cara utama pembeli menghubungi Anda. Kalau nomor disembunyikan, pembeli tidak punya cara menghubungi Anda lewat JajanDekat.'} Bisa diubah kapan saja.
          </div>
          <div style="font-size:10.5px;line-height:1.6;margin-top:8px;padding-top:8px;border-top:1px dashed var(--stroke);">
            <b style="color:#25D366;">✅ Kalau nomor WA ditampilkan:</b> pembeli bisa langsung chat/telpon Anda di WA yang biasa dipakai, lebih cepat & familiar. <b style="color:#f87171;">Risikonya:</b> nomor Anda bisa disimpan/dihubungi orang di luar urusan jual-beli (promosi, spam, dll), dan riwayat chatnya bercampur dengan kontak pribadi Anda.
          </div>
          ${vendorChatEnabled(v) ? `
          <div style="font-size:10.5px;line-height:1.6;margin-top:6px;">
            <b style="color:#25D366;">✅ Kalau disembunyikan (chat app saja):</b> nomor pribadi Anda tetap privat, semua pesan jualan rapi di satu tempat (tab "💬 Pesan Pembeli"). <b style="color:#f87171;">Risikonya:</b> Anda perlu buka app ini untuk balas, tidak senotifikasi WA yang biasa Anda cek.
          </div>
          ` : `<div style="font-size:10.5px;line-height:1.6;margin-top:6px;"><b style="color:#f87171;">⚠️ Kalau disembunyikan:</b> pembeli tidak bisa menghubungi Anda lewat JajanDekat, jadi Anda bisa kehilangan calon pembeli. Disarankan tetap ditampilkan.</div>`}
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

window.__toggleEditBuka24 = function (checked) {
  const wrap = document.getElementById('edit-jam-wrap');
  if (wrap) wrap.style.display = checked ? 'none' : '';
  const hint = document.getElementById('edit-jam-hint');
  if (hint) hint.textContent = checked ? 'Tokomu tampil sebagai “Buka 24 jam” di hari buka.' : 'Isi jika hari dan jam bukamu biasanya tetap.';
};

// Tombol cepat di dashboard buat "Tutup Sementara"/"Buka Lagi" tanpa perlu buka Edit
// Profil — dipakai pas cuti, kehabisan stok, atau memang lagi nggak jualan sama sekali,
// biar toko dengan lokasi mangkal tetap nggak nyangkut "Buka" terus padahal tutup.
window.__toggleDefaultOpen = async function (vendorId) {
  const v = vendors.find(v => v.id === vendorId);
  if (!v) return;
  const newValue = v.default_open === false ? true : false;
  if (myVendorPin === null) {
    const enteredPin = prompt('Masukkan PIN akun Anda untuk konfirmasi:');
    if (enteredPin === null) return;
    const { data: ok } = await sb.rpc('verify_vendor_pin', { p_vendor_id: vendorId, p_pin: enteredPin.trim() });
    if (!ok) { alert('PIN salah.'); return; }
    myVendorPin = enteredPin.trim();
  }
  try {
    await sb.from('vendors').update({ default_open: newValue }).eq('id', vendorId);
    v.default_open = newValue;
    showToast(newValue ? 'Toko ditandai Buka lagi ✅' : 'Toko ditandai Tutup Sementara');
    renderPedagang();
  } catch (e) {
    alert('Gagal mengubah status: ' + (e.message || 'terjadi kesalahan.'));
  }
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
    const customTags = parseTagsInput(document.getElementById('edit-tags')?.value);
    const scheduleText = document.getElementById('edit-schedule')?.value.trim() || null;
    const locationNote = document.getElementById('edit-location-note')?.value.trim() || null;
    const defaultOpenEl = document.getElementById('edit-default-open');
    const defaultOpen = defaultOpenEl ? defaultOpenEl.checked : true;
    const buka24jam = document.getElementById('edit-buka24')?.checked || false;
    const jamBuka = buka24jam ? null : (document.getElementById('edit-jam-buka')?.value || null);
    const jamTutup = buka24jam ? null : (document.getElementById('edit-jam-tutup')?.value || null);
    const hariBuka = normalizeHariBuka(readHariFromDom('edit'));
    const tutupLibur = document.getElementById('edit-libur')?.checked || false;
    const { error } = await sb.rpc('update_vendor_profile', {
      p_vendor_id: vendorId, p_pin: myVendorPin || '', p_name: name,
      p_categories: editCategories, p_mode_icon: editModeIcon, p_whatsapp: whatsapp,
    });
    if (error) throw error;

    // Kolom reminder_time, show_whatsapp, custom_tags, lokasi mangkal, jadwal & status
    // buka diupdate terpisah (di luar RPC update_vendor_profile yang sudah ada).
    const { error: updateError } = await sb.from('vendors').update({
      reminder_time: reminderTime || null, show_whatsapp: showWhatsapp, custom_tags: customTags,
      fixed_lat: editFixedLat, fixed_lng: editFixedLng, schedule_text: scheduleText,
      location_note: locationNote, default_open: defaultOpen,
      jam_buka: jamBuka, jam_tutup: jamTutup, buka_24jam: buka24jam,
      hari_buka: hariBuka, tutup_libur_nasional: tutupLibur,
    }).eq('id', vendorId);
    if (updateError) throw updateError; // dulu gagal diam-diam (mis. izin kolom belum diberikan)
    if (customTags.length) logTagSuggestions(customTags.join(', ')); // tidak ditunggu, jangan blokir alur simpan

    const v = vendors.find(v => v.id === vendorId);
    v.name = name; v.categories = editCategories; v.category = editCategories[0] || null;
    v.mode_icon = editModeIcon; v.whatsapp = whatsapp; v.reminder_time = reminderTime || null;
    v.show_whatsapp = showWhatsapp; v.custom_tags = customTags;
    v.fixed_lat = editFixedLat; v.fixed_lng = editFixedLng; v.schedule_text = scheduleText;
    v.location_note = locationNote; v.default_open = defaultOpen;
    v.jam_buka = jamBuka; v.jam_tutup = jamTutup; v.buka_24jam = buka24jam;
    v.hari_buka = hariBuka; v.tutup_libur_nasional = tutupLibur;
    showToast('Profil toko berhasil diperbarui! ✅');
    renderPedagang();
  } catch (e) {
    errEl.textContent = 'Gagal menyimpan: ' + e.message;
  }
};

function renderPedagang() {
  refreshBell();
  if (!myVendorId) {
    main.innerHTML = `
      ${vendors.length ? `
        <div class="vendor-hero" style="text-align:left;">
          <div class="section-label" style="margin-top:0;">Sudah pernah daftar? Masuk ke akun lama</div>
          <div class="setup-form">
            <input id="pick-whatsapp" type="tel" value="${pickWhatsappValue.replace(/"/g, '&quot;')}" oninput="window.__updatePickWhatsapp(this.value)" placeholder="Nomor WhatsApp terdaftar, misal: 81234567890" />
            <div style="text-align:left;font-size:11px;color:var(--text-faint);margin-top:-6px;">Boleh diawali 0 atau langsung 8 — otomatis diubah jadi +62. Contoh: 081234567890 atau 81234567890.</div>
            <input id="pick-pin" type="tel" inputmode="numeric" maxlength="6" placeholder="Masukkan PIN akun ini" />
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
        <div class="reg-dots">
          ${[0, 1, 2, 3, 4].map(i => `<div class="reg-dot ${i === regStep ? 'active' : ''} ${i < regStep ? 'done' : ''}"></div>`).join('')}
        </div>
        <div id="reg-step-error" style="color:#f87171;font-size:12px;min-height:14px;text-align:center;margin-top:2px;"></div>
        <div class="reg-wizard">
          <div class="reg-wizard-track" id="reg-wizard-track" style="transform:translateX(-${regStep * 100}%);">

            <div class="reg-step">
              <div class="reg-step-title">1. Nama Usaha</div>
              <div class="reg-step-sub">Nama yang bakal dilihat pembeli di aplikasi</div>
              <input id="reg-name" type="text" value="${regNameValue.replace(/"/g, '&quot;')}" oninput="window.__updateRegField('name', this.value)" placeholder="Nama usaha, misal: Bakso Pak Slamet" />
              <div class="reg-nav-row"><button onclick="window.__regWizardGo(1)">Lanjut</button></div>
            </div>

            <div class="reg-step">
              <div class="reg-step-title">2. Jual Apa Saja?</div>
              <div class="reg-step-sub">Tap untuk pilih, tap lagi untuk batal — boleh lebih dari satu</div>
              ${selectedCategories.length ? `
                <div class="selected-cat-strip">
                  ${selectedCategories.map(label => `
                    <span class="selected-cat-pill">${label} <button type="button" onclick="window.__toggleCategory('${label.replace(/'/g, "\\'")}')">✕</button></span>
                  `).join('')}
                </div>
              ` : `<div style="font-size:11px;color:var(--text-faint);">Belum ada yang dipilih — cari atau tap ikon di bawah</div>`}
              <input id="reg-cat-search" type="text" value="${catPickerQuery.replace(/"/g, '&quot;')}" oninput="window.__updateCatPickerQuery(this.value)" placeholder="🔍 Cari kategori, misal: rujak" style="margin-top:8px;" />
              <div style="text-align:left;font-size:11px;color:var(--text-faint);margin-top:6px;">Jualan lain yang belum ada di daftar? Tulis di sini (pisahkan koma)</div>
              <input id="reg-tags" type="text" list="tag-suggestions-list" value="${regTagsValue.replace(/"/g, '&quot;')}" oninput="window.__updateRegField('tags', this.value)" placeholder="misal: rujak serut, es duren" />
              <datalist id="tag-suggestions-list">${knownTagSuggestions.map(t => `<option value="${t.replace(/"/g, '&quot;')}"></option>`).join('')}</datalist>
              ${renderCategoryPickerGrouped(selectedCategories, 'window.__toggleCategory', catPickerQuery)}
              <div class="reg-nav-row"><button class="reg-nav-back" onclick="window.__regWizardGo(-1)">Kembali</button><button onclick="window.__regWizardGo(1)">Lanjut</button></div>
            </div>

            <div class="reg-step">
              <div class="reg-step-title">3. Cara Jualan</div>
              <div class="reg-step-sub">Pilih 1 yang paling sesuai</div>
              <div class="cat-picker-grid">
                ${VENDOR_MODE_OPTIONS.map(m => `
                  <button type="button" class="cat-picker-item ${selectedModeIcon === m.icon ? 'picked' : ''}" onclick="window.__pickModeIcon('${m.icon}')">
                    <div class="cat-picker-icon-wrap"><img src="mode_icons/${m.icon}.png" alt="${m.label}" /></div>
                    <span>${m.label}</span>
                  </button>
                `).join('')}
              </div>
              <div class="reg-nav-row"><button class="reg-nav-back" onclick="window.__regWizardGo(-1)">Kembali</button><button onclick="window.__regWizardGo(1)">Lanjut</button></div>
            </div>

            <div class="reg-step">
              <div class="reg-step-title">4. Nomor & Keamanan Akun</div>
              <div class="reg-step-sub">Nomor WA jadi penanda akun, PIN buat masuk lagi nanti</div>
              <input id="reg-whatsapp" type="tel" value="${regWhatsappValue.replace(/"/g, '&quot;')}" oninput="window.__updateRegField('whatsapp', this.value)" placeholder="Nomor WhatsApp — wajib (contoh: 6281234567890)" />
              <input id="reg-pin" type="tel" inputmode="numeric" maxlength="6" value="${regPinValue.replace(/"/g, '&quot;')}" oninput="window.__updateRegField('pin', this.value)" placeholder="Buat PIN 6 digit (untuk keamanan akun)" />
              <div class="reg-nav-row"><button class="reg-nav-back" onclick="window.__regWizardGo(-1)">Kembali</button><button onclick="window.__regWizardGo(1)">Lanjut</button></div>
            </div>

            <div class="reg-step">
              <div class="reg-step-title">5. Lokasi &amp; jam buka</div>
              <div class="reg-step-sub">Semua bagian ini opsional dan bisa diubah nanti di Edit Profil Toko.</div>
              ${renderJadwalFields({ p: 'reg', track: true, reminder: regReminderValue, hasLoc: !!regFixedLat, buka24: regBuka24Value, jamBuka: regJamBukaValue, jamTutup: regJamTutupValue, hari: regHariBukaValue, tutupLibur: regTutupLiburValue, schedule: regScheduleValue, locationNote: regLocationNoteValue, onToggle: 'window.__toggleRegBuka24', onCapture: 'window.__captureRegLocation' })}
              <div class="reg-nav-row"><button class="reg-nav-back" onclick="window.__regWizardGo(-1)">Kembali</button><button data-reg-submit onclick="window.__registerVendor()">Daftar sekarang</button></div>
            </div>

          </div>
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
    ${renderBannerSlider(getRelevantBannersForVendor(v))}
    <div class="vendor-hero">
      <div class="vendor-hero-emoji" style="${vendorIconStyle(v)}">${vendorIconInner(v)}</div>
      <div class="vendor-hero-name">${v.name}</div>
      <div class="status-banner ${v.active ? 'active' : 'inactive'}">
        <div>
          <div class="status-banner-title">${v.active ? 'Sedang Jualan' : 'Belum Jualan Hari Ini'}</div>
          <div class="status-banner-sub">${v.active ? 'Lokasi & status kamu kelihatan sama pembeli · tutup otomatis jam ' + untilStr : 'Tekan tombol di bawah buat mulai jualan sekarang'}</div>
        </div>
        <div class="status-banner-icon">
          ${v.active ? `
            <svg width="52" height="52" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="10" y="24" width="34" height="20" rx="3" stroke="white" stroke-width="2.5"/>
              <path d="M10 30h34" stroke="white" stroke-width="2"/>
              <circle cx="18" cy="48" r="4" stroke="white" stroke-width="2.5"/>
              <circle cx="38" cy="48" r="4" stroke="white" stroke-width="2.5"/>
              <path d="M44 28h6l4 8v8h-4" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M6 18h6l3 6" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
            </svg>
          ` : `
            <svg width="52" height="52" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M40 12c-11 0-20 9-20 20s9 20 20 20c6 0 11.4-2.7 15-7-3 1.3-6.3 2-9.8 2-11 0-20-9-20-20 0-8.2 5-15.3 12-18.3-2.3-.5-4.7-.7-7.2-.7z" stroke="white" stroke-width="2.5" stroke-linejoin="round"/>
              <circle cx="46" cy="20" r="1.6" fill="white"/>
              <circle cx="50" cy="28" r="1.2" fill="white"/>
            </svg>
          `}
        </div>
      </div>

      ${v.fixed_lat ? `
        <div style="text-align:left;background:var(--bg);border:1px solid var(--stroke);border-radius:12px;padding:12px;margin-top:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
            <div>
              <div style="font-size:12.5px;font-weight:700;">📍 Lokasi mangkal tetap: ${v.default_open !== false ? '<span style="color:#3DDC97;">Buka</span>' : '<span style="color:#f87171;">Tutup sementara</span>'}</div>
              <div style="font-size:10.5px;color:var(--text-faint);margin-top:2px;">${v.default_open !== false ? 'Tokomu kelihatan di peta/daftar pembeli walau belum nyalain status di bawah.' : 'Tokomu disembunyikan dari peta/daftar sampai kamu buka lagi.'}</div>
              ${vendorScheduleLabel(v) ? `<div style="font-size:10.5px;color:var(--text-faint);margin-top:2px;">🕐 ${escapeHtml(vendorScheduleLabel(v))}</div>` : ''}
            </div>
            <button type="button" onclick="window.__toggleDefaultOpen('${v.id}')" style="flex-shrink:0;padding:8px 12px;border-radius:10px;border:none;font-weight:700;font-size:11.5px;${v.default_open !== false ? 'background:var(--surface-2);color:var(--text);' : 'background:#3DDC97;color:#fff;'}">${v.default_open !== false ? 'Tutup Sementara' : 'Buka Lagi'}</button>
          </div>
        </div>
      ` : ''}

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

    ${CHAT_DALAM_APP_AKTIF ? `
    <div class="vendor-hero" style="margin-top:14px; text-align:left;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <span style="font-size:20px;">💬</span>
        <div>
          <div style="font-family:'Poppins';font-weight:700;font-size:13.5px;">Pesan Pembeli</div>
          <div style="font-size:11px;color:var(--text-faint);margin-top:1px;">${vendorChatEnabled(v) ? 'Chat langsung dari pembeli lewat app, gratis, tanpa perlu nomor WA Anda.' : 'Chat dalam app khusus pedagang Premium. Upgrade Premium untuk menerima pesan langsung dari pembeli.'}</div>
        </div>
      </div>
      ${vendorChatEnabled(v) ? `<div id="vendor-chat-inbox"><div style="color:var(--text-faint);font-size:11.5px;">Memuat pesan...</div></div>` : ''}
    </div>
    ` : ''}

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
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <span style="font-size:20px;">📦</span>
        <div>
          <div style="font-family:'Poppins';font-weight:700;font-size:13.5px;">Kelola Produk</div>
          <div style="font-size:11px;color:var(--text-faint);margin-top:1px;">Tambahkan menu/dagangan Anda supaya pembeli bisa lihat sebelum datang</div>
        </div>
      </div>
      <button onclick="window.__openProductManager('${v.id}')" class="follow-btn" style="display:block;text-align:center;width:100%;padding:10px;background:var(--brand);color:#fff;border:none;">
        📦 Kelola Produk Saya
      </button>
    </div>

    <div class="vendor-hero" style="margin-top:14px; text-align:left;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <span style="font-size:20px;color:var(--navy);">✓</span>
        <div>
          <div style="font-family:'Poppins';font-weight:700;font-size:13.5px;">Verifikasi Toko</div>
          <div style="font-size:11px;color:var(--text-faint);margin-top:1px;">Toko terverifikasi tampil dengan badge navy dan lebih dipercaya pembeli</div>
        </div>
      </div>
      ${v.verification_status === 'verified' ? `
        <div style="background:var(--navy-dim);border:1px solid #B9C4DA;border-radius:12px;padding:10px 12px;font-size:12px;color:var(--navy);font-weight:700;">✓ Toko Anda sudah terverifikasi</div>
      ` : v.verification_status === 'pending' ? `
        <div style="background:#FFF3CD;border:1px solid #FFE08A;border-radius:12px;padding:10px 12px;font-size:12px;color:#8A6D00;">🕐 Pengajuan sedang ditinjau admin (biasanya 1-2 hari kerja)</div>
      ` : `
        ${v.verification_status === 'rejected' ? `<div style="background:#FEE2E2;border:1px solid #FCA5A5;border-radius:12px;padding:10px 12px;font-size:11.5px;color:#991B1B;margin-bottom:10px;">Pengajuan sebelumnya belum disetujui. Silakan ajukan ulang.</div>` : ''}
        <button onclick="window.__openVerificationForm('${v.id}')" class="follow-btn" style="display:block;text-align:center;width:100%;padding:10px;background:var(--surface-2);color:var(--text);">
          ✅ Ajukan Verifikasi Toko
        </button>
      `}
    </div>

    <div class="vendor-hero" id="vendor-promo-card" style="margin-top:14px; text-align:left;">
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
          <input id="promo-text-input" type="text" maxlength="80" oninput="window.__promoTextCount(this)" value="${(v.promo_text_pending || v.promo_text || '').replace(/"/g, '&quot;')}" placeholder="Tulis promo Anda di sini..." style="flex:1;" />
          <button onclick="window.__savePromoText('${v.id}')" style="width:auto;padding:0 14px;">💾</button>
        </div>
        <div id="promo-text-count" style="font-size:11px;margin-top:4px;color:${promoTextCountInfo((v.promo_text_pending || v.promo_text || '').length).color};">${promoTextCountInfo((v.promo_text_pending || v.promo_text || '').length).text}</div>
        <div id="promo-text-status">${promoTextStatusHtml(v)}</div>
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
    <button class="follow-btn" style="margin-top:8px;width:100%;padding:10px;background:var(--surface-2);color:var(--text);" onclick="window.__openFaqModal()">❓ Bantuan & FAQ</button>
    <button class="follow-btn" style="margin-top:8px;width:100%;padding:10px;" onclick="window.__logoutVendor()">Ganti akun pedagang</button>
    <a href="privacy.html" style="display:block;text-align:center;font-size:11px;color:var(--text-faint);margin-top:12px;text-decoration:underline;">Kebijakan Privasi</a>
    <a href="terms.html" style="display:block;text-align:center;font-size:11px;color:var(--text-faint);margin-top:6px;text-decoration:underline;">Ketentuan Layanan</a>
  `;

  initAnnSlider();
  renderVendorQr(v.id);
  loadMyReviews(v.id);

  if (v.is_premium) {
    sb.rpc('jd_count_followers', { p_vendor_id: v.id }).then(({ data }) => {
      const el = document.getElementById('premium-follow-count');
      if (el) el.textContent = (data && data[0] && data[0].total) ?? 0;
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

  const [{ data: recruitedVendors }, { data: followerCounts }] = await Promise.all([
    sb.from('vendors').select('id,name,activation_count').eq('referred_by_vendor_id', vendorId),
    sb.rpc('jd_count_followers', { p_vendor_id: vendorId }),
  ]);

  const validVendorRecruit = (recruitedVendors || []).find(r => r.activation_count >= 3);
  const vendorDone = !!validVendorRecruit;
  const referredBuyers = (followerCounts && followerCounts[0] && followerCounts[0].via_referral_count) ?? 0;
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

// ---------- PENANDA ULASAN RENDAH (tanpa PIN, dikenali dari perangkat pemilik toko) ----------
// Tanpa ini pedagang baru tahu ada ulasan rendah kalau membuka daftar ulasan & memasukkan PIN.
// Dicek saat app dibuka, saat kembali ke app, dan tiap 2 menit selama app terbuka: titik merah di tab Pedagang + toast.
let lastPendingNotified = 0;
let reviewAlertTimer = null;

function setPedagangDot(n) {
  const btn = document.getElementById('btn-pedagang');
  if (!btn) return;
  let dot = btn.querySelector('.review-dot');
  if (n > 0) {
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'review-dot';
      dot.style.cssText = 'display:inline-block;min-width:16px;height:16px;padding:0 4px;margin-left:6px;border-radius:999px;background:#ef4444;color:#fff;font-size:10px;font-weight:800;line-height:16px;text-align:center;';
      btn.appendChild(dot);
    }
    dot.textContent = n > 9 ? '9+' : String(n);
  } else if (dot) {
    dot.remove();
  }
}

async function checkMyPendingReviews() {
  if (!sb || !myVendorId) { lastPendingNotified = 0; setPedagangDot(0); return 0; }
  try {
    const { data: n, error } = await sb.rpc('count_my_pending_reviews');
    if (error) return 0;
    const cnt = n || 0;
    setPedagangDot(cnt);
    if (cnt > lastPendingNotified) {
      showToast(`Ada ${cnt} ulasan rendah yang perlu Anda tindaklanjuti. Buka tab Pedagang → Ulasan.`);
    }
    lastPendingNotified = cnt;
    return cnt;
  } catch (e) { console.error('Gagal cek ulasan rendah:', e); return 0; }
}

function startReviewAlertWatch() {
  checkMyPendingReviews();
  if (reviewAlertTimer) clearInterval(reviewAlertTimer);
  reviewAlertTimer = setInterval(checkMyPendingReviews, 120000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkMyPendingReviews(); });
}

async function loadMyReviews(vendorId) {
  const el = document.getElementById('my-reviews-list');
  if (!el) return;
  const revealBtn = (label, urgent) => `<button class="follow-btn" style="width:100%;padding:10px;${urgent ? 'background:#f87171;color:#fff;border-color:#f87171;' : ''}" onclick="window.__revealMyReviews('${vendorId}')">${label}</button>`;
  el.innerHTML = revealBtn('🔒 Tap untuk lihat ulasan (perlu PIN)', false);
  try {
    let n = 0;
    if (myVendorPin !== null) {
      // PIN sudah diketahui di sesi ini -> hitungan paling akurat (dicek di server dengan PIN)
      const { data, error } = await sb.rpc('count_pending_reviews', { p_vendor_id: vendorId, p_pin: myVendorPin });
      if (!error) { n = data || 0; setPedagangDot(n); lastPendingNotified = n; }
    } else {
      n = await checkMyPendingReviews(); // tanpa PIN, dikenali dari perangkat pemilik toko
    }
    if (n > 0) el.innerHTML = revealBtn(`⚠️ ${n} ulasan rendah perlu ditindaklanjuti — tap untuk lihat${myVendorPin === null ? ' (perlu PIN)' : ''}`, true);
  } catch (e) { console.error('Gagal menghitung ulasan rendah:', e); }
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
  // Yang perlu ditindaklanjuti ditaruh paling atas
  const rows = [...data].sort((a, b) => (b.status === 'pending_review') - (a.status === 'pending_review'));
  const pendingN = rows.filter(r => r.status === 'pending_review').length;
  const summary = pendingN > 0
    ? `<div style="font-size:11px;background:#fef2f2;color:#b91c1c;border-radius:10px;padding:8px 10px;margin-bottom:6px;line-height:1.5;">⚠️ <b>${pendingN} ulasan rendah</b> belum ditindaklanjuti. Ulasan 1–2★ tidak tampil publik dan tidak dihitung ke rating toko. Baca masukannya, perbaiki layanan Anda, lalu tandai selesai.</div>`
    : '';
  el.innerHTML = summary + rows.map(r => `
    <div style="padding:8px 0;border-bottom:1px solid var(--stroke);">
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="color:#F5A623;font-size:13px;">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span>
        ${r.status === 'pending_review' ? '<span style="font-size:9.5px;font-weight:700;color:#fff;background:#f87171;padding:2px 7px;border-radius:999px;">⚠️ ' + (CHAT_DALAM_APP_AKTIF ? 'Menunggu Anda balas' : 'Perlu ditindaklanjuti') + '</span>' : ''}
        ${r.status === 'resolved' ? '<span style="font-size:9.5px;font-weight:700;color:var(--aktif);background:var(--aktif-dim);padding:2px 7px;border-radius:999px;">✓ Sudah ditindaklanjuti</span>' : ''}
      </div>
      ${r.comment ? `<div style="font-size:12px;color:var(--text);margin-top:3px;">${escapeHtml(r.comment)}</div>` : ''}
      <div style="font-size:10px;color:var(--text-faint);margin-top:2px;">${new Date(r.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
      ${r.status === 'pending_review' ? `<button class="follow-btn" style="margin-top:6px;padding:6px 10px;font-size:11px;" onclick="window.__resolveReview('${vendorId}','${r.id}')">✓ Tandai sudah ditindaklanjuti</button>` : ''}
    </div>
  `).join('');
};

// Pengganti alur lama "balas lewat chat": pedagang menandai ulasan rendah sebagai sudah ditindaklanjuti (butuh PIN, dicek di server).
window.__resolveReview = async function (vendorId, reviewId) {
  if (myVendorPin === null) { showToast('Buka daftar ulasan lagi dan masukkan PIN dulu.'); return; }
  const { error } = await sb.rpc('resolve_review', { p_vendor_id: vendorId, p_pin: myVendorPin, p_review_id: reviewId });
  if (error) { showToast('Gagal menandai ulasan. Coba lagi.'); return; }
  showToast('Ulasan ditandai sudah ditindaklanjuti ✓');
  lastPendingNotified = 0;
  checkMyPendingReviews();
  window.__revealMyReviews(vendorId);
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
  const customTags = parseTagsInput(document.getElementById('reg-tags')?.value ?? regTagsValue);
  const errEl = document.getElementById('reg-error');

  if (!name) { errEl.textContent = 'Nama usaha wajib diisi.'; return; }
  if (categories.length === 0) { errEl.textContent = 'Pilih minimal 1 jenis jualan.'; return; }
  if (!modeIcon) { errEl.textContent = 'Pilih mode jualan Anda.'; return; }
  if (!whatsapp) { errEl.textContent = 'Nomor WhatsApp wajib diisi (jadi penanda akun Anda).'; return; }
  if (!/^\d{6}$/.test(pin)) { errEl.textContent = 'PIN wajib 6 angka.'; return; }

  // Cegah satu nomor WA didaftarkan dua kali
  const dupe = vendors.find(v => v.whatsapp === whatsapp);
  if (dupe) {
    errEl.textContent = `Nomor ini sudah terdaftar sebagai "${dupe.name}". Masuk pakai PIN di bawah, atau hubungi admin kalau lupa PIN.`;
    return;
  }

  // Nama sama tapi WA beda — boleh lanjut, tapi beri peringatan dulu (butuh klik sekali lagi)
  const nameDupe = vendors.find(v => v.name.trim().toLowerCase() === name.toLowerCase());
  if (nameDupe && !confirmedDuplicateName) {
    errEl.textContent = `Sudah ada pedagang bernama "${nameDupe.name}" terdaftar. Kalau ini memang usaha berbeda, tekan "Daftar sekarang" sekali lagi untuk lanjut.`;
    confirmedDuplicateName = true;
    return;
  }
  confirmedDuplicateName = false;

  errEl.textContent = 'Mendaftarkan...';
  isRegistering = true;
  const submitBtn = document.querySelector('[data-reg-submit]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Mendaftarkan…'; }
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
      .insert({ name, category, categories, emoji, mode_icon: modeIcon, whatsapp, pin, referred_by_vendor_id: referredByVendorId, region, reminder_time: reminderTime || null, custom_tags: customTags, fixed_lat: regFixedLat, fixed_lng: regFixedLng, schedule_text: regScheduleValue.trim() || null, location_note: regLocationNoteValue.trim() || null, buka_24jam: regBuka24Value, jam_buka: regBuka24Value ? null : (regJamBukaValue || null), jam_tutup: regBuka24Value ? null : (regJamTutupValue || null), hari_buka: normalizeHariBuka(regHariBukaValue), tutup_libur_nasional: regTutupLiburValue })
      .select('id,name,category,categories,emoji,mode_icon,whatsapp,show_whatsapp,active,active_until,lat,lng,photo_url,is_premium,premium_until,promo_text,reminder_time,created_at,custom_tags,fixed_lat,fixed_lng,schedule_text,location_note,default_open,jam_buka,jam_tutup,buka_24jam,hari_buka,tutup_libur_nasional')
      .single();

    if (customTags.length) logTagSuggestions(customTags.join(', ')); // tidak ditunggu, jangan blokir alur pendaftaran

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
    regNameValue = ''; regWhatsappValue = ''; regPinValue = ''; regReminderValue = ''; regTagsValue = ''; regStep = 0;
    regFixedLat = null; regFixedLng = null; regScheduleValue = ''; regLocationNoteValue = '';
    regJamBukaValue = '08:00'; regJamTutupValue = '21:00'; regBuka24Value = false;
    regHariBukaValue = [0, 1, 2, 3, 4, 5, 6]; regTutupLiburValue = false;
    Promise.resolve(sb.rpc('link_owner_device', { p_vendor_id: data.id, p_pin: pin, p_device_id: deviceId })).catch(() => {});
    ensurePushSubscription();
    renderPedagang();
  } catch (e) {
    console.error('Error saat daftar:', e);
    errEl.textContent = 'Gagal mendaftar: ' + (e && e.message ? e.message : 'terjadi kesalahan tidak diketahui') + '. Coba lagi.';
  } finally {
    isRegistering = false;
    const btn = document.querySelector('[data-reg-submit]');
    if (btn) { btn.disabled = false; btn.textContent = 'Daftar sekarang'; }
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
  // DITUNGGU (bukan fire-and-forget lagi): RLS chat butuh owner_device_id sudah kesimpan
  // dulu sebelum refreshMyChatThreads() jalan, kalau tidak, hasilnya kosong (diblokir RLS)
  // dan notifikasi chat toko ini nggak bakal bunyi sampai logout-login ulang.
  try { await sb.rpc('link_owner_device', { p_vendor_id: myVendorId, p_pin: enteredPin, p_device_id: deviceId }); } catch (e) {}
  ensurePushSubscription();
  refreshMyChatThreads(); // sekarang login sbg pedagang -> pantau thread milik toko ini
  renderPedagang();
};

window.__logoutVendor = function () {
  myVendorId = null;
  myVendorPin = null;
  lastPendingNotified = 0;
  setPedagangDot(0);
  localStorage.removeItem('jd_my_vendor_id');
  refreshMyChatThreads(); // balik ke pantau thread milik device ini sbg pembeli
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

// Supaya lawan chat tetap kebagian notifikasi walau app-nya lagi ditutup/di-background,
// bukan cuma sound/toast di dalam app (yang cuma jalan selagi app-nya lagi kebuka).
// CATATAN: ini butuh Edge Function 'send-chat-push' di project Supabase-nya (dibuat
// terpisah, polanya sama seperti 'send-vendor-push' yang sudah ada) — fungsi ini cuma
// memanggilnya, jadi kalau belum dibuat, panggilan ini gagal diam-diam (tidak mengganggu
// pengiriman pesannya sendiri, yang sudah pasti berhasil duluan).
async function sendChatPushNotification(threadId, sender, text) {
  try {
    await sb.functions.invoke('send-chat-push', { body: { thread_id: threadId, sender, message: text } });
  } catch (e) {
    console.error('Gagal kirim push chat (cek apakah Edge Function send-chat-push sudah dibuat):', e);
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
      await setVendorStatus(v.id, false);
      // Foto TIDAK dihapus di sini lagi — biar pas nanti "mulai jualan" lagi tanpa pilih
      // foto baru, tampilannya tetap pakai foto asli terakhir (bukan balik ke ikon aplikasi).
      // Storage tetap aman karena uploadVendorPhoto menimpa file lama, bukan menumpuk.
      v.active = false; v.active_until = null;
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
      <div id="review-visibility-note" style="font-size:11px;color:var(--text-faint);margin-bottom:14px;">${vendorName} · Rating 3★ ke atas akan tampil publik di kartu pedagang. Rating di bawah 3★ tidak langsung publik — dikirim dulu sebagai masukan ke pedagang.</div>
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
  const note = document.getElementById('review-visibility-note');
  if (note) {
    note.innerHTML = n >= 3
      ? `Rating ${n}★ akan tampil publik di kartu pedagang.`
      : (CHAT_DALAM_APP_AKTIF ? `Rating ${n}★ tidak langsung publik — dikirim dulu sebagai masukan ke pedagang lewat chat.` : `Rating ${n}★ tidak tampil publik — masukanmu dikirim privat ke pedagang lewat dashboard-nya.`);
  }
};

window.__submitReview = async function (vendorId) {
  const comment = document.getElementById('review-comment').value.trim();
  const rating = reviewModalRating;
  try {
    const { data: reviewId, error } = await sb.rpc('submit_review', { p_vendor_id: vendorId, p_device_id: deviceId, p_rating: rating, p_comment: comment || null });
    if (error) throw error;

    if (rating < 3 && CHAT_DALAM_APP_AKTIF) {
      // Rating rendah: teruskan otomatis sebagai pesan nasihat ke chat pedagang, dan kaitkan ulasan ke thread-nya
      try {
        const threadId = await getOrCreateChatThread(vendorId, deviceId);
        const noticeText = `⚠️ Pembeli memberi rating ${rating}★${comment ? ': ' + comment : ' tanpa komentar.'}\nBalas pesan ini kalau sudah ditindaklanjuti, ya.`;
        const { data: msgData } = await sb.from('chat_messages')
          .insert({ thread_id: threadId, sender: 'buyer', message: noticeText })
          .select('*').single();
        await sb.from('chat_threads').update({ last_message_at: new Date().toISOString(), last_message_preview: noticeText.slice(0, 80) }).eq('id', threadId);
        if (reviewId) await sb.rpc('link_review_thread', { p_review_id: reviewId, p_device_id: deviceId, p_thread_id: threadId });
      } catch (e2) {
        console.error('Gagal meneruskan rating rendah ke chat:', e2); // ulasan tetap tersimpan meski ini gagal
      }
    }

    document.getElementById('review-modal-overlay').remove();
    showToast(rating < 3 ? 'Masukan Anda dikirim ke pedagang. Terima kasih! 🙏' : 'Terima kasih atas ulasannya! ⭐');
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
  brandTapZone.addEventListener('click', async () => {
    tapCount++;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { tapCount = 0; }, 1500);
    if (tapCount >= 5) {
      tapCount = 0;
      const pw = prompt('Password admin:');
      if (pw === null) return;
      if (!pw) { alert('Password salah.'); return; }
      // Password diperiksa di server (Edge Function), tidak lagi dibandingkan di browser
      try {
        const { data, error } = await sb.functions.invoke('admin-action', { body: { password: pw, action: 'verify_admin' } });
        if (error || !data || !data.ok) {
          const status = error && error.context && error.context.status;
          alert(status === 401 || (data && !data.ok) ? 'Password salah.' : 'Tidak bisa terhubung ke server. Coba lagi.');
          return;
        }
        isSuperAdmin = true;
        adminPasswordCache = pw;
        renderAdminDashboard();
      } catch (e) {
        console.error(e);
        alert('Tidak bisa terhubung ke server. Coba lagi.');
      }
    }
  });
}

window.__requestPremium = async function (vendorId) {
  const v = vendors.find(x => x.id === vendorId);
  if (!v) return;
  try {
    // vendor_requests (tabel lama) sudah dikunci total — request sekarang lewat upgrade_requests,
    // ditulis via edge function admin-action (action ini tidak butuh password admin).
    await sb.functions.invoke('admin-action', { body: { action: 'create_upgrade_request', vendor_id: vendorId, request_type: 'premium' } });
  } catch (e) { /* tetap lanjut buka WA walau insert gagal */ }
  const msg = 'Halo, saya ' + v.name + ' (ID: ' + v.id + ') mau upgrade ke Premium JajanDekat.';
  window.open(`https://wa.me/${ADMIN_WHATSAPP}?text=${encodeURIComponent(msg)}`, '_blank');
};

window.__requestPromo = async function (vendorId) {
  const v = vendors.find(x => x.id === vendorId);
  if (!v) return;
  try {
    await sb.functions.invoke('admin-action', { body: { action: 'create_upgrade_request', vendor_id: vendorId, request_type: 'promo' } });
  } catch (e) { /* tetap lanjut buka WA walau insert gagal */ }
  const msg = 'Halo, saya ' + v.name + ' (ID: ' + v.id + ') mau pasang Promosi Lokal di JajanDekat.';
  window.open(`https://wa.me/${ADMIN_WHATSAPP}?text=${encodeURIComponent(msg)}`, '_blank');
};

// Status review teks promo untuk pedagang: menunggu persetujuan admin / ditolak (dengan alasan)
function promoTextStatusHtml(v) {
  if (v.promo_text_pending) {
    return `<div style="font-size:11px;margin-top:6px;padding:6px 8px;border-radius:8px;background:#FFF4DC;color:#9A6200;">⏳ Menunggu persetujuan admin, belum tampil ke pembeli.${v.promo_text ? ` Yang tampil sekarang: “${escapeHtml(v.promo_text)}”` : ''}</div>`;
  }
  if (v.promo_text_note) {
    return `<div style="font-size:11px;margin-top:6px;padding:6px 8px;border-radius:8px;background:#FDECEC;color:#B42318;">❌ ${escapeHtml(v.promo_text_note)}</div>`;
  }
  return '';
}

const PROMO_TEXT_IDEAL = 30; // di kartu kecil, ±30 karakter tampil utuh (lebih dari itu dipotong di baris ke-2)
function promoTextCountInfo(n) {
  return n > PROMO_TEXT_IDEAL
    ? { color: '#C77F0A', text: `${n}/80 karakter · di atas ${PROMO_TEXT_IDEAL} karakter bisa terpotong di kartu` }
    : { color: 'var(--text-faint)', text: `${n}/80 karakter · ideal maks ${PROMO_TEXT_IDEAL} supaya tampil utuh di kartu` };
}
window.__promoTextCount = function (input) {
  const el = document.getElementById('promo-text-count');
  if (!el) return;
  const info = promoTextCountInfo(input.value.length);
  el.textContent = info.text;
  el.style.color = info.color;
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
    let pending = false;
    if (v) {
      const { data: fresh } = await sb.from('vendors').select('promo_text,promo_text_pending,promo_text_note').eq('id', vendorId).maybeSingle();
      if (fresh) Object.assign(v, fresh); else v.promo_text = text || null;
      pending = !!v.promo_text_pending;
      const st = document.getElementById('promo-text-status');
      if (st) st.innerHTML = promoTextStatusHtml(v);
    }
    errEl.textContent = '';
    showToast(pending ? 'Terkirim ke admin, menunggu persetujuan ⏳' : 'Tulisan promo disimpan! ✅');
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
      <button class="admin-tab" data-tab="tags" onclick="window.__adminSwitchTab('tags')">🏷️ Ikon</button>
      <button class="admin-tab" data-tab="announcements" onclick="window.__adminSwitchTab('announcements')">📢 Pengumuman</button>
      <button class="admin-tab" data-tab="banners" onclick="window.__adminSwitchTab('banners')">🖼️ Banner Slider</button>
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

    <div class="admin-panel" data-panel="tags" style="display:none;">
      <div style="font-size:11px;color:var(--text-faint);margin-bottom:10px;">Kata kunci jualan yang diketik pedagang sendiri (belum ada kategorinya). Makin sering dipakai, makin layak dibuatkan ikon resmi.</div>
      <div id="admin-tags" class="vendor-list"><div style="color:var(--text-faint);font-size:11.5px;">Memuat...</div></div>
    </div>

    <div class="admin-panel" data-panel="banners" style="display:none;">
      <details id="bn-guide" open class="vendor-hero" style="text-align:left;margin-bottom:10px;padding:14px 16px;">
        <summary style="cursor:pointer;font-weight:700;font-size:13px;">📐 Panduan ukuran banner slider — baca sebelum membuat</summary>
        <div style="font-size:11.5px;line-height:1.55;color:var(--text-dim);margin-top:8px;">
          <div><b>Ukuran file:</b> 1000 × 375 px (rasio 8:3). Di HP 6,5" tampil sekitar 324 × 120 px. Gambar ukuran lain otomatis dipotong &amp; dikecilkan, tapi hasil terbaik kalau desain sudah 8:3.</div>
          <div style="margin-top:6px;"><b>Area aman:</b> teks, logo, dan tombol min. 16 px dari tepi layar ≈ <b>50 px</b> dari tiap sisi di file 1000 px (kotak putus-putus di pratinjau).</div>
          <div style="margin-top:6px;"><b>Teks di gambar:</b> judul maks. 2 baris, deskripsi maks. 2 baris, 1 tombol. Tinggi huruf terkecil min. ±38 px di file (≈ 12 px di layar). Taruh teks di kiri (±55% lebar), ilustrasi di kanan.</div>
          <div style="margin-top:6px;"><b>Jumlah &amp; urutan:</b> hanya 4 banner pertama (urut ▲▼) yang tampil per audiens; auto-slide 5,5 detik. Banner baru masuk di urutan terakhir.</div>
          <div style="margin-top:6px;"><b>Judul</b> hanya untuk admin &amp; deskripsi gambar, tidak tampil di slider. <b>Jadwal</b> kosong = langsung tayang / tanpa batas akhir. <b>Tujuan klik</b>: pilih dari daftar (Promosi Lokal, WhatsApp Admin, halaman app, pedagang/artikel tertentu, atau link sendiri) — tidak perlu mengetik kode tautan. Pilihan "Untuk pedagang" otomatis menyarankan audiens yang cocok.</div>
        </div>
      </details>
      <div class="vendor-hero" style="text-align:left;margin-bottom:10px;">
        <input id="bn-title" type="text" maxlength="80" placeholder="Judul banner (wajib, maks. 80 karakter — tidak tampil di slider)" style="width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-size:12.5px;" />
        <input type="file" id="bn-image-input" accept="image/*" style="display:none" onchange="window.__onBannerImageSelected(event)" />
        <div id="bn-image-zone" onclick="document.getElementById('bn-image-input').click()" style="margin-top:8px;border:1.5px dashed var(--stroke);border-radius:12px;padding:12px;text-align:center;color:var(--text-dim);font-size:12px;cursor:pointer;">📷 Pilih gambar banner (wajib)</div>
        <div id="bn-image-preview"></div>
        <div style="margin-top:10px;font-size:11px;font-weight:700;color:var(--text-dim);">Tujuan saat banner diketuk</div>
        <select id="bn-dest" onchange="window.__bnDestChange()" style="width:100%;box-sizing:border-box;margin-top:4px;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-size:12.5px;">${bnDestOptionsHtml()}</select>
        <div id="bn-dest-extra" style="margin-top:6px;"></div>
        <div id="bn-dest-preview" style="font-size:10.5px;color:var(--text-faint);margin-top:4px;word-break:break-all;"></div>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <select id="bn-audience" onchange="bnAudienceTouched = true" style="flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-size:12px;">
            <option value="semua">Semua</option>
            <option value="pembeli">Pembeli</option>
            <option value="pedagang">Pedagang</option>
          </select>
          <select id="bn-region" style="flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-size:12px;">
            ${regionOptionsHtml('🌏 Zona: Nasional (semua wilayah)')}
          </select>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;align-items:flex-end;">
          <label style="flex:1;min-width:0;font-size:10.5px;color:var(--text-faint);">Mulai tayang (kosong = langsung)
            <input id="bn-start" type="datetime-local" style="width:100%;box-sizing:border-box;margin-top:2px;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:8px;color:var(--text);font-size:12px;" /></label>
          <label style="flex:1;min-width:0;font-size:10.5px;color:var(--text-faint);">Berakhir (kosong = tanpa batas)
            <input id="bn-end" type="datetime-local" style="width:100%;box-sizing:border-box;margin-top:2px;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:8px;color:var(--text);font-size:12px;" /></label>
        </div>
        <button onclick="window.__adminCreateBanner()" style="margin-top:12px;width:100%;background:var(--brand);border:none;border-radius:12px;padding:12px;font-family:inherit;font-weight:700;font-size:13px;color:#fff;cursor:pointer;">🖼️ Tambah ke Slider</button>
        <div id="bn-error" style="color:#f87171;font-size:12px;margin-top:6px;"></div>
      </div>
      <div id="admin-banners-list" class="vendor-list"><div style="color:var(--text-faint);font-size:11.5px;">Memuat banner...</div></div>
    </div>

    <div class="admin-panel" data-panel="announcements" style="display:none;">
      <div class="vendor-hero" style="text-align:left;margin-bottom:10px;">
        <textarea id="ann-message" rows="3" placeholder="Isi pengumuman..." style="width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-family:inherit;font-size:12.5px;resize:vertical;"></textarea>
        <input id="ann-link" type="text" placeholder="Link (opsional) — https://... atau tujuan dalam app: ?artikel=slug / ?vendor=ID" style="width:100%;box-sizing:border-box;margin-top:8px;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-size:12.5px;" />
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
          <select id="ann-region" style="flex:1;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-size:12px;">
            ${regionOptionsHtml('🌏 Zona: Nasional (semua wilayah)')}
          </select>
        </div>
        <div style="font-size:10px;color:var(--text-faint);margin-top:4px;">Zona memakai daftar wilayah resmi (provinsi → kabupaten/kota → kecamatan). Pengumuman zona hanya tampil &amp; terkirim ke perangkat yang wilayahnya diketahui berada di dalam zona itu; pembeli yang belum membagikan lokasi hanya menerima yang Nasional.</div>
        <label style="display:flex;gap:8px;align-items:flex-start;margin-top:10px;font-size:12px;color:var(--text-dim);cursor:pointer;">
          <input type="checkbox" id="ann-send-push" style="margin-top:2px;" />
          <span>📣 Kirim juga sebagai notifikasi push (ada pratinjau jumlah penerima sebelum benar-benar dikirim)</span>
        </label>
        <div style="font-size:10.5px;color:var(--text-dim);margin-top:8px;">🔔 Pengumuman tampil di <b>Kotak Notifikasi</b> (ikon lonceng), bukan di beranda. Untuk gambar promosi di beranda, pakai menu <b>Banner</b>.</div>
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

  const { data: followStats } = await sb.rpc('jd_admin_follow_stats');
  const totalFollows = (followStats && followStats[0] && followStats[0].total_follows) ?? 0;
  const uniqueBuyers = (followStats && followStats[0] && followStats[0].unique_buyers) ?? 0;
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
  loadAdminBanners();
  loadAdminArticles();
  loadAdminTagSuggestions();

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
        ${v.promo_until && new Date(v.promo_until) > new Date() ? `<button class="admin-cancel-link" style="color:var(--brand);" onclick="window.__adminPromoToBanner('${v.id}')">🖼️ Jadikan banner</button><button class="admin-cancel-link" onclick="window.__adminCancelPromo('${v.id}')">Cabut Promo</button>` : ''}
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

function renderPromoReviewCardHtml(v) {
  const active = v.promo_until && new Date(v.promo_until) > new Date();
  return `
    <div class="vendor-card" style="flex-direction:column;align-items:stretch;gap:6px;border-color:#F5A623;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span style="font-weight:700;font-size:12.5px;">${escapeHtml(v.name)}</span>
        <span style="font-size:9.5px;padding:3px 8px;border-radius:999px;background:#FEF3C7;color:#92400E;white-space:nowrap;">📝 Review teks promo</span>
      </div>
      <div style="font-size:12.5px;font-weight:700;color:#C77F0A;">“${escapeHtml(v.promo_text_pending)}”</div>
      <div style="font-size:10.5px;color:var(--text-faint);">${v.promo_text ? `Yang tampil sekarang: “${escapeHtml(v.promo_text)}”` : 'Belum ada teks yang tampil.'} · ${active ? 'Promo sedang aktif' : 'Promo belum/tidak aktif'}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;">
        <button class="follow-btn" onclick="window.__adminReviewPromoText('${v.id}','approve')">✓ Setujui</button>
        <button class="follow-btn" style="color:#f87171;" onclick="window.__adminReviewPromoText('${v.id}','reject')">✕ Tolak</button>
      </div>
    </div>`;
}

async function callAdminPromo(action, vendorId, extra = {}) {
  const { data, error } = await sb.functions.invoke('admin-promo', { body: { password: adminPasswordCache, action, vendor_id: vendorId, ...extra } });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (e) {}
    throw new Error(msg);
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

window.__adminReviewPromoText = async function (vendorId, decision) {
  let note = '';
  if (decision === 'reject') {
    const input = prompt('Alasan penolakan (dibaca pedagang, boleh dikosongkan):', '');
    if (input === null) return;
    note = input.trim();
  }
  try {
    await callAdminPromo(decision === 'approve' ? 'approve_promo_text' : 'reject_promo_text', vendorId, { note });
    showToast(decision === 'approve' ? 'Teks promo disetujui ✅' : 'Teks promo ditolak');
    loadAdminRequests();
  } catch (e) {
    alert('Gagal memproses teks promo: ' + e.message);
  }
};

async function loadAdminRequests() {
  const el = document.getElementById('admin-requests');
  if (!el) return;
  try {
    // vendor_requests (tabel lama) sudah dikunci total — data sekarang di upgrade_requests,
    // dibaca lewat edge function admin-action (pakai service role + password admin).
    const { data, error } = await sb.functions.invoke('admin-action', { body: { password: adminPasswordCache, action: 'list_upgrade_requests' } });
    if (error) throw error;
    if (data && data.error) throw new Error(data.error);
    const rows = (data.requests || []).filter(r => r.status === 'pending');
    const { data: pendTexts } = await sb.from('vendors').select('id,name,whatsapp,category,promo_text,promo_text_pending,promo_until').not('promo_text_pending', 'is', null).order('name');
    const textRows = pendTexts || [];
    if (rows.length === 0 && textRows.length === 0) { el.innerHTML = '<div style="color:var(--text-faint);font-size:11.5px;">Belum ada permintaan masuk. 👍</div>'; return; }
    el.innerHTML = textRows.map(renderPromoReviewCardHtml).join('') + rows.map(r => {
      const v = r.vendors;
      if (!v) return '';
      const label = r.request_type === 'premium' ? '⭐ Upgrade Premium' : '🔥 Pasang Promo Lokal';
      return `
      <div class="vendor-card" style="flex-direction:column;align-items:stretch;gap:6px;border-color:#F5A623;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:700;font-size:12.5px;">${v.name}</span>
          <span style="font-size:9.5px;padding:3px 8px;border-radius:999px;background:#FEF3C7;color:#92400E;">${label}</span>
        </div>
        <div style="font-size:11px;color:var(--text-dim);" class="mono">WA: ${v.whatsapp || '-'} · ${v.category || '-'}</div>
        <div style="font-size:9.5px;color:var(--text-faint);">${new Date(r.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;">
          ${r.request_type === 'premium' ? `
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
    await sb.functions.invoke('admin-action', { body: { password: adminPasswordCache, action: 'update_upgrade_request_status', request_id: requestId, status: 'selesai' } });
    renderAdminDashboard();
  } catch (e) {
    alert('Gagal memproses permintaan: ' + e.message);
  }
};

window.__dismissVendorRequest = async function (requestId) {
  try {
    await sb.functions.invoke('admin-action', { body: { password: adminPasswordCache, action: 'update_upgrade_request_status', request_id: requestId, status: 'selesai' } });
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

const ANN_AUDIENCE_LABEL = { semua: 'Semua', premium: 'Pedagang Premium', biasa: 'Pedagang Biasa', pembeli: 'Pembeli' };
const ANN_LEVEL_LABEL = { provinsi: 'Provinsi', kabupaten: 'Kabupaten/Kota', kecamatan: 'Kecamatan' };

function annZoneLabel(a) {
  if (!a.zone_level || a.zone_level === 'nasional') return 'Nasional';
  const reg = a.region_id ? regionsById.get(a.region_id) : null;
  const name = reg ? reg.name : a.zone_value;
  return `${name || '?'} (${ANN_LEVEL_LABEL[a.zone_level] || a.zone_level})`;
}

async function loadAdminAnnouncements() {
  const el = document.getElementById('admin-announcements');
  if (!el) return;
  try {
    const res = await callAdminAction('list_announcements');
    const data = (res.announcements || []).filter(a => a.active);
    if (data.length === 0) { el.innerHTML = '<div style="color:var(--text-faint);font-size:11.5px;">Belum ada pengumuman aktif.</div>'; return; }
    const fmt = (d) => new Date(d).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    el.innerHTML = data.map(a => `
      <div class="vendor-card" style="flex-direction:column;align-items:stretch;gap:6px;">
        ${a.image_url ? `<img src="${a.image_url}" style="width:100%;border-radius:10px;" />` : ''}
        <div style="font-size:12px;white-space:pre-wrap;">${escapeHtml(a.message)}</div>
        ${a.link ? `<div style="font-size:10px;color:var(--text-faint);word-break:break-all;">🔗 ${escapeHtml(a.link)}</div>` : ''}
        <div style="font-size:10px;color:var(--text-faint);">
          🎯 ${ANN_AUDIENCE_LABEL[a.audience] || a.audience} · 📍 ${escapeHtml(annZoneLabel(a))}
        </div>
        <div style="font-size:10px;color:${a.push_sent_at ? 'var(--brand)' : 'var(--text-faint)'};">${a.push_sent_at ? '📣 Push terkirim ' + fmt(a.push_sent_at) : '🔕 Belum dikirim sebagai push'}</div>
        <div style="font-size:9.5px;color:var(--text-faint);">${fmt(a.created_at)}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="follow-btn" onclick="window.__adminBroadcastPush('announcement','${a.id}')">📣 ${a.push_sent_at ? 'Kirim Ulang Push' : 'Kirim Push'}</button>
          <button class="follow-btn" style="color:#f87171;" onclick="window.__adminDeactivateAnnouncement('${a.id}')">✕ Nonaktifkan</button>
        </div>
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
  const regionId = document.getElementById('ann-region').value || null;
  const sendPush = !!(document.getElementById('ann-send-push') && document.getElementById('ann-send-push').checked);

  if (!message) { errEl.textContent = 'Isi pengumuman wajib diisi.'; return; }
  if (link && !/^https:\/\//.test(link) && !/^\?(vendor|artikel)=[A-Za-z0-9_%.-]+$/.test(link)) {
    errEl.textContent = 'Link harus diawali https:// atau berupa tujuan dalam app, misal ?artikel=slug-artikel atau ?vendor=ID.';
    return;
  }

  errEl.textContent = 'Menyimpan...';
  try {
    let imageUrl = null;
    if (pendingAnnImageFile) {
      imageUrl = await uploadAnnouncementImage(pendingAnnImageFile);
    }
    const res = await callAdminAction('create_announcement', undefined, {
      message, link: link || null, image_url: imageUrl, audience, region_id: regionId,
    });

    pendingAnnImageFile = null; pendingAnnImagePreview = null;
    document.getElementById('ann-message').value = '';
    document.getElementById('ann-link').value = '';
    document.getElementById('ann-region').value = '';
    const pushBox = document.getElementById('ann-send-push');
    if (pushBox) pushBox.checked = false;
    const zone = document.getElementById('ann-image-zone');
    if (zone) zone.innerHTML = '📷 Tambah gambar (opsional)';
    errEl.textContent = '';
    showToast('Pengumuman dibuat! 📢');
    announcements = await fetchAnnouncements();
    await loadAdminAnnouncements();
    if (sendPush && res && res.id) await window.__adminBroadcastPush('announcement', res.id);
  } catch (e) {
    errEl.textContent = 'Gagal menyimpan: ' + e.message;
  }
};

window.__adminDeactivateAnnouncement = async function (id) {
  if (!confirm('Nonaktifkan pengumuman ini?')) return;
  try {
    await callAdminAction('deactivate_announcement', undefined, { announcement_id: id });
    announcements = await fetchAnnouncements();
    loadAdminAnnouncements();
  } catch (e) {
    alert('Gagal menonaktifkan: ' + e.message);
  }
};

// ---------- ADMIN: BANNER SLIDER (tabel `banners` lewat Edge Function admin-banners) ----------
// Auto-resize: gambar apa pun dipotong ke rasio 8:3 (titik fokus bisa digeser), dikecilkan maks. 1000 px lebar
// (tidak diperbesar), lalu disimpan sebagai JPG.
const ANN_BANNER_W = 1000;
const ANN_BANNER_H = 375;
const ANN_BANNER_RATIO = 8 / 3;
const BANNER_LINK_OK = [/^https:\/\/[^\s]+$/i, /^\?vendor=[A-Za-z0-9_-]{8,64}$/, /^\?artikel=[A-Za-z0-9_%.-]{1,120}$/, /^app:(daftar|promo|peta|cari|favorit|terdekat|artikel)$/];
const BANNER_AUDIENCE_LABEL = { semua: 'Semua', pembeli: 'Pembeli', pedagang: 'Pedagang' };
let pendingBnImageEl = null;   // gambar asli yang sudah dimuat (untuk pratinjau & potong ulang)
let pendingBnImageFocus = 0.5; // 0 = atas/kiri, 0.5 = tengah, 1 = bawah/kanan
let adminBannersData = [];

function annLoadImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('File gambar tidak bisa dibaca.'));
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Format gambar tidak didukung.'));
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function annBannerCrop(img, focus) {
  const sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
  let cw, ch;
  if (sw / sh > ANN_BANNER_RATIO) { ch = sh; cw = sh * ANN_BANNER_RATIO; } // terlalu lebar → potong kiri-kanan
  else { cw = sw; ch = sw / ANN_BANNER_RATIO; }                            // terlalu tinggi → potong atas-bawah
  return { sx: (sw - cw) * focus, sy: (sh - ch) * focus, cw, ch, sw, sh, keep: (cw * ch) / (sw * sh), cutsSides: sw / sh > ANN_BANNER_RATIO };
}

function annBannerCanvas(img, focus, outW) {
  const r = annBannerCrop(img, focus);
  const w = Math.max(1, Math.round(outW));
  const h = Math.max(1, Math.round(w / ANN_BANNER_RATIO));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); // PNG transparan → latar putih (JPG tidak mengenal transparan)
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, r.sx, r.sy, r.cw, r.ch, 0, 0, w, h);
  return canvas;
}

function annBannerBlob(img, focus) {
  const r = annBannerCrop(img, focus);
  const canvas = annBannerCanvas(img, focus, Math.min(ANN_BANNER_W, r.cw));
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('Gagal memproses gambar.')), 'image/jpeg', 0.82));
}

async function uploadBannerImage(imgEl, focus) {
  // Folder banners/ di bucket vendor-photos — Edge Function admin-banners hanya menerima URL dari folder ini.
  const blob = await annBannerBlob(imgEl, focus);
  const path = `banners/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const { error } = await sb.storage.from('vendor-photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;
  const { data } = sb.storage.from('vendor-photos').getPublicUrl(path);
  return { url: data.publicUrl, path };
}

function renderBnImagePreview() {
  const box = document.getElementById('bn-image-preview');
  if (!box) return;
  if (!pendingBnImageEl) { box.innerHTML = ''; return; }
  const img = pendingBnImageEl;
  const r = annBannerCrop(img, pendingBnImageFocus);
  const lost = Math.round((1 - r.keep) * 100);
  const outW = Math.round(Math.min(ANN_BANNER_W, r.cw));
  const outH = Math.round(outW / ANN_BANNER_RATIO);
  const dataUrl = annBannerCanvas(img, pendingBnImageFocus, Math.min(480, r.cw)).toDataURL('image/jpeg', 0.85);
  const warns = [];
  if (lost > 30) warns.push(`⚠️ ±${lost}% gambar terpotong (rasio asli ${(r.sw / r.sh).toFixed(2)}:1). Hasil terbaik kalau desain sudah 1000 × 375 px.`);
  if (r.cw < 800) warns.push(`⚠️ Gambar kecil (${Math.round(r.cw)} px lebar setelah dipotong) — bisa terlihat buram di layar HP yang tajam.`);
  const canShift = lost >= 1;
  const lbl = r.cutsSides ? ['Kiri', 'Tengah', 'Kanan'] : ['Atas', 'Tengah', 'Bawah'];
  const focusBtn = (val, text) => `<button type="button" class="follow-btn" onclick="window.__bnImageFocus(${val})" style="${pendingBnImageFocus === val ? 'border-color:var(--brand);color:var(--brand);font-weight:700;' : ''}">${text}</button>`;
  box.innerHTML = `
    <div style="position:relative;aspect-ratio:8/3;border-radius:16px;overflow:hidden;margin-top:8px;background:var(--surface-2);">
      <img src="${dataUrl}" alt="" style="width:100%;height:100%;display:block;" />
      <div style="position:absolute;inset:13.3% 4.9%;border:1.5px dashed rgba(255,255,255,.95);box-shadow:0 0 0 1px rgba(0,0,0,.35);border-radius:6px;pointer-events:none;"></div>
    </div>
    <div style="font-size:10px;color:var(--text-faint);margin-top:4px;">Pratinjau persis seperti di slider. Kotak putus-putus = area aman teks (min. 16 px dari tepi). Hasil unggah: ${outW} × ${outH} px.</div>
    ${warns.map(w => `<div style="font-size:10.5px;color:#f59e0b;margin-top:3px;">${w}</div>`).join('')}
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px;">
      ${canShift ? `<span style="font-size:11px;color:var(--text-dim);">Fokus potong:</span>${focusBtn(0, lbl[0])}${focusBtn(0.5, lbl[1])}${focusBtn(1, lbl[2])}` : ''}
      <button type="button" class="follow-btn" style="color:#f87171;margin-left:auto;" onclick="window.__bnImageClear()">✕ Hapus gambar</button>
    </div>`;
}

window.__onBannerImageSelected = async function (event) {
  const input = event.target;
  const file = input.files && input.files[0];
  if (!file) return;
  const errEl = document.getElementById('bn-error');
  try {
    pendingBnImageEl = await annLoadImage(file);
    pendingBnImageFocus = 0.5;
    if (errEl) errEl.textContent = '';
    const zone = document.getElementById('bn-image-zone');
    if (zone) zone.innerHTML = '🔄 Ganti gambar';
    renderBnImagePreview();
  } catch (e) {
    if (errEl) errEl.textContent = e.message;
  }
  input.value = ''; // supaya memilih file yang sama lagi tetap memicu event
};
window.__bnImageFocus = function (val) { pendingBnImageFocus = val; renderBnImagePreview(); };
window.__bnImageClear = function () {
  pendingBnImageEl = null; pendingBnImageFocus = 0.5;
  const zone = document.getElementById('bn-image-zone');
  if (zone) zone.innerHTML = '📷 Pilih gambar banner (wajib)';
  renderBnImagePreview();
};

async function callAdminBanners(action, extra = {}) {
  const { data, error } = await sb.functions.invoke('admin-banners', { body: { password: adminPasswordCache, action, ...extra } });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (e) {}
    throw new Error(msg);
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

const bnFmt = (d) => new Date(d).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function bnLocalText(iso) {
  if (!iso) return '';
  const d = new Date(iso), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// '' → null (kosong), teks tak valid → false, selain itu → ISO
function bnParseLocal(str) {
  const t = String(str || '').trim();
  if (!t) return null;
  const d = new Date(t.replace(' ', 'T'));
  return isNaN(d.getTime()) ? false : d.toISOString();
}

// Tandai gambar yang rasionya jauh dari 8:3 (akan terpotong di slider)
window.__annCheckRatio = function (img) {
  try {
    const note = img.parentElement && img.parentElement.nextElementSibling;
    if (!note || !note.classList.contains('ann-ratio-note') || !img.naturalWidth || !img.naturalHeight) return;
    const r = img.naturalWidth / img.naturalHeight;
    const keep = r > ANN_BANNER_RATIO ? ANN_BANNER_RATIO / r : r / ANN_BANNER_RATIO;
    const lost = Math.round((1 - keep) * 100);
    if (lost >= 15) note.textContent = `⚠️ Rasio gambar ${r.toFixed(2)}:1 — di slider ±${lost}% terpotong (ideal 2,67:1 / 1000 × 375 px).`;
  } catch (e) {}
};

// ---------- PEMILIH TUJUAN KLIK BANNER ----------
// Daftar pedagang di pemilih tujuan: grup teratas "Sedang promo" (dengan sisa waktu) dan
// "Mengajukan promo" (permintaan masih pending), sisanya urut abjad.
let bnPendingPromoIds = new Set();
async function bnLoadPendingPromo() {
  try {
    const { data, error } = await sb.functions.invoke('admin-action', { body: { password: adminPasswordCache, action: 'list_upgrade_requests' } });
    if (error) throw error;
    if (data && data.error) throw new Error(data.error);
    bnPendingPromoIds = new Set((data.requests || [])
      .filter(r => r.status === 'pending' && r.request_type === 'promo' && r.vendors)
      .map(r => r.vendors.id));
  } catch (e) { bnPendingPromoIds = new Set(); } // gagal = tampilkan tanpa grup "Mengajukan promo"
}

function bnVendorOptionsHtml() {
  const opt = (v, suffix) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.name)}${suffix ? ' — ' + escapeHtml(suffix) : ''}</option>`;
  const byName = (a, b) => a.name.localeCompare(b.name, 'id');
  const active = vendors.filter(isPromoActive).sort((a, b) => new Date(a.promo_until) - new Date(b.promo_until));
  const activeIds = new Set(active.map(v => v.id));
  const pending = vendors.filter(v => bnPendingPromoIds.has(v.id) && !activeIds.has(v.id)).sort(byName);
  const usedIds = new Set([...activeIds, ...pending.map(v => v.id)]);
  const rest = vendors.filter(v => !usedIds.has(v.id)).sort(byName);
  return '<option value="">— pilih pedagang —</option>'
    + (active.length ? `<optgroup label="🔥 Sedang promo">${active.map(v => opt(v, promoTimeLeftLabel(v.promo_until))).join('')}</optgroup>` : '')
    + (pending.length ? `<optgroup label="⏳ Mengajukan promo (belum disetujui)">${pending.map(v => opt(v, v.region || '')).join('')}</optgroup>` : '')
    + `<optgroup label="Semua pedagang (A–Z)">${rest.map(v => opt(v, v.region || '')).join('')}</optgroup>`;
}

const BANNER_WA_DEFAULT_MSG = 'Halo admin JajanDekat, saya pedagang dan mau pasang promo/iklan di JajanDekat.';
const BANNER_WA_CHANNEL = 'https://whatsapp.com/channel/0029Vb8okwd4inorfK4UCQ3Z';
const BANNER_DEST_APP_PAGES = { peta: '🗺️ Peta', cari: '🔍 Cari', favorit: '❤️ Favorit', terdekat: '📍 Pedagang terdekat', artikel: '📰 Daftar artikel' };
const BANNER_DEST_AUDIENCE_HINT = { promo: 'pedagang', wa_admin: 'pedagang', daftar: 'pembeli' }; // audiens yang paling masuk akal per tujuan
let bnAudienceTouched = false; // kalau admin sudah memilih audiens sendiri, jangan ditimpa saran otomatis
let bnArticlesCache = null;

function bnDestOptionsHtml() {
  return `
    <option value="none">Tanpa tautan (hanya tampilan)</option>
    <optgroup label="Untuk pedagang">
      <option value="promo">🔥 Halaman Promosi Lokal (dashboard pedagang)</option>
      <option value="wa_admin">💬 Chat WhatsApp Admin — pasang iklan/promo</option>
      <option value="daftar">🏪 Daftar / masuk sebagai pedagang</option>
    </optgroup>
    <optgroup label="Halaman aplikasi">
      ${Object.entries(BANNER_DEST_APP_PAGES).map(([k, t]) => `<option value="app_${k}">${t}</option>`).join('')}
    </optgroup>
    <optgroup label="Pilih isi tertentu">
      <option value="vendor">🏪 Halaman pedagang tertentu…</option>
      <option value="artikel">📰 Artikel tertentu…</option>
      <option value="wa_channel">📢 Saluran WhatsApp JajanDekat</option>
    </optgroup>
    <optgroup label="Lainnya">
      <option value="recent">🕘 Pernah dipakai di banner lain…</option>
      <option value="custom">🌐 Link lain (ketik sendiri)…</option>
    </optgroup>`;
}

// → { link: string|null } atau { error: 'pesan' }
function bnDestValue() {
  const sel = document.getElementById('bn-dest');
  const kind = sel ? sel.value : 'none';
  const val = (id) => { const e = document.getElementById(id); return e ? e.value.trim() : ''; };
  if (kind === 'none') return { link: null };
  if (kind === 'promo') return { link: 'app:promo' };
  if (kind === 'daftar') return { link: 'app:daftar' };
  if (kind.startsWith('app_')) return { link: 'app:' + kind.slice(4) };
  if (kind === 'wa_channel') return { link: BANNER_WA_CHANNEL };
  if (kind === 'wa_admin') {
    if (typeof ADMIN_WHATSAPP === 'undefined' || !ADMIN_WHATSAPP) return { error: 'Nomor WhatsApp admin belum diatur di config.js.' };
    return { link: `https://wa.me/${ADMIN_WHATSAPP}?text=${encodeURIComponent(val('bn-dest-wa') || BANNER_WA_DEFAULT_MSG)}` };
  }
  if (kind === 'vendor') { const id = val('bn-dest-vendor'); return id ? { link: `?vendor=${id}` } : { error: 'Pilih pedagang tujuan.' }; }
  if (kind === 'artikel') { const sl = val('bn-dest-artikel'); return sl ? { link: `?artikel=${encodeURIComponent(sl)}` } : { error: 'Pilih artikel tujuan.' }; }
  if (kind === 'recent') { const l = val('bn-dest-recent'); return l ? { link: l } : { error: 'Belum ada tautan lama yang bisa dipilih.' }; }
  if (kind === 'custom') {
    const l = val('bn-dest-custom');
    if (!l) return { error: 'Isi link tujuan (diawali https://).' };
    return /^https:\/\/[^\s]+$/i.test(l) ? { link: l } : { error: 'Link harus diawali https:// dan tanpa spasi.' };
  }
  return { link: null };
}

window.__bnDestUpdate = function () {
  const box = document.getElementById('bn-dest-preview');
  if (!box) return;
  const d = bnDestValue();
  if (d.error) { box.textContent = ''; return; }
  if (!d.link) { box.textContent = 'Banner hanya tampil, tidak bisa diketuk.'; return; }
  const short = d.link.length > 90 ? d.link.slice(0, 90) + '…' : d.link;
  const test = /^https:\/\//i.test(d.link) ? ` · <a href="${escapeHtml(d.link)}" target="_blank" rel="noopener" style="color:var(--brand);font-weight:700;">Tes tautan ↗</a>` : '';
  box.innerHTML = `🔗 <code>${escapeHtml(short)}</code>${test}`;
};

window.__bnDestChange = async function () {
  const kind = document.getElementById('bn-dest').value;
  const extra = document.getElementById('bn-dest-extra');
  const fld = 'width:100%;box-sizing:border-box;font-family:inherit;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-size:12.5px;';
  const note = (t) => `<div style="font-size:10.5px;color:var(--text-faint);margin-top:4px;">${t}</div>`;
  let html = '';
  if (kind === 'wa_admin') {
    html = `<textarea id="bn-dest-wa" rows="2" maxlength="300" oninput="window.__bnDestUpdate()" style="${fld}">${escapeHtml(BANNER_WA_DEFAULT_MSG)}</textarea>${note('Pesan ini terisi otomatis di WhatsApp pedagang — mereka tinggal menekan kirim. Boleh diubah.')}`;
  } else if (kind === 'promo') {
    html = note('Pedagang dibawa ke halaman pedagang dan kartu "Promosi Lokal Harian" disorot. Kalau belum masuk akun, mereka melihat halaman masuk/daftar.');
  } else if (kind === 'vendor') {
    html = `<select id="bn-dest-vendor" onchange="window.__bnDestUpdate()" style="${fld}">${bnVendorOptionsHtml()}</select>`;
    // Muat permintaan promo yang pending, lalu segarkan daftar tanpa mengubah pilihan admin
    bnLoadPendingPromo().then(() => {
      const sel = document.getElementById('bn-dest-vendor');
      if (!sel || document.getElementById('bn-dest')?.value !== 'vendor') return;
      const cur = sel.value;
      sel.innerHTML = bnVendorOptionsHtml();
      sel.value = cur;
      window.__bnDestUpdate();
    });
  } else if (kind === 'artikel') {
    extra.innerHTML = note('Memuat daftar artikel...');
    try {
      if (!bnArticlesCache) {
        const { data, error } = await sb.from('articles').select('slug,title').eq('status', 'published').order('created_at', { ascending: false }).limit(100);
        if (error) throw error;
        bnArticlesCache = data || [];
      }
      html = bnArticlesCache.length
        ? `<select id="bn-dest-artikel" onchange="window.__bnDestUpdate()" style="${fld}"><option value="">— pilih artikel —</option>${bnArticlesCache.map(a => `<option value="${escapeHtml(a.slug)}">${escapeHtml(a.title)}</option>`).join('')}</select>`
        : note('Belum ada artikel yang terbit.');
    } catch (e) { html = note('Gagal memuat artikel: ' + escapeHtml(e.message)); }
    if (document.getElementById('bn-dest').value !== kind) return; // admin sudah ganti pilihan selagi memuat
  } else if (kind === 'recent') {
    const seen = new Map();
    adminBannersData.forEach(b => { if (b.link && !seen.has(b.link)) seen.set(b.link, b.title); });
    html = seen.size
      ? `<select id="bn-dest-recent" onchange="window.__bnDestUpdate()" style="${fld}">${[...seen].map(([l, t]) => `<option value="${escapeHtml(l)}">${escapeHtml(t)} — ${escapeHtml(l.length > 40 ? l.slice(0, 40) + '…' : l)}</option>`).join('')}</select>`
      : note('Belum ada banner dengan tautan. Pilih tujuan lain dulu.');
  } else if (kind === 'custom') {
    html = `<input id="bn-dest-custom" type="url" inputmode="url" placeholder="https://…" oninput="window.__bnDestUpdate()" style="${fld}" />`;
  }
  extra.innerHTML = html;

  // Saran audiens otomatis (kecuali admin sudah memilih sendiri)
  const hint = BANNER_DEST_AUDIENCE_HINT[kind];
  const aud = document.getElementById('bn-audience');
  if (aud && !bnAudienceTouched) aud.value = hint || 'semua';
  window.__bnDestUpdate();
};

async function loadAdminBanners() {
  const el = document.getElementById('admin-banners-list');
  if (!el) return;
  try {
    const res = await callAdminBanners('list_banners');
    const list = res.banners || [];
    adminBannersData = list;
    if (!list.length) { el.innerHTML = '<div style="color:var(--text-faint);font-size:11.5px;">Belum ada banner. Tambahkan lewat form di atas — tanpa banner, slider tidak tampil di beranda.</div>'; return; }
    const now = Date.now();
    const state = (b) => !b.active ? 'off'
      : (b.start_at && new Date(b.start_at).getTime() > now) ? 'soon'
      : (b.end_at && new Date(b.end_at).getTime() <= now) ? 'ended' : 'live';
    const live = list.filter(b => state(b) === 'live');
    const buyerIds = live.filter(b => b.audience === 'semua' || b.audience === 'pembeli').map(b => b.id);
    const vendorIds = live.filter(b => b.audience === 'semua' || b.audience === 'pedagang').map(b => b.id);
    const slot = (ids, id) => { const n = ids.indexOf(id) + 1; return n > 0 && n <= ANN_SLIDER_MAX ? `#${n}` : null; };
    const statusLine = (b) => {
      const s = state(b);
      if (s === 'off') return '⏸️ Nonaktif — tidak tampil';
      if (s === 'soon') return `⏳ Terjadwal — mulai ${bnFmt(b.start_at)}`;
      if (s === 'ended') return `⌛ Sudah berakhir (${bnFmt(b.end_at)}) — tidak tampil`;
      const parts = [];
      if (b.audience === 'semua' || b.audience === 'pembeli') { const n = slot(buyerIds, b.id); parts.push(n ? `pembeli ${n}` : 'TIDAK tampil ke pembeli (slider penuh)'); }
      if (b.audience === 'semua' || b.audience === 'pedagang') { const n = slot(vendorIds, b.id); parts.push(n ? `pedagang ${n}` : 'TIDAK tampil ke pedagang (slider penuh)'); }
      const zoneNote = (b.zone_level && b.zone_level !== 'nasional') ? ' · urutan bisa berbeda per wilayah' : '';
      return `🟢 Tampil di slider — ${parts.join(' · ')}${zoneNote}`;
    };
    const overflow = (ids) => ids.length > ANN_SLIDER_MAX ? ` (+${ids.length - ANN_SLIDER_MAX} tidak tampil)` : '';
    const summary = `<div style="font-size:11.5px;font-weight:600;margin:0 0 8px;">🖼️ Slider pembeli: ${Math.min(buyerIds.length, ANN_SLIDER_MAX)}/${ANN_SLIDER_MAX}${overflow(buyerIds)} · Slider pedagang: ${Math.min(vendorIds.length, ANN_SLIDER_MAX)}/${ANN_SLIDER_MAX}${overflow(vendorIds)}</div>`;
    el.innerHTML = summary + list.map((b, i) => {
      const ctr = b.view_count > 0 ? ` · CTR ${(b.click_count / b.view_count * 100).toFixed(1)}%` : '';
      return `
      <div class="vendor-card" style="flex-direction:column;align-items:stretch;gap:6px;">
        <div style="aspect-ratio:8/3;border-radius:16px;overflow:hidden;background:var(--surface-2);"><img src="${escapeHtml(b.image_url)}" alt="" onload="window.__annCheckRatio(this)" style="width:100%;height:100%;object-fit:cover;display:block;" /></div>
        <div class="ann-ratio-note" style="font-size:10.5px;color:#f59e0b;"></div>
        <div style="font-size:12.5px;font-weight:700;">${i + 1}. ${escapeHtml(b.title)}</div>
        <div style="font-size:10.5px;font-weight:600;">${statusLine(b)}</div>
        <div style="font-size:10px;color:var(--text-faint);">🎯 ${BANNER_AUDIENCE_LABEL[b.audience] || b.audience} · 📍 ${escapeHtml(annZoneLabel(b))}</div>
        <div style="font-size:10px;color:var(--text-faint);">🗓 ${b.start_at ? bnFmt(b.start_at) : 'langsung'} → ${b.end_at ? bnFmt(b.end_at) : 'tanpa batas'}</div>
        ${b.link ? `<div style="font-size:10px;color:var(--text-faint);word-break:break-all;">🔗 ${escapeHtml(b.link)}</div>` : ''}
        <div style="font-size:10px;color:var(--text-faint);">👁 ${b.view_count || 0} tayangan · 👆 ${b.click_count || 0} klik${ctr}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="follow-btn" ${i === 0 ? 'disabled style="opacity:.4"' : ''} onclick="window.__adminMoveBanner('${b.id}','up')">▲</button>
          <button class="follow-btn" ${i === list.length - 1 ? 'disabled style="opacity:.4"' : ''} onclick="window.__adminMoveBanner('${b.id}','down')">▼</button>
          <button class="follow-btn" onclick="window.__adminToggleBanner('${b.id}', ${b.active ? 'false' : 'true'})">${b.active ? '⏸ Nonaktifkan' : '▶ Aktifkan'}</button>
          <button class="follow-btn" onclick="window.__adminEditBannerSchedule('${b.id}')">🗓 Ubah jadwal</button>
          <button class="follow-btn" style="color:#f87171;" onclick="window.__adminDeleteBanner('${b.id}')">🗑 Hapus</button>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = `<span style="color:#f87171;font-size:11.5px;">Gagal memuat banner: ${escapeHtml(e.message)}</span>`;
  }
}

window.__adminCreateBanner = async function () {
  const errEl = document.getElementById('bn-error');
  const title = document.getElementById('bn-title').value.trim();
  const dest = bnDestValue();
  const link = dest.link || '';
  const audience = document.getElementById('bn-audience').value;
  const regionId = document.getElementById('bn-region').value || null;
  const startAt = bnParseLocal(document.getElementById('bn-start').value.replace('T', ' '));
  const endAt = bnParseLocal(document.getElementById('bn-end').value.replace('T', ' '));

  if (!title) { errEl.textContent = 'Judul banner wajib diisi.'; return; }
  if (!pendingBnImageEl) { errEl.textContent = 'Pilih gambar banner dulu.'; return; }
  if (dest.error) { errEl.textContent = dest.error; return; }
  if (link && !BANNER_LINK_OK.some(re => re.test(link))) { errEl.textContent = 'Tautan harus https://…, ?vendor=ID, ?artikel=slug, atau app:daftar / peta / cari / favorit / terdekat / artikel.'; return; }
  if (startAt === false || endAt === false) { errEl.textContent = 'Format tanggal tidak valid.'; return; }
  if (endAt && new Date(endAt).getTime() <= Date.now()) { errEl.textContent = 'Waktu berakhir sudah lewat — banner tidak akan pernah tampil.'; return; }
  if (startAt && endAt && new Date(startAt) >= new Date(endAt)) { errEl.textContent = 'Waktu berakhir harus setelah waktu mulai.'; return; }

  // Pengingat: banner baru masuk di urutan terakhir; slider hanya menampilkan ANN_SLIDER_MAX pertama per audiens
  const group = audience === 'semua' ? ['semua', 'pembeli', 'pedagang'] : ['semua', audience];
  const now = Date.now();
  const liveSame = adminBannersData.filter(b => b.active && group.includes(b.audience) && (!b.end_at || new Date(b.end_at).getTime() > now)).length;
  if (liveSame >= ANN_SLIDER_MAX) {
    const ok = confirm(`Sudah ada ${liveSame} banner aktif/terjadwal untuk audiens ini (slider hanya menampilkan ${ANN_SLIDER_MAX} pertama).\n\nBanner baru masuk di urutan terakhir, jadi belum tampil sampai Anda menaikkan urutannya (▲) atau menonaktifkan banner lain.\n\nLanjut?`);
    if (!ok) return;
  }

  errEl.textContent = 'Memproses & mengunggah gambar...';
  let uploaded = null;
  try {
    uploaded = await uploadBannerImage(pendingBnImageEl, pendingBnImageFocus);
    await callAdminBanners('save_banner', { banner: { title, image_url: uploaded.url, link: link || null, audience, region_id: regionId, start_at: startAt, end_at: endAt, active: true } });
    pendingBnImageEl = null; pendingBnImageFocus = 0.5;
    renderBnImagePreview();
    ['bn-title', 'bn-start', 'bn-end'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('bn-region').value = '';
    document.getElementById('bn-audience').value = 'semua';
    bnAudienceTouched = false;
    document.getElementById('bn-dest').value = 'none';
    window.__bnDestChange();
    const zone = document.getElementById('bn-image-zone');
    if (zone) zone.innerHTML = '📷 Pilih gambar banner (wajib)';
    errEl.textContent = '';
    showToast('Banner ditambahkan ke slider! 🖼️');
    await loadAdminBanners();
    refreshBanners(true);
  } catch (e) {
    errEl.textContent = (link === 'app:promo' && /Tautan tidak valid/i.test(e.message))
      ? 'Server belum menerima tujuan "Halaman Promosi Lokal" — fungsi admin-banners perlu diperbarui (izinkan app:promo). Sementara, pilih tujuan lain.'
      : 'Gagal menyimpan: ' + e.message;
    if (uploaded) { try { await sb.storage.from('vendor-photos').remove([uploaded.path]); } catch (x) {} } // jangan tinggalkan file yatim
  }
};

window.__adminMoveBanner = async function (id, direction) {
  try { await callAdminBanners('move_banner', { id, direction }); await loadAdminBanners(); refreshBanners(true); }
  catch (e) { alert('Gagal memindah urutan: ' + e.message); }
};

window.__adminToggleBanner = async function (id, active) {
  try { await callAdminBanners('set_banner_active', { id, active }); await loadAdminBanners(); refreshBanners(true); }
  catch (e) { alert('Gagal mengubah status: ' + e.message); }
};

window.__adminDeleteBanner = async function (id) {
  if (!confirm('Hapus banner ini beserta gambarnya? Tindakan ini tidak bisa dibatalkan.')) return;
  try { await callAdminBanners('delete_banner', { id }); await loadAdminBanners(); refreshBanners(true); }
  catch (e) { alert('Gagal menghapus: ' + e.message); }
};

window.__adminEditBannerSchedule = async function (id) {
  const b = adminBannersData.find(x => x.id === id);
  if (!b) return;
  const s = prompt('Mulai tayang (format 2026-09-25 08:00, jam lokal perangkat).\nKosongkan = langsung tayang.', bnLocalText(b.start_at));
  if (s === null) return;
  const e = prompt('Berakhir (format 2026-09-30 23:59).\nKosongkan = tanpa batas akhir.', bnLocalText(b.end_at));
  if (e === null) return;
  const startAt = bnParseLocal(s), endAt = bnParseLocal(e);
  if (startAt === false || endAt === false) { alert('Format tanggal tidak valid. Contoh: 2026-09-25 08:00'); return; }
  try {
    await callAdminBanners('save_banner', { banner: { id: b.id, title: b.title, image_url: b.image_url, link: b.link, audience: b.audience, region_id: b.region_id, active: b.active, start_at: startAt, end_at: endAt } });
    await loadAdminBanners();
    refreshBanners(true);
  } catch (err) { alert('Gagal menyimpan jadwal: ' + err.message); }
};

// ---------- KIRIM PUSH DARI ADMIN (pengumuman & artikel) ----------
async function callBroadcastPush(body) {
  const { data, error } = await sb.functions.invoke('send-broadcast-push', { body: { password: adminPasswordCache, ...body } });
  if (error) {
    let payload = null;
    try { payload = await error.context.json(); } catch (e) {}
    throw new Error((payload && payload.error) || error.message);
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

// Selalu pratinjau dulu (dry_run): admin melihat berapa perangkat yang akan menerima, baru konfirmasi.
window.__adminBroadcastPush = async function (kind, id) {
  try {
    const pv = await callBroadcastPush({ kind, id, dry_run: true });
    const aud = ANN_AUDIENCE_LABEL[pv.audience] || pv.audience;
    const zona = pv.region ? `wilayah ${pv.region}` : 'Nasional';
    if (!pv.targets) {
      alert(`Tidak ada perangkat yang cocok untuk dikirimi.\n\nTarget: ${aud} · ${zona}\nTotal langganan push: ${pv.total_subs}\n\nPerangkat yang wilayahnya belum diketahui hanya menerima siaran Nasional.`);
      return;
    }
    const again = !!pv.already_sent_at;
    const when = again ? new Date(pv.already_sent_at).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const ok = confirm(`${again ? `⚠️ Sudah pernah dikirim (${when}). Kirim ULANG?\n\n` : ''}Notifikasi akan dikirim ke ${pv.targets} dari ${pv.total_subs} perangkat berlangganan.\nTarget: ${aud} · ${zona}\n\nLanjut kirim?`);
    if (!ok) return;
    const res = await callBroadcastPush({ kind, id, force: again });
    showToast(`Push terkirim ke ${res.sent} perangkat 📣${res.failed ? ` (${res.failed} gagal)` : ''}`);
    if (kind === 'announcement') loadAdminAnnouncements(); else loadAdminArticles();
  } catch (e) {
    alert('Gagal mengirim push: ' + e.message);
  }
};

function offerArticlePush(id) {
  if (confirm('Artikel sudah terbit. Kirim notifikasi push ke pembaca sekarang?\n\nKamu akan melihat pratinjau jumlah penerima dulu sebelum benar-benar terkirim.')) {
    window.__adminBroadcastPush('article', id);
  }
}

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
    const res = await callAdminAction('list_articles');
    adminArticlesData = res.articles || [];

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
        <div style="font-size:9.5px;color:var(--text-faint);">/${escapeHtml(a.slug)} · ${a.source === 'ai' ? '✨ AI' : '🧑 Admin'} · ${new Date(a.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}${a.push_sent_at ? ' · 📣 push terkirim' : ''}</div>
        <div class="admin-row" style="margin-top:2px;">
          <button class="follow-btn" style="flex-shrink:0;" onclick="window.__adminOpenArticleForm('${a.id}')">✏️ Edit</button>
          <button class="icon-btn" title="${a.status === 'published' ? 'Jadikan draf' : 'Terbitkan'}" onclick="window.__adminTogglePublishArticle('${a.id}',${a.status !== 'published'})">${a.status === 'published' ? '🙈' : '🚀'}</button>
          ${a.status === 'published' ? `<button class="icon-btn" title="${a.push_sent_at ? 'Kirim ulang notifikasi push' : 'Kirim notifikasi push'}" onclick="window.__adminBroadcastPush('article','${a.id}')">📣</button>` : ''}
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
    await callAdminAction('set_article_status', undefined, { article_id: id, status: 'published' });
    showToast('Artikel disetujui & diterbitkan! 🚀');
    await loadAdminArticles();
    offerArticlePush(id);
  } catch (e) {
    alert('Gagal menyetujui: ' + e.message);
  }
};

window.__adminRejectArticle = async function (id) {
  try {
    await callAdminAction('set_article_status', undefined, { article_id: id, status: 'rejected' });
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

      <label style="font-size:11px;color:var(--text-faint);">Wilayah artikel (opsional — dipakai untuk menarget notifikasi push)</label>
      <select id="art-region" style="width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);font-size:12.5px;margin:4px 0 10px;">
        ${regionOptionsHtml('🌏 Umum (semua wilayah)', existing?.region_id || '')}
      </select>

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
    const existing = editingArticleId ? adminArticlesData.find(a => a.id === editingArticleId) : null;
    const newlyPublished = published && !(existing && existing.status === 'published');
    const article = {
      title, slug, excerpt: excerpt || null, content, cover_image: coverUrl || null, status,
      region_id: (document.getElementById('art-region') && document.getElementById('art-region').value) || null,
    };
    if (editingArticleId) article.id = editingArticleId;
    if (newlyPublished) article.published_at = new Date().toISOString(); // revisi artikel yang sudah terbit tidak mengubah tanggal terbit
    const res = await callAdminAction('save_article', undefined, { article });
    const savedId = res && res.article ? res.article.id : editingArticleId;

    document.getElementById('article-form-overlay').remove();
    pendingArticleCoverFile = null; pendingArticleCoverPreview = null; editingArticleId = null;
    showToast(published ? 'Artikel diterbitkan! 📝' : 'Artikel disimpan sebagai draf.');
    await loadAdminArticles();
    if (newlyPublished && savedId) offerArticlePush(savedId); // revisi/typo tidak memicu push otomatis
  } catch (e) {
    errEl.textContent = 'Gagal menyimpan: ' + ((e.message.includes('duplicate') || e.message.includes('object Object')) ? 'kemungkinan slug ini sudah dipakai artikel lain, coba slug lain.' : e.message);
  }
};

window.__adminTogglePublishArticle = async function (id, newState) {
  try {
    await callAdminAction('set_article_status', undefined, { article_id: id, status: newState ? 'published' : 'draft' });
    showToast(newState ? 'Artikel diterbitkan! 🚀' : 'Artikel dijadikan draf.');
    await loadAdminArticles();
    if (newState) offerArticlePush(id);
  } catch (e) {
    alert('Gagal mengubah status: ' + e.message);
  }
};

window.__adminDeleteArticle = async function (id, title) {
  if (!confirm(`Hapus artikel "${title}"? Tindakan ini tidak bisa dibatalkan.`)) return;
  try {
    await callAdminAction('delete_article', undefined, { article_id: id });
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

async function loadAdminTagSuggestions() {
  const el = document.getElementById('admin-tags');
  if (!el) return;
  try {
    // tag_suggestions dikunci RLS total — dibaca lewat edge function admin-action.
    const { data, error } = await sb.functions.invoke('admin-action', { body: { password: adminPasswordCache, action: 'list_tag_suggestions' } });
    if (error) throw error;
    if (data && data.error) throw new Error(data.error);
    const rows = data.tags || [];
    if (rows.length === 0) { el.innerHTML = '<div style="color:var(--text-faint);font-size:11.5px;">Belum ada tag baru yang diketik pedagang. 👍</div>'; return; }
    el.innerHTML = rows.map(t => `
      <div class="vendor-card" style="flex-direction:column;align-items:stretch;gap:6px;${t.reviewed ? 'opacity:.55;' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:700;font-size:13px;">${escapeHtml(t.tag_display)}</span>
          <span style="font-size:10px;padding:3px 9px;border-radius:999px;background:var(--brand-dim);color:var(--brand);font-weight:700;">${t.count}× dipakai</span>
        </div>
        <div style="font-size:9.5px;color:var(--text-faint);">Pertama: ${new Date(t.first_seen).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })} · Terakhir: ${new Date(t.last_seen).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
        <button class="follow-btn" onclick="window.__toggleTagReviewed('${t.id}', ${!t.reviewed})">${t.reviewed ? '↩️ Tandai Belum Dibuat' : '✅ Tandai Ikon Sudah Dibuat'}</button>
      </div>
    `).join('');
  } catch (e) {
    el.innerHTML = `<span style="color:#f87171;font-size:11.5px;">Gagal memuat tag: ${e.message}</span>`;
  }
}

window.__toggleTagReviewed = async function (id, reviewed) {
  try {
    await sb.functions.invoke('admin-action', { body: { password: adminPasswordCache, action: 'update_tag_suggestion_reviewed', tag_id: id, reviewed } });
    loadAdminTagSuggestions();
  } catch (e) {
    alert('Gagal update status: ' + e.message);
  }
};

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
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (e) {}
    throw new Error(msg);
  }
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
    // Banner otomatis dari promo ini ikut dinonaktifkan supaya tidak menayangkan promo yang sudah dicabut
    try {
      const { banners } = await callAdminBanners('list_banners');
      const mine = (banners || []).filter(b => b.active && b.link === `?vendor=${id}` && /^Promo: /.test(b.title || ''));
      for (const b of mine) await callAdminBanners('set_banner_active', { id: b.id, active: false });
      if (mine.length) refreshBanners(true);
    } catch (e) { /* tidak kritis; banner tetap berakhir sendiri di waktu promo_until */ }
    renderAdminDashboard();
  } catch (e) {
    alert('Gagal mencabut promo: ' + e.message);
  }
};

// ---------- ADMIN: PROMO PEDAGANG -> BANNER SLIDER (gambar 8:3 dibuat otomatis) ----------
// Foto pedagang (atau gradien + emoji kalau belum punya foto) + nama + teks promo + batas waktu.
// Tautan banner = halaman pedagang, jadwal berakhir = promo_until, audiens = pembeli.
function bnLoadImageCors(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous'; // supaya canvas tidak "tainted" dan bisa diekspor; gagal = pakai latar gradien
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function bnWrapText(ctx, text, maxW, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (!cur || ctx.measureText(t).width <= maxW) cur = t; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 1 && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
  kept[maxLines - 1] = last.trimEnd() + '…';
  return kept;
}

async function promoBannerCanvas(v) {
  const W = ANN_BANNER_W, H = ANN_BANNER_H;
  try { await Promise.all([document.fonts.load('800 46px Poppins'), document.fonts.load('700 34px Inter')]); } catch (e) {}
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = await bnLoadImageCors(v.photo_url);
  if (img) {
    const c = annBannerCrop(img, 0.5);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, c.sx, c.sy, c.cw, c.ch, 0, 0, W, H);
  } else {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#FF8A3D'); g.addColorStop(1, '#FF6B4A');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.font = '160px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(v.emoji || '🍜', W - 70, H / 2);
  }
  // Bayangan gelap di sisi kiri supaya teks terbaca di atas foto apa pun
  const shade = ctx.createLinearGradient(0, 0, W * 0.8, 0);
  shade.addColorStop(0, 'rgba(20,12,4,.9)'); shade.addColorStop(0.6, 'rgba(20,12,4,.65)'); shade.addColorStop(1, 'rgba(20,12,4,0)');
  ctx.fillStyle = shade; ctx.fillRect(0, 0, W, H);

  const padX = 56, maxW = W * 0.66;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';

  // Lencana
  ctx.font = '700 24px Inter, sans-serif';
  const tag = '🔥 PROMO HARI INI';
  const tagW = ctx.measureText(tag).width + 32;
  ctx.fillStyle = '#F5A623';
  roundRect(ctx, padX, 36, tagW, 42, 21); ctx.fill(); // helper roundRect bawaan (lebih kompatibel daripada ctx.roundRect)
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(tag, padX + 16, 58);

  // Nama pedagang (1 baris)
  ctx.textBaseline = 'top'; ctx.fillStyle = '#fff'; ctx.font = '800 46px Poppins, sans-serif';
  let name = v.name || '';
  while (name.length > 1 && ctx.measureText(name).width > maxW) name = name.slice(0, -1);
  if (name !== v.name) name = name.trimEnd() + '…';
  ctx.fillText(name, padX, 98);

  // Teks promo (maks 2 baris)
  ctx.fillStyle = '#FFD84D'; ctx.font = '700 34px Inter, sans-serif';
  const lines = bnWrapText(ctx, v.promo_text || 'Ada promo spesial hari ini!', maxW, 2);
  lines.forEach((ln, i) => ctx.fillText(ln, padX, 170 + i * 44));

  // Batas waktu
  ctx.fillStyle = 'rgba(255,255,255,.88)'; ctx.font = '600 22px Inter, sans-serif';
  const until = new Date(v.promo_until).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  ctx.fillText(`Berlaku sampai ${until} · Cek di JajanDekat`, padX, H - 56);
  return canvas;
}

window.__adminPromoToBanner = async function (vendorId) {
  const v = vendors.find(x => x.id === vendorId) || (typeof adminVendorData !== 'undefined' ? adminVendorData.find(x => x.id === vendorId) : null);
  if (!v) return;
  if (!isPromoActive(v)) { alert('Promo pedagang ini sudah tidak aktif.'); return; }
  if (!v.promo_text && !confirm('Pedagang ini belum punya teks promo yang disetujui, gambar akan memakai kalimat umum. Lanjut?')) return;
  let canvas;
  try { canvas = await promoBannerCanvas(v); }
  catch (e) { alert('Gagal membuat gambar banner: ' + e.message); return; }
  window.__promoBannerDraft = { vendorId, canvas };
  document.getElementById('promo-banner-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'promo-banner-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px;';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:16px;padding:14px;width:100%;max-width:460px;">
      <div style="font-family:'Poppins';font-weight:700;font-size:14px;margin-bottom:8px;">🖼️ Pratinjau banner promo</div>
      <img src="${canvas.toDataURL('image/jpeg', 0.9)}" alt="Pratinjau banner" style="width:100%;border-radius:10px;display:block;" />
      <div style="font-size:11px;color:var(--text-dim);margin-top:8px;line-height:1.5;">Tautan ke halaman pedagang · audiens pembeli · tayang sampai promo berakhir. Kalau promo dicabut, banner ikut dinonaktifkan.</div>
      <div id="promo-banner-error" style="color:#f87171;font-size:11.5px;margin-top:6px;"></div>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button class="follow-btn" style="flex:1;padding:10px;" onclick="document.getElementById('promo-banner-overlay')?.remove()">Batal</button>
        <button id="promo-banner-go" style="flex:2;padding:10px;" onclick="window.__confirmPromoBanner()">Pasang ke slider</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
};

window.__confirmPromoBanner = async function () {
  const d = window.__promoBannerDraft;
  const errEl = document.getElementById('promo-banner-error');
  const btn = document.getElementById('promo-banner-go');
  if (!d || !errEl || !btn) return;
  const v = vendors.find(x => x.id === d.vendorId) || (typeof adminVendorData !== 'undefined' ? adminVendorData.find(x => x.id === d.vendorId) : null);
  if (!v) return;
  btn.disabled = true;
  errEl.textContent = 'Memeriksa slider...';
  let uploadedPath = null;
  try {
    const { banners } = await callAdminBanners('list_banners');
    const list = banners || [];
    const now = Date.now();
    const live = (b) => b.active && (!b.end_at || new Date(b.end_at).getTime() > now);
    if (list.some(b => live(b) && b.link === `?vendor=${v.id}` && /^Promo: /.test(b.title || ''))
        && !confirm('Sudah ada banner promo aktif untuk pedagang ini. Tetap buat satu lagi?')) { errEl.textContent = ''; btn.disabled = false; return; }
    const liveSame = list.filter(b => live(b) && ['semua', 'pembeli'].includes(b.audience)).length;
    if (liveSame >= ANN_SLIDER_MAX
        && !confirm(`Sudah ada ${liveSame} banner aktif/terjadwal untuk pembeli (slider hanya menampilkan ${ANN_SLIDER_MAX} pertama).\n\nBanner baru masuk di urutan terakhir, jadi belum tampil sampai Anda menaikkan urutannya (▲) atau menonaktifkan banner lain.\n\nLanjut?`)) {
      errEl.textContent = ''; btn.disabled = false; return;
    }
    errEl.textContent = 'Mengunggah gambar...';
    const blob = await new Promise((res, rej) => d.canvas.toBlob(b => b ? res(b) : rej(new Error('Gagal memproses gambar.')), 'image/jpeg', 0.85));
    const path = `banners/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const { error } = await sb.storage.from('vendor-photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
    if (error) throw error;
    uploadedPath = path;
    const { data: pub } = sb.storage.from('vendor-photos').getPublicUrl(path);
    await callAdminBanners('save_banner', { banner: {
      title: `Promo: ${v.name}`.slice(0, 80),
      image_url: pub.publicUrl,
      link: `?vendor=${v.id}`,
      audience: 'pembeli',
      region_id: v.region_id || null,
      start_at: null,
      end_at: v.promo_until,
      active: true,
    } });
    document.getElementById('promo-banner-overlay')?.remove();
    window.__promoBannerDraft = null;
    showToast('Banner promo ditambahkan ke slider! 🖼️');
    await loadAdminBanners();
    refreshBanners(true);
  } catch (e) {
    errEl.textContent = 'Gagal: ' + e.message;
    btn.disabled = false;
    if (uploadedPath) { try { await sb.storage.from('vendor-photos').remove([uploadedPath]); } catch (x) {} } // jangan tinggalkan file yatim
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
    const liburPromise = loadLiburNasional(); // paralel dengan ambil data pedagang; gagal pun tidak memblokir
    vendors = (await fetchVendors()).map(normalizeExpiry);
    await liburPromise;
    const followList = await fetchFollows();
    followedIds = new Set(followList);
    await fetchRegions();
    await getBuyerRegion().catch(() => {}); // wilayah pembeli dari cache (kalau ada), dipakai filter pengumuman
    announcements = await fetchAnnouncements();
    refreshBell();
    banners = (await fetchBanners()) || [];
    bannersFetchedAt = Date.now();
    scheduleBannerRefresh();
    ensurePushSubscription({ silent: true }); // izin sudah diberikan sebelumnya -> segarkan langganan & wilayahnya
    loadKnownTagSuggestions(); // tidak perlu ditunggu, isi belakangan pas render form pendaftaran
    subscribeRealtime();
    startGlobalChatWatch();
    startReviewAlertWatch();
    tryLocateBuyer();

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

    // Shortcut app & link dari notifikasi:
    //   ?view=peta | ?view=cari | ?view=favorit | ?view=akun | ?mode=pedagang
    //   ?vendor=ID (fokus ke pedagang di peta) | ?artikel=slug | ?ann=ID (pengumuman)
    const urlParams = new URLSearchParams(location.search);
    const wantMode = urlParams.get('mode');
    const wantView = urlParams.get('view');
    const wantVendor = urlParams.get('vendor');
    const wantArtikel = urlParams.get('artikel');
    const wantAnn = urlParams.get('ann');

    if (wantMode === 'pedagang') {
      mode = 'pedagang';
      btnPedagang.classList.add('active');
      btnPembeli.classList.remove('active');
      renderPedagang();
    } else if (wantVendor) {
      openVendorFromLink(wantVendor);
    } else if (wantArtikel) {
      openArtikelFromLink(wantArtikel);
    } else if (wantAnn) {
      openAnnouncementFromLink(wantAnn);
    } else if (['peta', 'cari', 'favorit', 'akun'].includes(wantView)) {
      bottomView = wantView;
      setNavActive(wantView);
      renderPembeli();
    } else {
      renderPembeli();
    }

    if (wantMode || wantView || wantVendor || wantArtikel || wantAnn) {
      history.replaceState(null, '', location.pathname);
    }

    maybeShowGuideOnFirstVisit();
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
      await setVendorStatus(v.id, false);
      // Foto asli terakhir tetap disimpan sebagai default, tidak dihapus di sini.
      v.active = false; v.active_until = null;
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
