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
  const { data, error } = await withTimeout(sb.from('vendors').select('id,name,category,categories,emoji,whatsapp,active,active_until,lat,lng,photo_url,is_premium,premium_until,created_at').order('name'), 10000, 'Ambil data pedagang');
  if (error) { console.error(error); throw error; }
  return data;
}

async function fetchFollows() {
  const { data, error } = await withTimeout(sb.from('follows').select('vendor_id').eq('device_id', deviceId), 10000, 'Ambil data pengikut');
  if (error) { console.error(error); throw error; }
  return data.map(f => f.vendor_id);
}

async function toggleFollowDb(vendorId, isFollowing) {
  if (isFollowing) {
    await sb.from('follows').delete().eq('device_id', deviceId).eq('vendor_id', vendorId);
  } else {
    await sb.from('follows').insert({ device_id: deviceId, vendor_id: vendorId });
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
      <div class="story-ring" style="${v.active && v.photo_url ? `background-image:url('${v.photo_url}');background-size:cover;background-position:center;` : ''}">${v.active && v.photo_url ? '' : (v.emoji || '🍜')}</div>
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
      <div class="vendor-card">
        <div class="vendor-emoji" style="${v.active && v.photo_url ? `background-image:url('${v.photo_url}');background-size:cover;background-position:center;` : ''}">${v.active && v.photo_url ? '' : (v.emoji || '🍜')}</div>
        <div class="vendor-info">
          <div class="vendor-name">${v.name}${v.is_premium ? ' <span class="premium-badge">⭐ Premium</span>' : ''}</div>
          <div class="vendor-meta">
            <span class="status-dot ${v.active ? 'aktif' : 'nonaktif'}"></span>
            <span class="status-text ${v.active ? 'aktif' : 'nonaktif'} mono">
              ${v.active ? 'SEDANG JUALAN · sampai ' + untilStr : 'Belum jualan'}
            </span>
          </div>
          <div class="vendor-sub">${(v.categories || []).join(' · ')}${v.active && !v.lat ? ' · 📍 lokasi tidak tersedia' : ''}</div>
        </div>
        <button class="follow-btn ${following ? 'following' : ''}" onclick="window.__toggleFollow('${v.id}')">
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
      : `<div style="font-size:22px;filter:drop-shadow(0 0 6px #3DDC97)">${v.emoji || '🍜'}</div>`;
    const icon = L.divIcon({
      html: iconHtml,
      className: '', iconSize: [34, 34]
    });
    markers[v.id] = L.marker([v.lat, v.lng], { icon }).addTo(map).bindPopup(v.name);
  });
}

// ---------- VENDOR VIEW ----------
let myVendorId = localStorage.getItem('jd_my_vendor_id') || null;
let myVendorPin = null; // hanya di memori (tidak disimpan permanen), diminta ulang tiap buka app baru
let pickedDuration = 120;
let selectedEmoji = '🍜';
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

