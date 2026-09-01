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
  const { data, error } = await withTimeout(sb.from('vendors').select('*').order('name'), 10000, 'Ambil data pedagang');
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
  const payload = { active };
  if (active) {
    payload.active_until = new Date(Date.now() + untilMinutes * 60000).toISOString();
    if (lat != null) payload.lat = lat;
    if (lng != null) payload.lng = lng;
    if (photoUrl !== undefined) payload.photo_url = photoUrl;
  } else {
    payload.active_until = null;
    payload.photo_url = null; // foto ikut hilang begitu selesai jualan
  }
  const { error } = await sb.from('vendors').update(payload).eq('id', vendorId);
  if (error) console.error(error);
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
// ---------- REALTIME ----------
function subscribeRealtime() {
  sb.channel('public:vendors')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'vendors' }, (payload) => {
      const updated = payload.new;
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

  const catList = ['semua', ...Array.from(new Set(vendors.map(v => v.category).filter(Boolean)))];
  const catIcons = { semua: '🍲', Bakso: '🍜', Sate: '🍢', Gorengan: '🥟', Es: '🍦', Mie: '🍲' };
  const catRowHtml = catList.map(c => `
    <button class="cat-chip ${activeCat === c ? 'active' : ''}" onclick="window.__setCat('${c}')">
      <div class="cat-circle">${catIcons[c] || '🍽️'}</div>
      <div class="cat-label">${c === 'semua' ? 'Semua' : c}</div>
    </button>
  `).join('');
  const filteredVendors = activeCat === 'semua' ? vendors : vendors.filter(v => v.category === activeCat);

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
          <div class="vendor-sub">${v.category || ''}</div>
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
      v.name.toLowerCase().includes(q) || (v.category || '').toLowerCase().includes(q)
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
let pickedDuration = 120;
let selectedEmoji = '🍜';

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
          <input id="reg-category" type="text" placeholder="Kategori, misal: Bakso / Sate / Gorengan" />
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
  const category = document.getElementById('reg-category').value.trim();
  const emoji = selectedEmoji;
  const whatsapp = document.getElementById('reg-whatsapp').value.trim();
  const pin = document.getElementById('reg-pin').value.trim();
  const errEl = document.getElementById('reg-error');

  if (!name) { errEl.textContent = 'Nama usaha wajib diisi.'; return; }
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
      .insert({ name, category, emoji, whatsapp, pin })
      .select()
      .single();

    if (error) { errEl.textContent = 'Gagal mendaftar: ' + error.message; return; }

    vendors.push(data);
    myVendorId = data.id;
    localStorage.setItem('jd_my_vendor_id', myVendorId);
    selectedEmoji = '🍜';
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

window.__pickVendor = function () {
  const sel = document.getElementById('pick-vendor');
  const pinInput = document.getElementById('pick-pin');
  const errEl = document.getElementById('pick-error');
  if (!sel || !sel.value) return;

  const v = vendors.find(v => v.id === sel.value);
  const enteredPin = pinInput ? pinInput.value.trim() : '';

  // Pedagang lama (sebelum fitur PIN ada) belum punya PIN — biarkan masuk tanpa PIN.
  if (v && v.pin && v.pin !== enteredPin) {
    errEl.textContent = 'PIN salah. Coba lagi.';
    return;
  }

  myVendorId = sel.value;
  localStorage.setItem('jd_my_vendor_id', myVendorId);
  renderPedagang();
};

window.__logoutVendor = function () {
  myVendorId = null;
  localStorage.removeItem('jd_my_vendor_id');
  renderPedagang();
};

window.__setDuration = function (mins) {
  pickedDuration = mins;
  renderPedagang();
};

window.__toggleStatus = async function () {
  const v = vendors.find(v => v.id === myVendorId);
  if (!v) return;
  if (v.active) {
    await deleteVendorPhotoByUrl(v.photo_url);
    await setVendorStatus(v.id, false);
    v.active = false; v.active_until = null; v.photo_url = null;
  } else {
    // Ambil lokasi nyata dari browser (gratis, bawaan HP)
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude, longitude } = pos.coords;
      let photoUrl = null;
      if (pendingPhotoFile) {
        try { photoUrl = await uploadVendorPhoto(v.id, pendingPhotoFile); }
        catch (e) { console.error('Gagal upload foto:', e); }
      }
      await setVendorStatus(v.id, true, pickedDuration, latitude, longitude, photoUrl);
      v.active = true; v.lat = latitude; v.lng = longitude; v.photo_url = photoUrl;
      v.active_until = new Date(Date.now() + pickedDuration * 60000).toISOString();
      pendingPhotoFile = null; pendingPhotoPreview = null;
      renderPedagang();
    }, async () => {
      // Kalau lokasi ditolak, tetap aktifkan status tanpa koordinat
      let photoUrl = null;
      if (pendingPhotoFile) {
        try { photoUrl = await uploadVendorPhoto(v.id, pendingPhotoFile); }
        catch (e) { console.error('Gagal upload foto:', e); }
      }
      await setVendorStatus(v.id, true, pickedDuration, null, null, photoUrl);
      v.active = true; v.photo_url = photoUrl;
      v.active_until = new Date(Date.now() + pickedDuration * 60000).toISOString();
      pendingPhotoFile = null; pendingPhotoPreview = null;
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

  const { data, error } = await sb.from('vendors').select('*').order('created_at', { ascending: false });
  const listEl = document.getElementById('admin-list');
  if (error) { listEl.innerHTML = `<div style="color:#f87171;font-size:12.5px;">Gagal memuat: ${error.message}</div>`; return; }

  listEl.innerHTML = data.map(v => `
    <div class="vendor-card" style="flex-direction:column;align-items:stretch;gap:10px;">
      <div style="display:flex;gap:10px;align-items:center;">
        <div class="vendor-emoji" style="${v.photo_url ? `background-image:url('${v.photo_url}');background-size:cover;` : ''}">${v.photo_url ? '' : (v.emoji || '🍜')}</div>
        <div class="vendor-info">
          <div class="vendor-name">${v.name}${v.is_premium ? ' <span class="premium-badge">⭐</span>' : ''}</div>
          <div class="vendor-sub mono">PIN: ${v.pin || '(belum ada)'} · WA: ${v.whatsapp || '-'}</div>
          <div class="vendor-sub">${v.category || '-'} · ${v.active ? '🟢 aktif' : '🔴 tidak aktif'}</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="follow-btn" onclick="window.__adminResetPin('${v.id}','${v.name.replace(/'/g, "\\'")}')">🔑 Reset PIN</button>
        <button class="follow-btn ${v.is_premium ? 'following' : ''}" onclick="window.__adminTogglePremium('${v.id}', ${v.is_premium})">⭐ ${v.is_premium ? 'Cabut Premium' : 'Jadikan Premium'}</button>
        <button class="follow-btn" style="color:#f87171;" onclick="window.__adminDeleteVendor('${v.id}','${v.name.replace(/'/g, "\\'")}')">🗑️ Hapus</button>
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

window.__adminResetPin = async function (id, name) {
  const newPin = String(Math.floor(1000 + Math.random() * 9000));
  const { error } = await sb.from('vendors').update({ pin: newPin }).eq('id', id);
  if (error) { alert('Gagal reset: ' + error.message); return; }
  alert(`PIN baru untuk "${name}": ${newPin}\n\nSampaikan ke pedagangnya lewat WhatsApp.`);
  renderAdminDashboard();
};

window.__adminTogglePremium = async function (id, current) {
  const { error } = await sb.from('vendors').update({ is_premium: !current }).eq('id', id);
  if (error) { alert('Gagal ubah status: ' + error.message); return; }
  renderAdminDashboard();
};

window.__adminDeleteVendor = async function (id, name) {
  if (!confirm(`Yakin hapus akun "${name}"? Ini tidak bisa dibatalkan.`)) return;
  const { error } = await sb.from('vendors').delete().eq('id', id);
  if (error) { alert('Gagal hapus: ' + error.message); return; }
  renderAdminDashboard();
};

// ---------- INIT ----------
async function init() {
  if (initError) {
    renderError('Tidak bisa membuat koneksi ke Supabase. Cek internet Anda, lalu tarik layar ke bawah untuk refresh halaman ini.');
    return;
  }
  if (!isConfigured) { renderSetupNeeded(); return; }
  try {
    vendors = await fetchVendors();
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
