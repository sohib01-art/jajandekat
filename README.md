# JajanDekat — Prototipe Biaya Nol

Aplikasi peta status pedagang keliling. Dibangun dengan:
- **Leaflet + OpenStreetMap** — peta gratis, tanpa API key
- **Supabase (free tier)** — database, realtime update, tanpa server sendiri
- **GitHub Pages** — hosting gratis, HTTPS otomatis

Total biaya: **Rp0/bulan** untuk skala validasi awal (ratusan–ribuan pengguna).

---

## 1. Setup Supabase (5–10 menit)

1. Buka [supabase.com](https://supabase.com) → daftar gratis → **New Project**.
2. Setelah project dibuat, buka **SQL Editor** di sidebar kiri.
3. Buka file `supabase/schema.sql` di folder ini, salin semua isinya, tempel ke SQL Editor, lalu klik **Run**.
   Ini akan membuat tabel `vendors` dan `follows`, mengaktifkan Realtime, dan mengisi 3 contoh pedagang.
4. Buka **Project Settings → API**. Salin dua nilai ini:
   - **Project URL**
   - **anon public key**

## 2. Hubungkan aplikasi ke Supabase

Buka file `js/config.js`, ganti dua baris ini dengan nilai dari langkah sebelumnya:

```js
const SUPABASE_URL = "https://xxxxx.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOi...";
```

Juga ubah `DEFAULT_MAP_CENTER` ke koordinat wilayah Anda (cari di Google Maps, klik kanan lokasi → salin koordinat).

## 3. Coba di lokal dulu (opsional tapi disarankan)

Buka `index.html` langsung di browser (double-click), atau jalankan server lokal sederhana:

```bash
python3 -m http.server 8000
```

Lalu buka `http://localhost:8000`. Coba mode Pedagang → pilih salah satu pedagang contoh → tekan **SAYA JUALAN**. Buka mode Pembeli, harusnya status langsung berubah (realtime).

## 4. Deploy ke GitHub Pages (gratis)

1. Buat repository baru di GitHub (bisa publik, gratis selamanya).
2. Upload semua isi folder ini ke repo tersebut.
3. Buka **Settings → Pages** di repo → pilih branch `main`, folder `/ (root)` → **Save**.
4. Tunggu 1–2 menit, aplikasi bisa diakses di `https://username.github.io/nama-repo/`.

## 5. Cegah project Supabase "tidur" (penting!)

Supabase free tier akan mem-pause project yang tidak menerima request selama 7 hari. File
`.github/workflows/keep-alive.yml` sudah disiapkan untuk mengatasi ini secara otomatis — tinggal
tambahkan dua secret di repo GitHub Anda:

1. Buka **Settings → Secrets and variables → Actions** di repo.
2. Tambahkan secret:
   - `SUPABASE_URL` → isi dengan Project URL Anda
   - `SUPABASE_ANON_KEY` → isi dengan anon key Anda
3. Selesai. GitHub Actions akan otomatis mem-ping Supabase setiap hari, gratis (karena repo publik).

## 6. Menambah pedagang baru

Untuk tahap validasi awal, tambahkan pedagang baru langsung lewat Supabase Dashboard:
**Table Editor → vendors → Insert row**. Isi nama, kategori, emoji, dan nomor WhatsApp.
Nanti kalau sudah siap, ini bisa diganti jadi formulir pendaftaran mandiri untuk pedagang.

---

## Batasan yang perlu diketahui (tier gratis)

| Batasan | Nilai | Dampak |
|---|---|---|
| Database | 500 MB | Cukup untuk ribuan pedagang |
| Bandwidth | 5 GB/bulan | Cukup untuk ratusan–ribuan pengguna aktif harian |
| Auto-pause | Setelah 7 hari tanpa request | Diatasi dengan GitHub Action di atas |
| Backup otomatis | Tidak ada | Ekspor data manual mingguan lewat Table Editor → Export |

Kalau sudah melewati skala ini (ribuan pedagang aktif, butuh keandalan produksi), saatnya
pindah ke Supabase Pro (~$25/bulan).

## Struktur folder

```
jajandekat/
├── index.html              → halaman utama
├── manifest.json           → agar bisa "Add to Home Screen"
├── css/style.css           → tampilan
├── js/config.js            → ISI KREDENSIAL SUPABASE DI SINI
├── js/app.js                → logika aplikasi
├── supabase/schema.sql      → skema database, jalankan sekali di SQL Editor
└── .github/workflows/
    └── keep-alive.yml       → cegah Supabase auto-pause
```
