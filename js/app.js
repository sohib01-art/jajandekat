// ============================================
// JajanDekat — app.js
// Biaya nol: Leaflet+OpenStreetMap (peta) + Supabase free tier (data & realtime)
// ============================================

const isConfigured = !SUPABASE_URL.includes("ISI-PROJECT-ID");
let supabase = null;
if (isConfigured) {
  supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
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
let map = null;
let markers = {};

const main = document.getElementById('main');
const btnPembeli = document.getElementById('btn-pembeli');
const btnPedagang = document.getElementById('btn-pedagang');

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
async function fetchVendors() {
  const { data, error } = await supabase.from('vendors').select('*').order('name');
  if (error) { console.error(error); return []; }
  return data;
}

async function fetchFollows() {
  const { data, error } = await supabase.from('follows').select('vendor_id').eq('device_id', deviceId);
  if (error) { console.error(error); return []; }
  return data.map(f => f.vendor_id);
}

async function toggleFollowDb(vendorId, isFollowing) {
  if (isFollowing) {
    await supabase.from('follows').delete().eq('device_id', deviceId).eq('vendor_id', vendorId);
  } else {
    await supabase.from('follows').insert({ device_id: deviceId, vendor_id: vendorId });
  }
}

async function setVendorStatus(vendorId, active, untilMinutes, lat, lng) {
  const payload = { active };
  if (active) {
    payload.active_until = new Date(Date.now() + untilMinutes * 60000).toISOString();
    if (lat != null) payload.lat = lat;
    if (lng != null) payload.lng = lng;
  } else {
    payload.active_until = null;
  }
  const { error } = await supabase.from('vendors').update(payload).eq('id', vendorId);
  if (error) console.error(error);
}

// ---------- REALTIME ----------
function subscribeRealtime() {
  supabase.channel('public:vendors')
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
  const followed = vendors.filter(v => followedIds.has(v.id));

  const storyHtml = followed.map(v => `
    <button class="story ${v.active ? 'on' : ''}" onclick="window.__toggleFollow('${v.id}')">
      <div class="story-ring">${v.emoji || '🍜'}</div>
      <div class="story-name">${v.name.split(' ')[0]}</div>
    </button>
  `).join('');

  const listHtml = vendors.map(v => {
    const following = followedIds.has(v.id);
    const untilStr = v.active_until
      ? new Date(v.active_until).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
      : null;
    return `
      <div class="vendor-card">
        <div class="vendor-emoji">${v.emoji || '🍜'}</div>
        <div class="vendor-info">
          <div class="vendor-name">${v.name}</div>
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

  main.innerHTML = `
    <div class="section-label">Pedagang yang kamu ikuti</div>
    <div class="stories">${storyHtml || '<div style="color:var(--text-faint);font-size:12px;padding:8px 0;">Belum ada yang diikuti.</div>'}</div>
    <div id="map"></div>
    <div class="section-label">Semua pedagang</div>
    <div class="vendor-list">${listHtml || '<div style="color:var(--text-faint);font-size:13px;">Belum ada pedagang terdaftar.</div>'}</div>
  `;
  renderMap();
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
    const icon = L.divIcon({
      html: `<div style="font-size:22px;filter:drop-shadow(0 0 6px #3DDC97)">${v.emoji || '🍜'}</div>`,
      className: '', iconSize: [30, 30]
    });
    markers[v.id] = L.marker([v.lat, v.lng], { icon }).addTo(map).bindPopup(v.name);
  });
}

// ---------- VENDOR VIEW ----------
let myVendorId = localStorage.getItem('jd_my_vendor_id') || null;
let pickedDuration = 120;

function renderPedagang() {
  if (!myVendorId) {
    const optionsHtml = vendors.map(v => `<option value="${v.id}">${v.name}</option>`).join('');
    main.innerHTML = `
      <div class="vendor-hero">
        <div class="vendor-hero-emoji">🛒</div>
        <div class="vendor-hero-name">Pilih akun pedagang Anda</div>
        <div class="setup-form">
          <select id="pick-vendor" style="background:var(--surface-2);border:1px solid var(--stroke);border-radius:10px;padding:10px;color:var(--text);">
            ${optionsHtml || '<option>Belum ada pedagang terdaftar</option>'}
          </select>
          <button onclick="window.__pickVendor()">Masuk sebagai pedagang ini</button>
        </div>
      </div>
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
      <div class="vendor-hero-emoji">${v.emoji || '🍜'}</div>
      <div class="vendor-hero-name">${v.name}</div>
      <div class="vendor-hero-status ${v.active ? 'live' : ''} mono">
        ${v.active ? '🟢 SEDANG JUALAN · sampai ' + untilStr : '🔴 Belum jualan hari ini'}
      </div>

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
    <button class="follow-btn" style="margin-top:14px;width:100%;padding:10px;" onclick="window.__logoutVendor()">Ganti akun pedagang</button>
  `;
}

window.__pickVendor = function () {
  const sel = document.getElementById('pick-vendor');
  if (!sel || !sel.value) return;
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
    await setVendorStatus(v.id, false);
    v.active = false; v.active_until = null;
  } else {
    // Ambil lokasi nyata dari browser (gratis, bawaan HP)
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude, longitude } = pos.coords;
      await setVendorStatus(v.id, true, pickedDuration, latitude, longitude);
      v.active = true; v.lat = latitude; v.lng = longitude;
      v.active_until = new Date(Date.now() + pickedDuration * 60000).toISOString();
      renderPedagang();
    }, async () => {
      // Kalau lokasi ditolak, tetap aktifkan status tanpa koordinat
      await setVendorStatus(v.id, true, pickedDuration, null, null);
      v.active = true;
      v.active_until = new Date(Date.now() + pickedDuration * 60000).toISOString();
      renderPedagang();
    });
    return;
  }
  renderPedagang();
};

window.__toggleFollow = async function (vendorId) {
  const isFollowing = followedIds.has(vendorId);
  if (isFollowing) followedIds.delete(vendorId); else followedIds.add(vendorId);
  renderPembeli();
  await toggleFollowDb(vendorId, isFollowing);
};

// ---------- MODE SWITCH ----------
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

// ---------- INIT ----------
async function init() {
  if (!isConfigured) { renderSetupNeeded(); return; }
  vendors = await fetchVendors();
  const followList = await fetchFollows();
  followedIds = new Set(followList);
  subscribeRealtime();
  renderPembeli();
}
init();
