-- CATATAN: tabel, policy, dan baris awal ini SUDAH ada di proyek Supabase "jajandekat" (dicek 8 Okt 2026).
-- File ini hanya arsip/dokumentasi; aman dijalankan ulang (if not exists / on conflict).
-- ============================================
-- TABEL: app_settings (pengaturan aplikasi kunci/nilai, mis. foto header Beranda)
-- Jalankan sekali di Supabase → SQL Editor.
-- Baca: publik, tapi HANYA untuk key yang diizinkan di bawah.
-- Tulis: tidak ada policy untuk anon → hanya bisa lewat service role (Edge Function admin-header).
-- ============================================
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

drop policy if exists "app_settings_public_read" on public.app_settings;
create policy "app_settings_public_read" on public.app_settings
  for select using (key in ('header_photo'));   -- tambah key lain di sini kalau memang boleh dibaca publik

-- Baris awal: foto bawaan, aktif, gelap atas 60%
insert into public.app_settings (key, value)
values ('header_photo', '{"image_url": null, "enabled": true, "scrim": 0.6, "v": 0}'::jsonb)
on conflict (key) do nothing;