function renderPedagang() {
  if (!myVendorId) {
    const optionsHtml = vendors.map(v => `<option value="${v.id}">${v.name}</option>`).join('');
    const emojiChoices = ['🍜','🍲','🍢','🥟','🍚','🍦','🥤','🍌','🍧','🍰','🌽','🍡','🍗','🥞','🍔','🌭'];
    const emojiHtml = emojiChoices.map(e => `
      <button type="button" class="emoji-choice ${e === selectedEmoji ? 'picked' : ''}" onclick="window.__pickEmoji('${e}')">${e}</button>
    `).join('');

    main.innerHTML = `
      <div class="vendor-hero">
        <div class="vendor-hero-emoji">🛒</div>
        <div class="vendor-hero-name">Daftar Sebagai Pedagang</div>
        <div class="setup-form">
          <input id="reg-name" type="text" placeholder="Nama usaha, misal: Bakso Pak Slamet" />
          <div style="text-align:left;font-size:11px;color:var(--text-faint);margin-top:2px;">Jual apa saja? (boleh pilih lebih dari satu)</div>
          <div class="cat-picker-grid">
            ${CATEGORY_OPTIONS.map(c => `
              <button type="button" class="cat-picker-item ${selectedCategories.includes(c.label) ? 'picked' : ''}" onclick="window.__toggleCategory('${c.label.replace(/'/g, "\\'")}')">
                <img src="icons/${c.icon}.png" alt="${c.label}" />
                <span>${c.label}</span>
              </button>
            `).join('')}
          </div>
          <div style="text-align:left;font-size:11px;color:var(--text-faint);margin-top:2px;">Pilih emoji makanan</div>
          <div class="emoji-grid">${emojiHtml}</div>
          <input id="reg-whatsapp" type="tel" placeholder="Nomor WhatsApp — wajib (contoh: 6281234567890)" />
          <input id="reg-pin" type="tel" inputmode="numeric" maxlength="4" placeholder="Buat PIN 4 digit (untuk keamanan akun)" />
          <button onclick="window.__registerVendor()">🟢 Daftar Sekarang</button>
        </div>
        <div id="reg-error" style="color:#f87171;font-size:12px;margin-top:8px;"></div>
      </div>

      ${vendors.length ? `
        <div class="section-label" style="text-align:left;">Sudah pernah daftar? Masuk ke akun lama</div>
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
      ` : ''}
    `;
    return;
  }

  const v = vendors.find(v => v.id === myVendorId);
  if (!v) { myVendorId = null; localStorage.removeItem('jd_my_vendor_id'); return renderPedagang(); }

  const untilStr = v.active_until
    ? new Date(v.active_until).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    : null;
  const durations = [30, 60, 120, 240];

  main.innerHTML = `
    <div class="vendor-hero">
      <div class="vendor-hero-emoji" style="${v.active && v.photo_url ? `background-image:url('${v.photo_url}');background-size:cover;background-position:center;` : ''}">${v.active && v.photo_url ? '' : (v.emoji || '🍜')}</div>
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
      ${v.is_premium ? `
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:20px;">⭐</span>
          <div>
            <div style="font-family:'Poppins';font-weight:700;font-size:13.5px;">Akun Premium Aktif</div>
            <div style="font-size:11px;color:var(--text-faint);margin-top:1px;">Terima kasih sudah mendukung JajanDekat!</div>
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
    <button class="follow-btn" style="margin-top:14px;width:100%;padding:10px;" onclick="window.__logoutVendor()">Ganti akun pedagang</button>
    <a href="privacy.html" style="display:block;text-align:center;font-size:11px;color:var(--text-faint);margin-top:12px;text-decoration:underline;">Kebijakan Privasi</a>
  `;
}

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

window.__registerVendor = async function () {
  const name = document.getElementById('reg-name').value.trim();
  const categories = selectedCategories;
  const category = categories[0] || null; // kolom lama, dijaga tetap terisi untuk kompatibilitas
  const emoji = selectedEmoji;
  const whatsapp = document.getElementById('reg-whatsapp').value.trim();
  const pin = document.getElementById('reg-pin').value.trim();
  const errEl = document.getElementById('reg-error');

  if (!name) { errEl.textContent = 'Nama usaha wajib diisi.'; return; }
  if (categories.length === 0) { errEl.textContent = 'Pilih minimal 1 jenis jualan.'; return; }
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
    const { data, error } = await sb
      .from('vendors')
      .insert({ name, category, categories, emoji, whatsapp, pin })
      .select('id,name,category,categories,emoji,whatsapp,active,active_until,lat,lng,photo_url,is_premium,premium_until,created_at')
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
    selectedCategories = [];
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

// ---------- SUPER ADMIN (tersembunyi — tap logo 5x) ----------
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
    <div id="admin-list" class="vendor-list"><div style="color:var(--text-faint);font-size:12.5px;">Memuat...</div></div>
    <button class="follow-btn" style="margin-top:16px;width:100%;padding:10px;" onclick="window.__exitAdmin()">← Keluar dari Dashboard Admin</button>
  `;

  const { data, error } = await sb.from('vendors').select('id,name,category,categories,emoji,whatsapp,active,active_until,lat,lng,photo_url,is_premium,premium_until,created_at').order('created_at', { ascending: false });
  const listEl = document.getElementById('admin-list');
  if (error) { listEl.innerHTML = `<div style="color:#f87171;font-size:12.5px;">Gagal memuat: ${error.message}</div>`; return; }

  listEl.innerHTML = data.map(v => `
    <div class="vendor-card" style="flex-direction:column;align-items:stretch;gap:10px;">
      <div style="display:flex;gap:10px;align-items:center;">
        <div class="vendor-emoji" style="${v.photo_url ? `background-image:url('${v.photo_url}');background-size:cover;` : ''}">${v.photo_url ? '' : (v.emoji || '🍜')}</div>
        <div class="vendor-info">
          <div class="vendor-name">${v.name}${v.is_premium ? ' <span class="premium-badge">⭐</span>' : ''}</div>
          <div class="vendor-sub mono">WA: ${v.whatsapp || '-'} · (PIN tersembunyi — pakai "Reset PIN" kalau perlu)</div>
          <div class="vendor-sub">${(v.categories || []).join(' · ') || '-'} · ${v.active ? '🟢 aktif' : '🔴 tidak aktif'}</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="follow-btn" onclick="window.__adminResetPin('${v.id}','${v.name.replace(/'/g, "\\'")}')">🔑 Reset PIN</button>
        <button class="follow-btn ${v.is_premium ? 'following' : ''}" onclick="window.__adminTogglePremium('${v.id}', ${v.is_premium})">⭐ ${v.is_premium ? 'Cabut Premium' : 'Jadikan Premium'}</button>
        ${v.photo_url ? `<button class="follow-btn" onclick="window.__adminRemovePhoto('${v.id}')">🖼️ Hapus Foto</button>` : ''}
        <button class="follow-btn" style="color:#f87171;" onclick="window.__adminDeleteVendor('${v.id}','${v.name.replace(/'/g, "\\'")}')">🗑️ Hapus Akun</button>
      </div>
    </div>
  `).join('') || '<div style="color:var(--text-faint);font-size:12.5px;">Belum ada pedagang terdaftar.</div>';
}

window.__exitAdmin = function () {
  isSuperAdmin = false;
  document.getElementById('mode-toggle-wrap').style.display = '';
  document.querySelector('nav.bottom').style.display = '';
  render_ExitToNormal();
};
function render_ExitToNormal() { mode === 'pembeli' ? renderPembeli() : renderPedagang(); }

async function callAdminAction(action, vendorId) {
  const { data, error } = await sb.functions.invoke('admin-action', {
    body: { password: adminPasswordCache, action, vendor_id: vendorId },
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

window.__adminTogglePremium = async function (id) {
  try {
    await callAdminAction('toggle_premium', id);
    renderAdminDashboard();
  } catch (e) {
    alert('Gagal ubah status: ' + e.message);
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
    renderPembeli();
  } catch (e) {
    console.error(e);
    renderError('Terjadi kesalahan saat mengambil data pedagang dari server. Detail: ' + (e && e.message ? e.message : 'tidak diketahui') + '. Tarik layar ke bawah untuk mencoba lagi.');
  }
}
// ---------- TOMBOL INSTAL APLIKASI (PWA) ----------
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
