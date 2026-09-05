// ============================================
// JajanDekat — app.js
// Biaya nol: Leaflet+OpenStreetMap (peta) + Supabase free tier (data & realtime)
// ============================================

const isConfigured = !SUPABASE_URL.includes("ISI-PROJECT-ID");
let sb = null;
let initError = null;
try {
  if (isConfigured) {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
} catch (e) {
  initError = e;
  console.error('Gagal membuat koneksi Supabase:', e);
}

// Identitas pembeli sederhana tanpa login (device id disimpan di localStorage)
function getDeviceId() {
  let id = localStorage.getItem('jd_device_id');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('jd_device_id', id);
  }
  return id;
}
const deviceId = getDeviceId();
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
  const { data, error } = await withTimeout(sb.from('vendors').select('id,name,category,categories,emoji,mode_icon,whatsapp,active,active_until,lat,lng,photo_url,is_premium,premium_until,created_at').order('name'), 10000, 'Ambil data pedagang');
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
function compressImage(file, maxWidth = 800, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => { img.src = e.target.result; };
    reader.onerror = reject;
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
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
function renderPembeli() {
  if (bottomView === 'peta') return renderPetaView();
  if (bottomView === 'cari') return renderCariView();

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
    <div class="cat-row">${catRowHtml}</div>
    <div class="section-label">Pedagang yang kamu ikuti</div>
    <div class="stories">${storyHtml || '<div style="color:var(--text-faint);font-size:12px;padding:8px 0;">Belum ada yang diikuti.</div>'}</div>
    <div class="section-label">Semua pedagang</div>
    <div class="vendor-list">${renderVendorListHtml(filteredVendors)}</div>
  `;
}

function renderVendorListHtml(list) {
  if (!list.length) return '<div style="color:var(--text-faint);font-size:13px;">Tidak ada pedagang.</div>';
  const sorted = [...list].sort((a, b) => (b.is_premium ? 1 : 0) - (a.is_premium ? 1 : 0));
  return sorted.map(v => {
    const following = followedIds.has(v.id);
    const untilStr = v.active_until
      ? new Date(v.active_until).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
      : null;
    return `
      <div class="vendor-card" onclick="if(!event.target.closest('button')) window.__openReviewModal('${v.id}','${v.name.replace(/'/g, "\\'")}')" style="cursor:pointer;">
        <div class="vendor-emoji" style="${vendorIconStyle(v)}">${vendorIconInner(v)}</div>
        <div class="vendor-info">
          <div class="vendor-name">${v.name}${v.is_premium ? ' <span class="premium-badge">⭐ Premium</span>' : ''}</div>
          <div class="vendor-meta">
            <span class="status-dot ${v.active ? 'aktif' : 'nonaktif'}"></span>
            <span class="status-text ${v.active ? 'aktif' : 'nonaktif'} mono">
              ${v.active ? 'SEDANG JUALAN · sampai ' + untilStr : 'Belum jualan'}
            </span>
          </div>
          <div class="vendor-sub">${(v.categories || []).join(' · ')}${v.active && !v.lat ? ' · 📍 lokasi tidak tersedia' : ''}</div>
          <div class="vendor-sub" style="color:var(--text-faint);font-size:10.5px;">Tap kartu untuk beri masukan ke pedagang 💬</div>
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
      ${v.is_premium && v.whatsapp ? `
        <a href="https://wa.me/${v.whatsapp}?text=${encodeURIComponent(`Halo ${v.name}, saya lihat lapak Anda di JajanDekat. Saya mau tanya-tanya, apakah masih jualan?`)}" target="_blank"
           style="display:inline-block;margin-top:6px;background:#25D366;color:#fff;text-decoration:none;
           font-size:11.5px;font-weight:700;padding:6px 10px;border-radius:8px;">
          💬 Chat via WhatsApp
        </a>
        <div style="font-size:9px;color:#999;margin-top:5px;">Transaksi langsung dengan pedagang, di luar tanggung jawab JajanDekat.</div>
      ` : ''}
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

        <div style="text-align:left;font-size:11px;color:var(--text-faint);margin-top:6px;">Jual apa saja? (boleh pilih lebih dari satu)</div>
        ${editCategories.length ? `
          <div class="selected-cat-strip">
            ${editCategories.map(label => `
              <span class="selected-cat-pill">${label} <button type="button" onclick="window.__editToggleCategory('${label.replace(/'/g, "\\'")}')">✕</button></span>
            `).join('')}
          </div>
        ` : `<div style="font-size:11px;color:var(--text-faint);">Belum ada yang dipilih</div>`}
        <div class="cat-picker-grid">${catHtml}</div>

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
    const { error } = await sb.rpc('update_vendor_profile', {
      p_vendor_id: vendorId, p_pin: myVendorPin || '', p_name: name,
      p_categories: editCategories, p_mode_icon: editModeIcon, p_whatsapp: whatsapp,
    });
    if (error) throw error;

    const v = vendors.find(v => v.id === vendorId);
    v.name = name; v.categories = editCategories; v.category = editCategories[0] || null;
    v.mode_icon = editModeIcon; v.whatsapp = whatsapp;
    showToast('Profil toko berhasil diperbarui! ✅');
    renderPedagang();
  } catch (e) {
    errEl.textContent = 'Gagal menyimpan: ' + e.message;
  }
};

