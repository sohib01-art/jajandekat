/* kesiapan-admin.js : tab "Kesiapan" di Dashboard Admin — panduan kapan layak naik tahap (ojek/pesan-antar).
   Memakai: sb, adminPasswordCache, window.__adminSwitchTab dari app.js. Server: Edge Function admin-kesiapan. */
(function () {
  'use strict';
  var NAMA = { 1: 'Tahap 1 · Pesan via WhatsApp', 2: 'Tahap 2 · Titip beli + ojek (COD)', 3: 'Tahap 3 · Pesanan di app', 4: 'Tahap 4 · Pembayaran + komisi' };
  var ST = { belum: ['Belum', '#f87171'], hampir: ['Hampir', '#F5A524'], siap: ['Siap', '#2FAE60'] };
  var D = null;

  function $(id) { return document.getElementById(id); }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(n) { return Number(n).toLocaleString('id-ID', { maximumFractionDigits: 2 }); }

  async function call(action, extra) {
    var r = await sb.functions.invoke('admin-kesiapan', { body: Object.assign({ password: adminPasswordCache, action: action }, extra || {}) });
    if (r.error) {
      var msg = r.error.message;
      try { var j = await r.error.context.json(); if (j && j.error) msg = j.error; } catch (e) {}
      throw new Error(msg);
    }
    if (r.data && r.data.error) throw new Error(r.data.error);
    return r.data;
  }
  function say(t, ok) { var m = $('ks-msg'); if (m) { m.textContent = t || ''; m.style.color = ok ? '#2FAE60' : '#f87171'; } }

  function nilaiTerakhir() { return D.tren.length ? D.tren[D.tren.length - 1] : {}; }
  function lolosMetrik(s, v) { var n = Number(v == null ? 0 : v); return s.arah === 'min' ? n >= Number(s.ambang) : n <= Number(s.ambang); }

  function spark(key) {
    var pts = D.tren.map(function (x) { return Number(x[key] || 0); });
    if (pts.length < 2) return '<span style="font-size:10px;color:var(--text-faint);">data tren menyusul (butuh ≥2 hari)</span>';
    var max = Math.max.apply(null, pts) || 1, w = 90, h = 22;
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + (i * w / (pts.length - 1)).toFixed(1) + ' ' + (h - p / max * (h - 3) - 1).toFixed(1); }).join(' ');
    return '<svg width="' + w + '" height="' + h + '" style="vertical-align:middle"><path d="' + d + '" fill="none" stroke="var(--brand)" stroke-width="1.6"/></svg>';
  }

  function tahapHtml(s) {
    var tp = s.tahap, v = nilaiTerakhir();
    var syarat = D.syarat.filter(function (x) { return x.tahap === tp; });
    var cek = D.checklist.filter(function (x) { return x.tahap === tp; });
    var lab = ST[s.status], pct = Math.round(Number(s.skor) * 100);
    var tandaiTxt = s.penanda === 'dikerjakan' ? '✅ Sudah dikerjakan' : (s.penanda === 'ditunda' ? '⏸ Ditunda s/d ' + esc(s.ditunda_sampai) : '');
    var h = '<div style="border:1px solid var(--border,#3333);border-radius:14px;padding:12px;margin-top:10px;">' +
      '<div style="display:flex;align-items:center;gap:8px;"><b style="font-size:13px;flex:1;">' + NAMA[tp] + '</b>' +
      '<span style="font-size:11px;font-weight:800;color:#fff;background:' + lab[1] + ';padding:2px 9px;border-radius:99px;">' + lab[0] + '</span></div>' +
      '<div style="height:7px;border-radius:9px;background:var(--border,#3333);margin:8px 0 4px;overflow:hidden;"><div style="width:' + pct + '%;height:100%;background:' + lab[1] + ';"></div></div>' +
      '<div style="font-size:11px;color:var(--text-dim);">Skor ' + pct + '% · lolos berturut-turut ' + s.streak_hari + '/14 hari ' + tandaiTxt + '</div>';
    syarat.forEach(function (m) {
      var n = v[m.metrik], ok = lolosMetrik(m, n);
      h += '<div style="display:flex;align-items:center;gap:6px;margin-top:7px;font-size:12px;">' +
        '<span>' + (ok ? '✅' : '⬜') + '</span><span style="flex:1;">' + esc(m.label) + '<br>' + spark(m.metrik) + '</span>' +
        '<span style="text-align:right;"><b>' + fmt(n || 0) + '</b> / ' + (m.arah === 'max' ? '≤ ' : '≥ ') + fmt(m.ambang) +
        ' <button type="button" class="follow-btn" style="padding:1px 7px;font-size:11px;" onclick="window.__ksAmbang(' + tp + ',\'' + esc(m.metrik) + '\',' + Number(m.ambang) + ')">✏️</button></span></div>';
    });
    cek.forEach(function (c) {
      h += '<label style="display:flex;gap:8px;margin-top:7px;font-size:12px;cursor:pointer;"><input type="checkbox" ' + (c.selesai ? 'checked' : '') +
        ' onchange="window.__ksCek(' + tp + ',\'' + esc(c.kunci) + '\',this.checked)"> <span>📝 ' + esc(c.label) + '</span></label>';
    });
    if (s.penanda !== 'dikerjakan') {
      h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">' +
        '<button type="button" class="follow-btn" style="border-color:var(--brand);color:var(--brand);font-weight:700;" onclick="window.__ksTandai(' + tp + ',\'dikerjakan\')">✅ Sudah dikerjakan</button>' +
        '<button type="button" class="follow-btn" onclick="window.__ksTandai(' + tp + ',\'ditunda\')">⏸ Tunda 7 hari</button></div>';
    } else {
      h += '<div style="margin-top:8px;"><button type="button" class="follow-btn" style="font-size:11px;" onclick="window.__ksTandai(' + tp + ',\'belum\')">↩︎ Batalkan tanda</button></div>';
    }
    return h + '</div>';
  }

  function wilayahHtml() {
    if (!D.wilayah.length) return '<div style="font-size:11.5px;color:var(--text-faint);">Belum ada wilayah dengan aktivitas.</div>';
    return D.wilayah.map(function (w) {
      var chips = [1, 2, 3, 4].map(function (tp) {
        var ss = D.syarat.filter(function (x) { return x.tahap === tp; });
        var ok = ss.length && ss.every(function (m) { return lolosMetrik(m, w[m.metrik]); });
        return '<span style="font-size:10.5px;padding:1px 7px;border-radius:99px;background:' + (ok ? '#2FAE60' : 'var(--border,#3333)') + ';color:' + (ok ? '#fff' : 'var(--text-dim)') + ';">T' + tp + (ok ? ' ✓' : '') + '</span>';
      }).join(' ');
      return '<div style="display:flex;gap:8px;align-items:center;margin-top:6px;font-size:12px;"><span style="flex:1;">' + esc(w.nama) +
        ' <span style="color:var(--text-faint);font-size:10.5px;">' + fmt(w.pedagang_aktif) + ' pedagang · ' + fmt(w.ojek_aktif) + ' ojek</span></span>' + chips + '</div>';
    }).join('');
  }

  function render() {
    var el = $('ks-body'); if (!el) return;
    var h = '';
    if (D.semuaSelesai) h += '<div style="padding:10px;border-radius:12px;background:#2FAE6022;font-size:12.5px;">🎉 Semua tahap sudah ditandai dikerjakan.</div>';
    else if (D.ingatkan) h += '<div style="padding:10px;border-radius:12px;background:#2FAE6022;font-size:12.5px;">🔔 <b>' + NAMA[D.berikut] + '</b> sudah siap. Saatnya dikerjakan atau ditunda.</div>';
    h += '<div style="font-size:11px;color:var(--text-faint);margin-top:6px;">Data terakhir: ' + esc(D.terakhir || 'belum ada') + '. Ambang awal berupa usulan; kalibrasi ulang setelah 3–4 minggu data. Ini panduan, bukan penentu.</div>';
    h += D.status.map(tahapHtml).join('');
    h += '<div class="section-label" style="margin-top:14px;">🗺️ Per wilayah (data terbaru)</div>' + wilayahHtml();
    h += '<div class="section-label" style="margin-top:14px;">🕘 Riwayat</div>';
    h += D.log.length ? D.log.map(function (l) { return '<div style="font-size:11.5px;color:var(--text-dim);margin-top:4px;">' + esc(new Date(l.waktu).toLocaleDateString('id-ID')) +
      ' · ' + (l.tahap ? 'T' + l.tahap + ' · ' : '') + esc(l.peristiwa) + (l.catatan ? ' (' + esc(l.catatan) + ')' : '') + '</div>'; }).join('') : '<div style="font-size:11.5px;color:var(--text-faint);">Belum ada catatan.</div>';
    el.innerHTML = h;
  }

  async function muat(aksi) {
    try { say('Memuat…', true); D = await call(aksi || 'get'); render(); say('', true); updateBadge(); }
    catch (e) { say(e.message); }
  }
  function updateBadge() {
    var b = document.querySelector('.admin-tab[data-tab="kesiapan"]');
    if (b && D) b.textContent = '📈 Kesiapan' + (D.ingatkan ? ' 🔔' : '');
    var old = $('ks-banner'); if (old) old.remove();
    var tabs = document.querySelector('.admin-tabs');
    if (tabs && D && D.ingatkan) {
      var x = document.createElement('div'); x.id = 'ks-banner';
      x.style.cssText = 'margin:8px 0;padding:9px 12px;border-radius:12px;background:#2FAE6022;font-size:12.5px;cursor:pointer;';
      x.innerHTML = '🔔 <b>' + NAMA[D.berikut] + '</b> sudah siap. Ketuk untuk lihat.';
      x.onclick = function () { window.__adminSwitchTab('kesiapan'); };
      tabs.parentNode.insertBefore(x, tabs);
    }
  }

  window.__ksAmbang = async function (tp, metrik, cur) {
    var v = window.prompt('Ambang baru untuk ' + metrik + ' (sekarang ' + cur + '):', cur);
    if (v === null) return;
    var n = Number(String(v).replace(',', '.'));
    if (!isFinite(n) || n < 0) { say('Angka tidak valid'); return; }
    try { await call('set_syarat', { tahap: tp, metrik: metrik, ambang: n }); await muat('hitung'); say('Ambang disimpan & dihitung ulang', true); } catch (e) { say(e.message); }
  };
  window.__ksCek = async function (tp, kunci, val) {
    try { await call('set_checklist', { tahap: tp, kunci: kunci, selesai: val }); await muat('hitung'); } catch (e) { say(e.message); }
  };
  window.__ksTandai = async function (tp, p) {
    try { await call('tandai', { tahap: tp, penanda: p, hari: 7 }); await muat(); } catch (e) { say(e.message); }
  };

  function panelHtml() {
    return '<div class="admin-panel" data-panel="kesiapan" style="display:none;">' +
      '<div class="section-label" style="margin-top:6px;">📈 Kesiapan Tahap</div>' +
      '<div style="font-size:11.5px;color:var(--text-dim);line-height:1.5;">Dihitung otomatis tiap malam dari aktivitas app. Status <b>Siap</b> muncul kalau semua syarat lolos 14 hari berturut-turut dan checklist selesai.</div>' +
      '<div style="margin-top:10px;"><button type="button" class="follow-btn" onclick="window.__ksHitung()">🔄 Hitung sekarang</button></div>' +
      '<div id="ks-msg" style="font-size:11.5px;margin-top:6px;min-height:16px;"></div><div id="ks-body"></div></div>';
  }
  window.__ksHitung = function () { muat('hitung'); };

  function inject() {
    var tabs = document.querySelector('.admin-tabs');
    if (!tabs || tabs.querySelector('[data-tab="kesiapan"]')) return;
    var btn = document.createElement('button');
    btn.className = 'admin-tab'; btn.dataset.tab = 'kesiapan';
    btn.setAttribute('onclick', "window.__adminSwitchTab('kesiapan')");
    btn.textContent = '📈 Kesiapan';
    var after = tabs.querySelector('[data-tab="header"]') || tabs.querySelector('[data-tab="banners"]');
    if (after) after.after(btn); else tabs.appendChild(btn);
    var pAfter = document.querySelector('.admin-panel[data-panel="header"]') || document.querySelector('.admin-panel[data-panel="banners"]');
    var tmp = document.createElement('div'); tmp.innerHTML = panelHtml();
    if (pAfter) pAfter.after(tmp.firstChild); else tabs.parentNode.appendChild(tmp.firstChild);
    var orig = window.__adminSwitchTab;
    if (orig && !orig.__ks) {
      var wrapped = function (t) { orig(t); if (t === 'kesiapan') muat(); };
      wrapped.__ks = true; wrapped.__hd = orig.__hd;   // jaga penanda tab Header
      window.__adminSwitchTab = wrapped;
    }
    // Pengingat: cek sekali saat dashboard admin tampil (tanpa membuka tab)
    call('get').then(function (r) { D = r; updateBadge(); }).catch(function () {});
  }

  var main = document.getElementById('main');
  if (main) { new MutationObserver(inject).observe(main, { childList: true }); inject(); }
})();
