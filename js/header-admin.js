/* header-admin.js : tab "Header" di Dashboard Admin untuk mengganti foto header beranda,
   lengkap dengan alat pemotong (geser + zoom + putar), panduan area teks, dan pengaturan gelap atas.
   Memakai: sb, adminPasswordCache, window.__adminSwitchTab, window.__openPhotoChooser dari app.js.
   Server: tabel app_settings + Edge Function admin-header. */
(function () {
  'use strict';
  var RATIO = 1.6, OUT_W = 1000, OUT_H = 625;          // rasio 16:10, hasil 1000 x 625 px
  var DEFAULT_URL = '/icons/hero-beranda.jpg', DEFAULT_POS = '60% 70%';   // harus sama dengan header-scroll.js
  var cur = { image_url: null, enabled: true, scrim: 0.6 };      // kondisi di server
  var edit = { enabled: true, scrim: 0.6, blob: null, blobUrl: null, img: null }; // perubahan belum disimpan

  function $(id) { return document.getElementById(id); }
  function esc(t) { return String(t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  async function call(action, extra) {
    var r = await sb.functions.invoke('admin-header', { body: Object.assign({ password: adminPasswordCache, action: action }, extra || {}) });
    if (r.error) {
      var msg = r.error.message;
      try { var j = await r.error.context.json(); if (j && j.error) msg = j.error; } catch (e) {}
      throw new Error(msg);
    }
    if (r.data && r.data.error) throw new Error(r.data.error);
    return r.data;
  }
  function say(text, ok) {
    var m = $('hd-msg'); if (!m) return;
    m.textContent = text || '';
    m.style.color = ok ? '#2FAE60' : '#f87171';
  }

  /* ---------- Panel ---------- */
  var ROW = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px;';
  function panelHtml() {
    return '' +
    '<div class="admin-panel" data-panel="header" style="display:none;">' +
      '<div class="section-label" style="margin-top:6px;">🖼️ Foto Header Beranda</div>' +
      '<div style="font-size:11.5px;color:var(--text-dim);line-height:1.5;">Foto di belakang logo dan kotak pencarian pada Beranda pembeli. Foto memudar ke warna oranye saat halaman di-scroll.</div>' +
      '<div id="hd-preview" style="position:relative;aspect-ratio:1.6;border-radius:16px;overflow:hidden;margin-top:10px;background:linear-gradient(160deg,#FF8A3D,#FF6B4A) center/cover no-repeat;">' +
        '<div id="hd-scrim" style="position:absolute;inset:0;"></div>' +
        '<div style="position:absolute;left:4.6%;top:5.7%;display:flex;align-items:center;gap:8px;color:#fff;font-family:Poppins,sans-serif;font-weight:800;font-size:15px;"><span style="width:20px;height:24px;border-radius:50% 50% 50% 20%;background:#fff;display:inline-block;"></span>JajanDekat</div>' +
        '<div style="position:absolute;left:4.6%;right:4.6%;top:28.7%;height:18.5%;display:flex;gap:2.5%;"><div style="flex:1;background:#fff;border-radius:99px;opacity:.95;"></div><div style="width:11%;background:rgba(255,231,223,.95);border-radius:50%;"></div></div>' +
        '<div style="position:absolute;left:4.6%;top:51.6%;color:#fff;font-size:11px;font-weight:600;">📍 Di sekitar kamu ⌄</div>' +
        '<div id="hd-badge" style="position:absolute;right:8px;bottom:8px;background:rgba(0,0,0,.55);color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:10px;"></div>' +
      '</div>' +
      '<div style="font-size:10px;color:var(--text-faint);margin-top:4px;">Pratinjau perkiraan tampilan di HP. Logo dan pencarian menutupi bagian atas; foto paling jelas terlihat di bagian bawah.</div>' +
      '<input type="file" id="hd-input" accept="image/*" style="display:none" onchange="window.__hdFileSelected(event)" />' +
      '<div style="' + ROW + '">' +
        '<button type="button" class="follow-btn" onclick="window.__openPhotoChooser(\'hd-input\')">📷 Pilih / ganti foto</button>' +
        '<button type="button" class="follow-btn" id="hd-recrop" onclick="window.__hdRecrop()" style="display:none;">✂️ Potong ulang</button>' +
      '</div>' +
      '<label style="' + ROW + 'font-size:12.5px;cursor:pointer;"><input type="checkbox" id="hd-enabled" onchange="window.__hdEnabled(this.checked)" /> Tampilkan foto di header (matikan = gradient oranye polos)</label>' +
      '<div style="margin-top:10px;font-size:12px;color:var(--text-dim);">Gelap di bagian atas: <b id="hd-scrim-val">60%</b> <span style="color:var(--text-faint);">(supaya teks putih tetap terbaca)</span></div>' +
      '<input type="range" id="hd-scrim-range" min="0" max="80" step="5" style="width:100%;" oninput="window.__hdScrim(this.value)" />' +
      '<div style="' + ROW + '">' +
        '<button type="button" id="hd-save" class="follow-btn" style="border-color:var(--brand);color:var(--brand);font-weight:700;" onclick="window.__hdSave()">💾 Simpan perubahan</button>' +
        '<button type="button" class="follow-btn" style="color:#f87171;margin-left:auto;" onclick="window.__hdReset()">↩︎ Kembalikan foto bawaan</button>' +
      '</div>' +
      '<div id="hd-msg" style="font-size:11.5px;margin-top:8px;min-height:16px;"></div>' +
      '<details style="margin-top:10px;font-size:11.5px;line-height:1.55;color:var(--text-dim);">' +
        '<summary style="cursor:pointer;font-weight:700;font-size:13px;color:var(--text);">📐 Panduan foto header</summary>' +
        '<div style="margin-top:6px;"><b>Rasio:</b> 16:10 (hasil 1000 × 625 px, otomatis dikecilkan ±100–200 KB). Pakai alat pemotong untuk mengatur bagian yang tampil.<br>' +
        '<b>Komposisi:</b> taruh objek utama (makanan/pedagang) di sepertiga bawah. Bagian atas tertutup logo dan pencarian; aktifkan "Panduan" di alat pemotong untuk melihat area itu.<br>' +
        '<b>Hindari:</b> foto dengan teks/poster di atasnya (akan tertimpa), dan foto gelap atau terlalu ramai.<br>' +
        '<b>Resolusi:</b> minimal 800 px lebar agar tajam di HP. Perubahan tampil di pembeli setelah aplikasi dibuka ulang (paling lama beberapa menit).</div>' +
      '</details>' +
    '</div>';
  }

  function inject() {
    var tabs = document.querySelector('.admin-tabs');
    if (!tabs || tabs.querySelector('[data-tab="header"]')) return;
    var btn = document.createElement('button');
    btn.className = 'admin-tab'; btn.dataset.tab = 'header';
    btn.setAttribute('onclick', "window.__adminSwitchTab('header')");
    btn.textContent = '🏞️ Header';
    var after = tabs.querySelector('[data-tab="banners"]');
    if (after) after.after(btn); else tabs.appendChild(btn);
    var pAfter = document.querySelector('.admin-panel[data-panel="banners"]');
    var tmp = document.createElement('div'); tmp.innerHTML = panelHtml();
    if (pAfter) pAfter.after(tmp.firstChild); else tabs.parentNode.appendChild(tmp.firstChild);
    var orig = window.__adminSwitchTab;
    if (orig && !orig.__hd) {
      window.__adminSwitchTab = function (t) { orig(t); if (t === 'header') muat(); };
      window.__adminSwitchTab.__hd = true;
    }
  }

  async function muat() {
    try {
      var r = await call('get_header');
      cur = r.header;
      resetEdit();
      say('');
    } catch (e) { say('Gagal memuat: ' + e.message); }
    render();
  }
  function resetEdit() {
    if (edit.blobUrl) URL.revokeObjectURL(edit.blobUrl);
    edit = { enabled: cur.enabled !== false, scrim: typeof cur.scrim === 'number' ? cur.scrim : 0.6, blob: null, blobUrl: null, img: null };
  }
  function render() {
    var pv = $('hd-preview'); if (!pv) return;
    var url = edit.blobUrl || cur.image_url || DEFAULT_URL;
    if (edit.enabled) pv.style.backgroundImage = 'url("' + url + '")';
    else pv.style.backgroundImage = 'none';
    pv.style.backgroundPosition = (edit.blobUrl || cur.image_url) ? 'center' : DEFAULT_POS;   // sama dengan tampilan asli
    var s = edit.scrim;
    $('hd-scrim').style.background = edit.enabled
      ? 'linear-gradient(180deg,rgba(90,10,0,' + s + '),rgba(90,10,0,' + (s * 0.33).toFixed(3) + ') 55%,rgba(90,10,0,0))' : 'none';
    $('hd-enabled').checked = edit.enabled;
    $('hd-scrim-range').value = Math.round(s * 100);
    $('hd-scrim-val').textContent = Math.round(s * 100) + '%';
    $('hd-badge').textContent = edit.blob ? 'Belum disimpan' : (cur.image_url ? 'Foto kustom' : 'Foto bawaan');
    $('hd-recrop').style.display = edit.img ? '' : 'none';
  }

  window.__hdEnabled = function (v) { edit.enabled = !!v; render(); };
  window.__hdScrim = function (v) { edit.scrim = Math.round(Number(v)) / 100; render(); };

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var u = URL.createObjectURL(file), im = new Image();
      im.onload = function () { URL.revokeObjectURL(u); resolve(im); };
      im.onerror = function () { URL.revokeObjectURL(u); reject(new Error('Format gambar tidak didukung.')); };
      im.src = u;
    });
  }
  async function crop(img) {
    var r = await openCropper(img, edit.scrim);
    if (!r) return;
    if (edit.blobUrl) URL.revokeObjectURL(edit.blobUrl);
    edit.img = img; edit.blob = r.blob; edit.blobUrl = URL.createObjectURL(r.blob); edit.scrim = r.scrim; edit.enabled = true;
    say('Foto siap. Tekan "Simpan perubahan" untuk menayangkan.', true);
    render();
  }
  window.__hdFileSelected = async function (ev) {
    var input = ev.target, f = input.files && input.files[0];
    if (!f) return;
    try {
      if (f.size > 25 * 1024 * 1024) throw new Error('File terlalu besar (maks. 25 MB).');
      var img = await loadImage(f);
      if (Math.min(img.naturalWidth, img.naturalHeight) < 300) throw new Error('Gambar terlalu kecil (minimal 300 px).');
      await crop(img);
    } catch (e) { say(e.message); }
    input.value = '';
  };
  window.__hdRecrop = function () { if (edit.img) crop(edit.img); };

  window.__hdSave = async function () {
    var btn = $('hd-save'); btn.disabled = true; say('Menyimpan…', true);
    try {
      var res;
      if (edit.blob) {
        var path = 'banners/header-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jpg';
        var up = await sb.storage.from('vendor-photos').upload(path, edit.blob, { contentType: 'image/jpeg', upsert: false });
        if (up.error) throw up.error;
        var pub = sb.storage.from('vendor-photos').getPublicUrl(path).data.publicUrl;
        res = await call('save_header', { image_url: pub, enabled: edit.enabled, scrim: edit.scrim });
      } else {
        if (edit.enabled !== (cur.enabled !== false)) res = await call('set_enabled', { enabled: edit.enabled });
        if (edit.scrim !== cur.scrim) res = await call('set_scrim', { scrim: edit.scrim });
        if (!res) { say('Belum ada perubahan.', true); return; }
      }
      cur = res.header; resetEdit(); render();
      if (window.__applyHeaderPhoto) window.__applyHeaderPhoto(cur);
      say('Tersimpan ✓ Pembeli akan melihatnya saat membuka aplikasi.', true);
    } catch (e) { say('Gagal menyimpan: ' + (e.message || e)); }
    finally { btn.disabled = false; }
  };

  window.__hdReset = async function () {
    if (!confirm('Kembalikan ke foto header bawaan? Foto kustom yang sekarang akan dihapus.')) return;
    try {
      var res = await call('reset_header');
      cur = res.header; resetEdit(); render();
      if (window.__applyHeaderPhoto) window.__applyHeaderPhoto(cur);
      say('Dikembalikan ke foto bawaan ✓', true);
    } catch (e) { say('Gagal: ' + e.message); }
  };

  /* ---------- Alat pemotong ---------- */
  function openCropper(srcImg, scrim0) {
    return new Promise(function (resolve) {
      var fw = Math.min(innerWidth - 32, 440), fh = fw / RATIO;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var src = srcImg, sw = srcImg.naturalWidth, sh = srcImg.naturalHeight, rot = 0;
      var z = 1, ox = 0, oy = 0, scrim = scrim0, guide = true;

      var ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;z-index:300;background:rgba(10,8,6,.94);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:16px;overflow:auto;color:#fff;font-family:Inter,sans-serif;';
      var B = 'padding:9px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.35);background:transparent;color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;';
      ov.innerHTML =
        '<div style="font-family:Poppins,sans-serif;font-weight:700;font-size:15px;">✂️ Potong foto header</div>' +
        '<div style="font-size:11px;opacity:.75;text-align:center;max-width:' + fw + 'px;">Geser untuk memosisikan, cubit atau geser slider untuk zoom. Taruh objek utama di bawah garis putus-putus.</div>' +
        '<canvas id="hdc" style="width:' + fw + 'px;height:' + fh + 'px;border-radius:14px;touch-action:none;background:#222;cursor:grab;"></canvas>' +
        '<div id="hdc-info" style="font-size:10.5px;min-height:14px;"></div>' +
        '<div style="width:' + fw + 'px;display:grid;gap:8px;">' +
          '<label style="font-size:11.5px;display:flex;align-items:center;gap:8px;">🔍 Zoom <input id="hdc-zoom" type="range" min="100" max="400" value="100" style="flex:1;" /></label>' +
          '<label style="font-size:11.5px;display:flex;align-items:center;gap:8px;">🌗 Gelap atas <input id="hdc-scrim" type="range" min="0" max="80" step="5" value="' + Math.round(scrim * 100) + '" style="flex:1;" /><b id="hdc-scrim-v" style="width:34px;text-align:right;">' + Math.round(scrim * 100) + '%</b></label>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<button type="button" id="hdc-rot" style="' + B + '">⟳ Putar 90°</button>' +
            '<button type="button" id="hdc-reset" style="' + B + '">Reset posisi</button>' +
            '<label style="font-size:11.5px;display:flex;align-items:center;gap:6px;margin-left:auto;"><input id="hdc-guide" type="checkbox" checked /> Panduan</label>' +
          '</div>' +
          '<div style="display:flex;gap:8px;">' +
            '<button type="button" id="hdc-cancel" style="' + B + 'flex:1;">Batal</button>' +
            '<button type="button" id="hdc-ok" style="flex:2;padding:11px;border-radius:10px;border:none;background:linear-gradient(135deg,#FF8A3D,#FF6B4A);color:#fff;font-weight:700;font-size:13px;cursor:pointer;">Gunakan foto ini</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(ov);

      var cv = ov.querySelector('#hdc'), ctx = cv.getContext('2d');
      cv.width = Math.round(fw * dpr); cv.height = Math.round(fh * dpr);

      function scale() { return Math.max(fw / sw, fh / sh) * z; }
      function clamp() { var s = scale(); ox = Math.min(0, Math.max(fw - sw * s, ox)); oy = Math.min(0, Math.max(fh - sh * s, oy)); }
      function center() { var s = scale(); ox = (fw - sw * s) / 2; oy = (fh - sh * s) / 2; }

      function drawGuide() {
        var k = fw / 390;
        ctx.save();
        ctx.setLineDash([4, 3]); ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.fillStyle = 'rgba(255,255,255,.16)';
        function box(x, y, w, h) { ctx.beginPath(); ctx.rect(x * k, y * k, w * k, h * k); ctx.fill(); ctx.stroke(); }
        function circ(x, y, r) { ctx.beginPath(); ctx.arc(x * k, y * k, r * k, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
        box(18, 14, 230, 42); circ(390 - 18 - 19, 35, 19);      // logo + bel
        box(18, 70, 390 - 36 - 56, 46); circ(390 - 18 - 23, 93, 23); // pencarian + filter
        box(18, 126, 130, 20);                                   // lokasi
        ctx.beginPath(); ctx.moveTo(0, 150 * k); ctx.lineTo(fw, 150 * k); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.font = '600 ' + Math.max(9, 10 * k) + 'px Inter,sans-serif';
        ctx.fillText('foto terlihat jelas di bawah garis ini', 8, 150 * k + 13 * k);
        ctx.restore();
      }
      function draw() {
        clamp();
        var s = scale();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, fw, fh);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, ox, oy, sw * s, sh * s);
        var g = ctx.createLinearGradient(0, 0, 0, fh);
        g.addColorStop(0, 'rgba(90,10,0,' + scrim + ')');
        g.addColorStop(0.55, 'rgba(90,10,0,' + (scrim * 0.33) + ')');
        g.addColorStop(1, 'rgba(90,10,0,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, fw, fh);
        if (guide) drawGuide();
        var px = Math.round(fw / s), info = ov.querySelector('#hdc-info');
        info.textContent = 'Area terpilih ±' + px + ' px dari foto asli' + (px < 700 ? ' — resolusi rendah, bisa terlihat buram' : '');
        info.style.color = px < 700 ? '#fbbf24' : 'rgba(255,255,255,.7)';
      }
      function setZoom(nz, cx, cy) {
        nz = Math.max(1, Math.min(4, nz));
        var s0 = scale(), px = (cx - ox) / s0, py = (cy - oy) / s0;
        z = nz; var s1 = scale(); ox = cx - px * s1; oy = cy - py * s1;
        ov.querySelector('#hdc-zoom').value = Math.round(z * 100);
        draw();
      }

      var ptrs = new Map();
      cv.addEventListener('pointerdown', function (e) {
        cv.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing';
        ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      });
      cv.addEventListener('pointermove', function (e) {
        if (!ptrs.has(e.pointerId)) return;
        var prev = ptrs.get(e.pointerId), rect = cv.getBoundingClientRect();
        if (ptrs.size === 1) {
          ox += e.clientX - prev.x; oy += e.clientY - prev.y;
          ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); draw();
        } else if (ptrs.size === 2) {
          var other = null; ptrs.forEach(function (v, id) { if (id !== e.pointerId) other = v; });
          var d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
          ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
          var d1 = Math.hypot(e.clientX - other.x, e.clientY - other.y);
          if (d0 > 0) setZoom(z * d1 / d0, (e.clientX + other.x) / 2 - rect.left, (e.clientY + other.y) / 2 - rect.top);
        }
      });
      function up(e) { ptrs.delete(e.pointerId); if (!ptrs.size) cv.style.cursor = 'grab'; }
      cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
      cv.addEventListener('wheel', function (e) {
        e.preventDefault();
        var rect = cv.getBoundingClientRect();
        setZoom(z * (e.deltaY < 0 ? 1.08 : 0.93), e.clientX - rect.left, e.clientY - rect.top);
      }, { passive: false });

      ov.querySelector('#hdc-zoom').oninput = function () { setZoom(this.value / 100, fw / 2, fh / 2); };
      ov.querySelector('#hdc-scrim').oninput = function () {
        scrim = Number(this.value) / 100; ov.querySelector('#hdc-scrim-v').textContent = this.value + '%'; draw();
      };
      ov.querySelector('#hdc-guide').onchange = function () { guide = this.checked; draw(); };
      ov.querySelector('#hdc-reset').onclick = function () { z = 1; ov.querySelector('#hdc-zoom').value = 100; center(); draw(); };
      ov.querySelector('#hdc-rot').onclick = function () {
        rot = (rot + 1) % 4;
        var w0 = srcImg.naturalWidth, h0 = srcImg.naturalHeight, c = document.createElement('canvas');
        c.width = rot % 2 ? h0 : w0; c.height = rot % 2 ? w0 : h0;
        var x = c.getContext('2d'); x.translate(c.width / 2, c.height / 2); x.rotate(rot * Math.PI / 2); x.drawImage(srcImg, -w0 / 2, -h0 / 2);
        src = c; sw = c.width; sh = c.height; z = 1; ov.querySelector('#hdc-zoom').value = 100; center(); draw();
      };
      ov.querySelector('#hdc-cancel').onclick = function () { ov.remove(); resolve(null); };
      ov.querySelector('#hdc-ok').onclick = function () {
        var s = scale(), out = document.createElement('canvas');
        out.width = OUT_W; out.height = OUT_H;
        var c = out.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, OUT_W, OUT_H); c.imageSmoothingQuality = 'high';
        c.drawImage(src, -ox / s, -oy / s, fw / s, fh / s, 0, 0, OUT_W, OUT_H);
        var q = 0.84;
        (function enc() {
          out.toBlob(function (b) {
            if (b && b.size > 220 * 1024 && q > 0.6) { q -= 0.08; enc(); return; }   // jaga ukuran tetap ringan
            ov.remove(); resolve(b ? { blob: b, scrim: scrim } : null);
          }, 'image/jpeg', q);
        })();
      };

      center(); draw();
    });
  }

  /* ---------- Pasang tab saat Dashboard Admin dirender ---------- */
  var main = document.getElementById('main');
  if (main) {
    new MutationObserver(inject).observe(main, { childList: true });
    inject();
  }
})();
