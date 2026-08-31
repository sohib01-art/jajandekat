-- ============================================
-- JajanDekat — Skema Database Supabase
-- Cara pakai: buka Supabase Dashboard > SQL Editor > tempel semua isi file ini > Run
-- ============================================

-- Tabel pedagang
create table if not exists vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text,
  emoji text default '🍜',
  whatsapp text,
  active boolean not null default false,
  active_until timestamptz,
  lat double precision,
  lng double precision,
  created_at timestamptz not null default now()
);

-- Tabel pengikut (satu pembeli, tanpa akun, diidentifikasi lewat device_id)
create table if not exists follows (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  vendor_id uuid not null references vendors(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (device_id, vendor_id)
);

-- Aktifkan Row Level Security
alter table vendors enable row level security;
alter table follows enable row level security;

-- Kebijakan MVP: siapa saja boleh baca & tulis (longgar, untuk tahap validasi awal).
-- PENTING: perketat kebijakan ini sebelum jumlah pengguna besar / data sensitif masuk.
create policy "vendors_public_read" on vendors for select using (true);
create policy "vendors_public_write" on vendors for insert with check (true);
create policy "vendors_public_update" on vendors for update using (true);

create policy "follows_public_read" on follows for select using (true);
create policy "follows_public_write" on follows for insert with check (true);
create policy "follows_public_delete" on follows for delete using (true);

-- Aktifkan Realtime untuk tabel vendors (supaya status update langsung terlihat)
alter publication supabase_realtime add table vendors;

-- Contoh data awal (opsional — hapus atau sesuaikan)
insert into vendors (name, category, emoji, whatsapp) values
  ('Bakso Pak Joko', 'Bakso', '🍜', '6281234567890'),
  ('Sate Bu Nur', 'Sate', '🍢', '6281234567891'),
  ('Gorengan Mas Danu', 'Gorengan', '🥟', '6281234567892');