function renderPedagang() {
  if (!myVendorId) {
    const optionsHtml = vendors.map(v => `<option value="${v.id}">${v.name}</option>`).join('');

    main.innerHTML = `
      ${vendors.length ? `
        <div class="vendor-hero" style="text-align:left;">
          <div class="section-label" style="margin-top:0;">Sudah pernah daftar? Masuk ke akun lama</div>
          <div class="setup-form">
            <select id="pick-vendor" style="background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);">
              ${optionsHtml}
            </select>
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
          <input id="reg-name" type="text" placeholder="Nama usaha, misal: Bakso Pak Slamet" />
          <div style="text-align:left;font-size:11px;color:var(--text-faint);margin-top:2px;">Jual apa saja? (boleh pilih lebih dari satu)</div>
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
          <input id="reg-whatsapp" type="tel" placeholder="Nomor WhatsApp — wajib (contoh: 6281234567890)" />
          <input id="reg-pin" type="tel" inputmode="numeric" maxlength="4" placeholder="Buat PIN 4 digit (untuk keamanan akun)" />
          <button onclick="window.__registerVendor()">🟢 Daftar Sekarang</button>
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
      <button class="follow-btn" style="width:100%;padding:10px;background:#25D366;color:#fff;" onclick="window.__shareFollowQr('${v.id}','${v.name.replace(/'/g, "\\'")}')">
        💬 Bagikan Link & QR
      </button>
      <button class="follow-btn" style="width:100%;padding:10px;margin-top:8px;background:var(--brand-dim);color:var(--brand);" onclick="window.__shareStatusImage('${v.id}','${v.name.replace(/'/g, "\\'")}')">
        🖼️ Buat & Bagikan Gambar Status (1 klik)
      </button>
    </div>

    <div class="vendor-hero" style="margin-top:14px; text-align:left;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <span style="font-size:20px;">🎯</span>
        <div>
          <div style="font-family:'Poppins';font-weight:700;font-size:13.5px;">Kampanye: Rekrut & Dapat Premium Gratis</div>
          <div style="font-size:11px;color:var(--text-faint);margin-top:1px;">Ajak 1 pedagang lain (yang benar-benar aktif jualan) + 10 pembeli baru lewat link Anda → 1 bulan Premium GRATIS</div>
        </div>
      </div>
      <div id="campaign-progress" style="margin-bottom:10px;">Memuat progres...</div>
      <button class="follow-btn" style="display:block;text-align:center;width:100%;padding:10px;background:var(--brand);color:#fff;" onclick="window.__shareFollowQr('${v.id}','${v.name.replace(/'/g, "\\'")}')">
        📤 Bagikan Link Rekrut
      </button>
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
        <a href="https://wa.me/${ADMIN_WHATSAPP}?text=${encodeURIComponent('Halo, saya ' + v.name + ' (ID: ' + v.id + ') mau upgrade ke Premium JajanDekat.')}"
           target="_blank" class="follow-btn" style="display:block;text-align:center;width:100%;padding:10px;background:var(--brand);color:#fff;">
          💬 Hubungi Admin via WhatsApp
        </a>
      `}
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
      <span style="font-size:14px;">${vendorDone ? '✅' : '⬜'}</span>
      <span style="font-size:11.5px;">1 pedagang aktif direkrut ${vendorDone ? `(${validVendorRecruit.name})` : '— belum ada yang memenuhi syarat'}</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
      <span style="font-size:14px;">${buyerDone ? '✅' : '⬜'}</span>
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

async function generateShareImage({ badgeText, badgeColor, iconSrc, titleText, subtitleText, ctaText, linkText }) {
  const W = 1080, H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Latar
  ctx.fillStyle = '#FAF7F2';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#FF6B4A';
  ctx.lineWidth = 10;
  roundRect(ctx, 15, 15, W - 30, H - 30, 50);
  ctx.stroke();

  // Brand
  ctx.textAlign = 'center';
  ctx.font = '700 56px sans-serif';
  ctx.fillStyle = '#201A13';
  ctx.fillText('Jajan', W / 2 - 60, 110);
  ctx.fillStyle = '#FF6B4A';
  ctx.fillText('Dekat', W / 2 + 75, 110);
  ctx.font = '400 26px sans-serif';
  ctx.fillStyle = '#8A8072';
  ctx.fillText('Cek dulu, baru jalan.', W / 2, 150);

  // Badge status
  ctx.font = '700 30px sans-serif';
  const badgeW = ctx.measureText(badgeText).width + 60;
  const badgeX = W / 2 - badgeW / 2;
  ctx.fillStyle = badgeColor;
  roundRect(ctx, badgeX, 190, badgeW, 60, 30);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(badgeText, W / 2, 230);

  // Ikon vendor / ilustrasi (lingkaran besar tengah)
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

  // Judul & subjudul
  ctx.font = '700 52px sans-serif';
  ctx.fillStyle = '#201A13';
  wrapText(ctx, titleText, W / 2, iconBoxY + iconBoxSize + 90, W - 160, 60);
  ctx.font = '400 30px sans-serif';
  ctx.fillStyle = '#8A8072';
  ctx.fillText(subtitleText, W / 2, iconBoxY + iconBoxSize + 150);

  // Tombol CTA
  const btnW = 560, btnH = 90, btnY = H - 220;
  ctx.fillStyle = '#FF6B4A';
  roundRect(ctx, W / 2 - btnW / 2, btnY, btnW, btnH, 24);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = '700 34px sans-serif';
  ctx.fillText(ctaText, W / 2, btnY + 58);

  // Footer
  ctx.font = '400 26px sans-serif';
  ctx.fillStyle = '#B5AC9C';
  ctx.fillText(linkText, W / 2, H - 60);

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

// Dipanggil dari layar Pedagang
window.__shareStatusImage = async function (vendorId, vendorName) {
  const v = vendors.find(v => v.id === vendorId);
  if (!v) return;
  showToast('Membuat gambar...');
  const iconSrc = v.photo_url || (v.mode_icon ? `mode_icons/${v.mode_icon}.png` : `icons/${(v.categories && v.categories[0]) ? categoryIconFile(v.categories[0]) : 'lainnya.png'}`);
  const link = followLinkFor(vendorId);
  const blob = await generateShareImage({
    badgeText: v.active ? '🟢 SEDANG JUALAN SEKARANG' : 'IKUTI SAYA DI JAJANDEKAT',
    badgeColor: v.active ? '#2FAE60' : '#FF6B4A',
    iconSrc,
    titleText: vendorName,
    subtitleText: (v.categories || []).join(' · ') || 'Pedagang Keliling',
    ctaText: 'Cek Lokasi Sekarang',
    linkText: 'jajandekat.my.id',
  });
  const caption = `${v.active ? `${vendorName} lagi jualan sekarang!` : `Yuk follow ${vendorName} di JajanDekat!`} Cek & follow di: ${link}`;
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

// Deteksi kabupaten/kota otomatis dari GPS, pakai layanan gratis OpenStreetMap (Nominatim)
function detectRegion() {
  return new Promise((resolve) => {
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
}

function normalizeWhatsapp(raw) {
  if (!raw) return raw;
  let n = raw.replace(/[^\d]/g, ''); // buang spasi, strip, tanda +, dll
  if (n.startsWith('0')) n = '62' + n.slice(1);
  else if (!n.startsWith('62')) n = '62' + n;
  return n;
}

window.__registerVendor = async function () {
  const name = document.getElementById('reg-name').value.trim();
  const categories = selectedCategories;
  const category = categories[0] || null; // kolom lama, dijaga tetap terisi untuk kompatibilitas
  const emoji = selectedEmoji;
  const modeIcon = selectedModeIcon;
  const whatsapp = normalizeWhatsapp(document.getElementById('reg-whatsapp').value.trim());
  const pin = document.getElementById('reg-pin').value.trim();
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
      .insert({ name, category, categories, emoji, mode_icon: modeIcon, whatsapp, pin, referred_by_vendor_id: referredByVendorId, region })
      .select('id,name,category,categories,emoji,mode_icon,whatsapp,active,active_until,lat,lng,photo_url,is_premium,premium_until,created_at')
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
    sb.rpc('link_owner_device', { p_vendor_id: data.id, p_pin: pin, p_device_id: deviceId }).catch(() => {});
    ensurePushSubscription();
    renderPedagang();
  } catch (e) {
    errEl.textContent = 'Terjadi kesalahan jaringan. Coba lagi.';
  }
};

window.__forgotPin = function () {
  const sel = document.getElementById('pick-vendor');
  const vendorName = sel && sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '';
  const msg = `Halo, saya lupa PIN akun pedagang JajanDekat saya. Nama usaha: ${vendorName}`;
  window.open(`https://wa.me/${ADMIN_WHATSAPP}?text=${encodeURIComponent(msg)}`, '_blank');
};

