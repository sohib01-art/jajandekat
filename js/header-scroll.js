/* header-scroll.js : header Beranda mengecil saat scroll + foto header yang bisa diatur admin.
   Tidak mengubah app.js. */
(function () {
  var header = document.querySelector('header');
  var hs = document.getElementById('hero-search');
  if (!header || !hs) return;
  var root = document.documentElement, ticking = false, jarak = 130;
  var DEFAULT_URL = '/icons/hero-beranda.jpg', DEFAULT_POS = '60% 70%', CACHE_KEY = 'jd_header_photo';

  /* ---------- Foto header (pengaturan dari Dashboard Admin) ---------- */
  function terapkan(s) {
    s = s || {};
    if (s.enabled === false) {                       // admin mematikan foto -> pakai gradient oranye saja
      header.classList.remove('has-photo');
      return;
    }
    var scrim = typeof s.scrim === 'number' ? s.scrim : 0.6;
    root.style.setProperty('--hero-scrim', String(scrim));
    var custom = s.image_url ? s.image_url + (s.v ? '?v=' + s.v : '') : null;
    var url = custom || DEFAULT_URL;
    var im = new Image();
    im.onload = function () {
      root.style.setProperty('--hero-foto', 'url("' + url + '")');
      root.style.setProperty('--hero-pos', custom ? 'center' : DEFAULT_POS);
      header.classList.add('has-photo');
    };
    im.onerror = function () {
      if (custom) terapkan({ enabled: true, scrim: scrim });   // foto kustom gagal dimuat -> foto bawaan
      else header.classList.remove('has-photo');
    };
    im.src = url;
  }
  // Dipanggil juga oleh panel admin setelah menyimpan, agar langsung terlihat
  window.__applyHeaderPhoto = function (s) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(s)); } catch (e) {}
    terapkan(s);
  };

  var cached = null;
  try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) {}
  terapkan(cached || { enabled: true });             // langsung tampil dari cache, tanpa menunggu jaringan

  // Ambil pengaturan terbaru begitu klien Supabase siap (dibuat oleh app.js)
  var tries = 0;
  (function ambil() {
    if (typeof sb !== 'undefined' && sb) {
      sb.from('app_settings').select('value').eq('key', 'header_photo').maybeSingle()
        .then(function (r) {
          var v = r && r.data && r.data.value;
          if (!v) return;
          if (JSON.stringify(v) !== JSON.stringify(cached)) window.__applyHeaderPhoto(v);
        }, function () {});
    } else if (tries++ < 40) {
      setTimeout(ambil, 500);
    }
  })();

  /* ---------- Efek scroll ---------- */
  function update() {
    var p = header.classList.contains('hm-on')
      ? Math.max(0, Math.min(window.scrollY / jarak, 1)) : 0;
    root.style.setProperty('--p', p.toFixed(3));
    ticking = false;
  }
  function ukur() {
    var row = hs.firstElementChild;                 // baris kotak pencarian
    header.classList.toggle('hm-on', !!row);
    root.classList.toggle('hm-home', !!row);
    if (row) {
      var k = row.getBoundingClientRect().top - header.getBoundingClientRect().top;
      k = Math.max(0, Math.round(k));
      root.style.setProperty('--kolaps', k + 'px');   // bagian atas yang boleh tergulung keluar
      jarak = k + 60;                                  // jarak scroll sampai header selesai mengecil
    }
    update();
  }

  addEventListener('scroll', function () {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true });
  addEventListener('resize', ukur);
  addEventListener('load', ukur);
  new MutationObserver(ukur).observe(hs, { childList: true });          // pindah halaman
  var br = header.querySelector('.brand-row');
  if (br && window.ResizeObserver) new ResizeObserver(ukur).observe(br); // label wilayah muncul
  ukur();
})();
