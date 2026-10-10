// Membuat halaman artikel STATIS dari tabel Supabase `articles` (dijalankan oleh GitHub Actions, Node 22).
// Hasil: artikel/index.html (daftar), artikel/<slug>/index.html (per artikel), sitemap.xml (beranda + daftar + semua artikel)
import { mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';

const SITE = 'https://jajandekat.my.id';
const SUPABASE_URL = 'https://lzcvykadtpqiqaebmmbh.supabase.co';
const ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6Y3Z5a2FkdHBxaXFhZWJtbWJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwOTIzODMsImV4cCI6MjEwMzY2ODM4M30.uY4lkVvdYWW7bTR1gyvoQempvbMGNyHJQRYITKsKgtQ';
const MARK = '<!-- dibuat-otomatis: build-artikel.mjs -->';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tgl = (d) => new Date(d).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Makassar' });
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const ringkas = (md, n = 155) => {
  const t = String(md || '').replace(/[#*_>`-]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '') + '…';
};

function inlineMd(str) {
  let s = esc(str).replace(/&quot;/g, '"');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  return s;
}
function mdToHtml(md) {
  let html = '', list = [];
  const flush = () => { if (list.length) { html += '<ul>' + list.map((l) => `<li>${inlineMd(l)}</li>`).join('') + '</ul>'; list = []; } };
  for (const block of String(md || '').split(/\n\n+/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length && lines.every((l) => /^[-*]\s+/.test(l))) { lines.forEach((l) => list.push(l.replace(/^[-*]\s+/, ''))); continue; }
    flush();
    const h = block.match(/^(#{1,3})\s+(.*)$/);
    if (h) { const lv = Math.max(2, h[1].length); html += `<h${lv}>${inlineMd(h[2])}</h${lv}>`; continue; }
    if (block.trim()) html += `<p>${inlineMd(block).replace(/\n/g, '<br>')}</p>`;
  }
  flush();
  return html;
}

const CSS = `:root{--o:#FF6B4A;--od:#E0532F;--cream:#F8F4EC;--ink:#2B2420;--soft:#6B6058;--b:#EAE2D6}*{box-sizing:border-box}
body{margin:0;background:var(--cream);color:var(--ink);font-family:"Segoe UI",system-ui,-apple-system,sans-serif;line-height:1.6}
header.top{background:var(--o);color:#fff;padding:16px 20px}header.top a{color:#fff;text-decoration:none}
.brand{font-size:21px;font-weight:800}.brand span{opacity:.85;font-weight:600}.nav{margin-top:6px;font-size:13px;opacity:.95}.nav a{margin-right:14px;font-weight:700}
main{max-width:680px;margin:0 auto;padding:20px 16px 50px}h1{font-size:25px;line-height:1.25;margin:0 0 12px}h2{font-size:19px;margin:24px 0 8px}h3{font-size:16.5px;margin:20px 0 8px}
.meta{font-size:12px;font-weight:700;color:var(--od);text-transform:uppercase;letter-spacing:.02em;margin-bottom:6px}
.cover{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:14px;margin-bottom:16px;background:var(--b)}
ul{padding-left:20px}li{margin-bottom:6px}.cta{display:block;margin:26px 0;padding:14px;border-radius:14px;background:#fff;border:1px solid var(--b);text-decoration:none;color:var(--ink)}
.cta b{color:var(--od)}.more a{display:block;padding:9px 0;border-bottom:1px solid var(--b);color:var(--ink);text-decoration:none;font-size:14.5px}
.card{display:block;background:#fff;border:1px solid var(--b);border-radius:14px;padding:12px;margin-bottom:10px;text-decoration:none;color:inherit}
.card h3{margin:2px 0 4px;font-size:15.5px}.card p{margin:0;font-size:13.5px;color:var(--soft)}
footer{text-align:center;font-size:12px;color:var(--soft);padding:24px 16px 40px}`;

const head = (title, desc, canon, extra = '') => `<!doctype html>
${MARK}
<html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${canon}">
<meta name="theme-color" content="#FF6B4A"><meta property="og:site_name" content="JajanDekat"><meta property="og:locale" content="id_ID">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${canon}">${extra}
<style>${CSS}</style></head><body>
<header class="top"><a class="brand" href="/">Jajan<span>Dekat</span></a><div class="nav"><a href="/">Beranda</a><a href="/artikel/">Artikel</a></div></header>`;
const foot = `<footer>© JajanDekat — jajandekat.my.id</footer></body></html>`;

function halamanArtikel(a, lain) {
  const url = `${SITE}/artikel/${a.slug}/`;
  const desc = a.meta_description || ringkas(a.content);
  const ld = { '@context': 'https://schema.org', '@type': 'Article', headline: a.title, description: desc, datePublished: iso(a.created_at),
    mainEntityOfPage: url, inLanguage: 'id', author: { '@type': 'Organization', name: 'JajanDekat' },
    publisher: { '@type': 'Organization', name: 'JajanDekat', url: SITE }, ...(a.cover_image ? { image: a.cover_image } : {}) };
  const extra = `<meta property="og:type" content="article">${a.cover_image ? `<meta property="og:image" content="${esc(a.cover_image)}">` : ''}
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;
  return head(`${a.title} — JajanDekat`, desc, url, extra) + `<main><article>
${a.cover_image ? `<img class="cover" src="${esc(a.cover_image)}" alt="${esc(a.title)}">` : ''}
<div class="meta">${esc(a.category || 'Artikel')} · ${tgl(a.created_at)}</div><h1>${esc(a.title)}</h1>
${mdToHtml(a.content)}</article>
<a class="cta" href="/"><b>Cari pedagang jajanan di sekitarmu</b><br>Buka JajanDekat, gratis dan tanpa akun →</a>
${lain.length ? `<h2>Artikel lainnya</h2><div class="more">${lain.map((x) => `<a href="/artikel/${x.slug}/">${esc(x.title)}</a>`).join('')}</div>` : ''}
</main>` + foot;
}

function halamanDaftar(list) {
  const kat = [...new Set(list.map((a) => a.category).filter(Boolean))];
  const bagian = (judul, items) => `<h2>${esc(judul)}</h2>` + items.map((a) => `<a class="card" href="/artikel/${a.slug}/"><div class="meta">${esc(a.category || 'Artikel')} · ${tgl(a.created_at)}</div><h3>${esc(a.title)}</h3><p>${esc(a.meta_description || ringkas(a.content, 120))}</p></a>`).join('');
  const semua = kat.map((k) => bagian(k.charAt(0).toUpperCase() + k.slice(1), list.filter((a) => a.category === k))).join('')
    + (list.some((a) => !a.category) ? bagian('Lainnya', list.filter((a) => !a.category)) : '');
  return head('Artikel & Cerita Jajanan — JajanDekat', 'Cerita jajanan legendaris, tips jualan untuk pedagang kecil, dan panduan memakai JajanDekat.', `${SITE}/artikel/`) +
    `<script>var s=new URLSearchParams(location.search).get('slug');if(s&&/^[a-z0-9-]+$/i.test(s))location.replace('/artikel/'+s+'/');</script>
<main><h1>Artikel &amp; Cerita Jajanan</h1>${semua}</main>` + foot;
}

const res = await fetch(`${SUPABASE_URL}/rest/v1/articles?select=title,slug,content,meta_description,cover_image,category,created_at&order=created_at.desc`,
  { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } });
if (!res.ok) { console.error('Gagal mengambil artikel:', res.status, await res.text()); process.exit(1); }
const semua = (await res.json()).filter((a) => {
  const ok = a && typeof a.slug === 'string' && /^[a-z0-9-]+$/i.test(a.slug) && a.title && a.content;
  if (!ok) console.warn('Dilewati (slug/judul/isi tidak valid):', a && a.slug);
  return ok;
});
if (semua.length === 0) { console.error('Tidak ada artikel valid; build dibatalkan agar halaman lama tidak terhapus.'); process.exit(1); }

await mkdir('artikel', { recursive: true });
for (const a of semua) {
  const lain = semua.filter((x) => x.slug !== a.slug && x.category === a.category).slice(0, 5);
  await mkdir(`artikel/${a.slug}`, { recursive: true });
  await writeFile(`artikel/${a.slug}/index.html`, halamanArtikel(a, lain));
}
await writeFile('artikel/index.html', halamanDaftar(semua));

// Hapus halaman hasil build yang artikelnya sudah tidak ada di database (hanya folder bertanda dibuat-otomatis)
const ada = new Set(semua.map((a) => a.slug));
for (const d of await readdir('artikel', { withFileTypes: true })) {
  if (!d.isDirectory() || ada.has(d.name)) continue;
  try { if ((await readFile(`artikel/${d.name}/index.html`, 'utf8')).includes(MARK)) await rm(`artikel/${d.name}`, { recursive: true }); } catch {}
}

const urls = [`<url><loc>${SITE}/</loc><changefreq>weekly</changefreq></url>`, `<url><loc>${SITE}/artikel/</loc><changefreq>weekly</changefreq></url>`, ...semua.map((a) => `<url><loc>${SITE}/artikel/${a.slug}/</loc><lastmod>${iso(a.created_at)}</lastmod></url>`)];
await writeFile('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
await rm('sitemap-artikel.xml', { force: true }); // sitemap tunggal sekarang sitemap.xml
console.log(`Selesai: ${semua.length} artikel statis + daftar + sitemap.xml`);