window.__pickVendor = async function () {
  const sel = document.getElementById('pick-vendor');
  const pinInput = document.getElementById('pick-pin');
  const errEl = document.getElementById('pick-error');
  if (!sel || !sel.value) return;

  const enteredPin = pinInput ? pinInput.value.trim() : '';
  errEl.textContent = 'Memeriksa...';

  const { data: ok, error } = await sb.rpc('verify_vendor_pin', { p_vendor_id: sel.value, p_pin: enteredPin });
  if (error) { errEl.textContent = 'Gagal memeriksa PIN: ' + error.message; return; }
  if (!ok) { errEl.textContent = 'PIN salah. Coba lagi.'; return; }

  myVendorId = sel.value;
  myVendorPin = enteredPin;
  localStorage.setItem('jd_my_vendor_id', myVendorId);
  sb.rpc('link_owner_device', { p_vendor_id: myVendorId, p_pin: enteredPin, p_device_id: deviceId }).catch(() => {});
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

async function renderAdminDashboard() {
  document.getElementById('mode-toggle-wrap').style.display = 'none';
  document.querySelector('nav.bottom').style.display = 'none';

  main.innerHTML = `
    <div class="section-label">🔒 Dashboard Admin</div>
    <div id="admin-stats" class="stat-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:18px;">
      <div style="color:var(--text-faint);font-size:11px;grid-column:1/-1;">Memuat statistik...</div>
    </div>
    <div class="section-label" style="margin-top:6px;">Daftar Pedagang</div>
    <div id="admin-list" class="vendor-list"><div style="color:var(--text-faint);font-size:12.5px;">Memuat...</div></div>
    <button class="follow-btn" style="margin-top:16px;width:100%;padding:10px;" onclick="window.__exitAdmin()">← Keluar dari Dashboard Admin</button>
  `;

  const { data, error } = await sb.from('vendors').select('id,name,category,categories,emoji,mode_icon,whatsapp,active,active_until,lat,lng,photo_url,is_premium,premium_until,created_at,region').order('created_at', { ascending: false });
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

  document.getElementById('admin-stats').insertAdjacentHTML('afterend', `
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

    <div class="section-label" style="margin-top:4px;">🚩 Laporan Masuk</div>
    <div id="admin-reports" class="vendor-list" style="margin-bottom:14px;"><div style="color:var(--text-faint);font-size:11.5px;">Memuat laporan...</div></div>
  `);
  loadAdminReports();

  listEl.innerHTML = data.map(v => {
    const premiumUntilStr = v.premium_until ? new Date(v.premium_until).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
    return `
    <div class="vendor-card" style="flex-direction:column;align-items:stretch;gap:10px;">
      <div style="display:flex;gap:10px;align-items:center;">
        <div class="vendor-emoji" style="${vendorIconStyle(v)}">${vendorIconInner(v)}</div>
        <div class="vendor-info">
          <div class="vendor-name">${v.name}${v.is_premium ? ' <span class="premium-badge">⭐</span>' : ''}</div>
          <div class="vendor-sub mono">WA: ${v.whatsapp || '-'} · (PIN tersembunyi — pakai "Reset PIN" kalau perlu)</div>
          <div class="vendor-sub">${(v.categories || []).join(' · ') || '-'} · ${v.active ? '🟢 aktif' : '🔴 tidak aktif'}</div>
          ${v.is_premium ? `<div class="vendor-sub" style="color:var(--brand);">⭐ Premium sampai ${premiumUntilStr || '(tanpa batas — akun lama)'}</div>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="follow-btn" onclick="window.__adminResetPin('${v.id}','${v.name.replace(/'/g, "\\'")}')">🔑 Reset PIN</button>
        ${v.photo_url ? `<button class="follow-btn" onclick="window.__adminRemovePhoto('${v.id}')">🖼️ Hapus Foto</button>` : ''}
        <button class="follow-btn" style="color:#f87171;" onclick="window.__adminDeleteVendor('${v.id}','${v.name.replace(/'/g, "\\'")}')">🗑️ Hapus Akun</button>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
        <span style="font-size:10.5px;color:var(--text-faint);">Aktifkan Premium:</span>
        <button class="follow-btn" onclick="window.__adminSetPremium('${v.id}',1)">1 Bln</button>
        <button class="follow-btn" onclick="window.__adminSetPremium('${v.id}',3)">3 Bln</button>
        <button class="follow-btn" onclick="window.__adminSetPremium('${v.id}',6)">6 Bln</button>
        <button class="follow-btn" onclick="window.__adminSetPremium('${v.id}',12)">1 Thn</button>
        ${v.is_premium ? `<button class="follow-btn" style="color:#f87171;" onclick="window.__adminCancelPremium('${v.id}')">✕ Cabut</button>` : ''}
      </div>
    </div>
  `;
  }).join('') || '<div style="color:var(--text-faint);font-size:12.5px;">Belum ada pedagang terdaftar.</div>';
}

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

window.__adminSetPremium = async function (id, months) {
  try {
    const result = await callAdminAction('set_premium_duration', id, { months });
    const untilStr = new Date(result.premium_until).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    alert(`Premium diaktifkan sampai ${untilStr}.`);
    renderAdminDashboard();
  } catch (e) {
    alert('Gagal mengaktifkan Premium: ' + e.message);
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

    renderPembeli();
  } catch (e) {
    console.error(e);
    renderError('Terjadi kesalahan saat mengambil data pedagang dari server. Detail: ' + (e && e.message ? e.message : 'tidak diketahui') + '. Tarik layar ke bawah untuk mencoba lagi.');
  }
}
// ---------- TOMBOL INSTAL APLIKASI (PWA) ----------
// ---------- UPDATE LOKASI BERKALA (biar posisi di peta ikut bergerak, bukan statis) ----------
setInterval(() => {
  if (mode !== 'pedagang' || !myVendorId || myVendorPin === null) return;
  const v = vendors.find(v => v.id === myVendorId);
  if (!v || !v.active || !navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude, longitude } = pos.coords;
    try {
      await sb.rpc('update_vendor_location', { p_vendor_id: v.id, p_pin: myVendorPin, p_lat: latitude, p_lng: longitude });
      v.lat = latitude; v.lng = longitude;
    } catch (e) { console.error('Gagal update lokasi berkala:', e); }
  }, () => {}, { timeout: 8000 });
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
