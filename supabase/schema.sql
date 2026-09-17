-- ============================================
-- JajanDekat — Skema Database Supabase
-- File ini merefleksikan struktur database LIVE (project: jajandekat)
-- per 17 September 2026. Cara pakai: Supabase Dashboard > SQL Editor > Run
-- (aman dijalankan ulang berkat "if not exists" / "or replace")
-- ============================================

-- ============================================
-- FUNCTIONS
-- ============================================

-- Ambil device_id pembeli/vendor dari header request (dipakai RLS chat)
create or replace function public.jd_current_device_id()
returns text
language sql
stable
set search_path to 'public'
as $$
  select nullif(current_setting('request.headers', true)::json ->> 'x-device-id', '');
$$;

-- ============================================
-- TABEL: regions (wilayah — provinsi/kabupaten_kota/kecamatan)
-- ============================================
create table if not exists public.regions (
  id uuid primary key default gen_random_uuid(),
  level text not null check (level = any (array['provinsi','kabupaten_kota','kecamatan'])),
  parent_id uuid references public.regions(id),
  name text not null,
  slug text not null unique,
  bps_code text,
  content_tier integer check (content_tier = any (array[1,2,3,4])),
  article_status text not null default 'pending_vendor'
    check (article_status = any (array['draft','published','pending_vendor'])),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================
-- TABEL: vendors (pedagang)
-- ============================================
create table if not exists public.vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text,
  emoji text default '🍜',
  whatsapp text,
  active boolean not null default false,
  active_until timestamptz,
  lat double precision,
  lng double precision,
  created_at timestamptz not null default now(),
  photo_url text,
  pin text,
  is_premium boolean not null default false,
  premium_until timestamptz,
  categories text[] not null default '{}',
  referred_by_vendor_id uuid references public.vendors(id),
  region text,
  premium_expiry_notified boolean not null default false,
  owner_device_id text,
  rating_avg numeric default 0,
  rating_count integer not null default 0,
  last_activity_ping timestamptz,
  mode_icon text,
  activation_count integer not null default 0,
  promo_until timestamptz,
  promo_caption text,
  promo_photo_url text,
  reminder_time time,
  reminder_last_sent_date date,
  promo_text text,
  location_updated_at timestamptz,
  location_error_message text,
  location_error_at timestamptz,
  show_whatsapp boolean not null default true,
  region_id uuid references public.regions(id),
  promo_image_url text,
  verification_status text not null default 'none'
    check (verification_status = any (array['none','pending','verified','rejected'])),
  ktp_photo_url text,
  business_name text,
  business_nib text,
  verification_note text
);

-- ============================================
-- TABEL: follows (pengikut, tanpa akun — diidentifikasi lewat device_id)
-- ============================================
create table if not exists public.follows (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  created_at timestamptz not null default now(),
  via_referral boolean not null default false,
  unique (device_id, vendor_id)
);

-- ============================================
-- TABEL: reviews (ulasan pembeli untuk vendor)
-- ============================================
create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  device_id text not null,
  rating integer not null check (rating >= 1 and rating <= 5),
  comment text,
  created_at timestamptz not null default now(),
  unique (vendor_id, device_id)
);

-- ============================================
-- TABEL: reports (laporan masuk terhadap vendor)
-- ============================================
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  device_id text not null,
  reason text not null,
  detail text,
  status text not null default 'baru',
  created_at timestamptz not null default now()
);

-- ============================================
-- TABEL: upgrade_requests (permintaan upgrade dari vendor)
-- ============================================
create table if not exists public.upgrade_requests (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  request_type text not null,
  note text,
  status text not null default 'baru',
  created_at timestamptz not null default now()
);

-- ============================================
-- TABEL: vendor_requests (permintaan premium/promo dari vendor)
-- ============================================
create table if not exists public.vendor_requests (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  type text not null check (type = any (array['premium','promo'])),
  status text not null default 'pending' check (status = any (array['pending','selesai'])),
  created_at timestamptz not null default now()
);

-- ============================================
-- TABEL: premium_history (riwayat aktivasi premium vendor)
-- ============================================
create table if not exists public.premium_history (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  started_at timestamptz not null default now(),
  duration_days integer not null,
  amount numeric,
  note text,
  created_at timestamptz not null default now()
);

-- ============================================
-- TABEL: announcements (pengumuman broadcast dari admin)
-- ============================================
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  message text not null,
  link text,
  image_url text,
  audience text not null default 'semua'
    check (audience = any (array['premium','biasa','pembeli','semua'])),
  zone_level text not null default 'nasional'
    check (zone_level = any (array['kecamatan','kabupaten','provinsi','nasional'])),
  zone_value text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  urgent boolean not null default false
);

-- ============================================
-- TABEL: chat_threads & chat_messages (chat vendor <-> pembeli)
-- ============================================
create table if not exists public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  buyer_device_id text not null,
  last_message_at timestamptz not null default now(),
  last_message_preview text,
  created_at timestamptz not null default now(),
  unique (vendor_id, buyer_device_id)
);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  sender text not null check (sender = any (array['vendor','buyer'])),
  message text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  vendor_id uuid references public.vendors(id),
  buyer_device_id text
);

-- ============================================
-- TABEL: push_subscriptions (web push notification)
-- ============================================
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

-- ============================================
-- TABEL: faq
-- ============================================
create table if not exists public.faq (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer text not null,
  category text default 'umum',
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ============================================
-- TABEL: app_secrets (kunci/nilai rahasia internal — hanya diakses service role)
-- ============================================
create table if not exists public.app_secrets (
  key text primary key,
  value text not null
);

-- ============================================
-- TABEL: articles (artikel kuliner/panduan untuk SEO, + workflow review)
-- Catatan: tabel "artikel_admin" yang dulu terpisah sudah digabung ke sini
-- (17 Sep 2026) karena fungsinya tumpang tindih dan RLS-nya longgar (anon full access).
-- ============================================
create table if not exists public.articles (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  meta_description text,
  content text not null,
  category text not null default 'panduan'
    check (category = any (array['panduan','kota','vendor','tips','berita'])),
  region text,
  region_id uuid references public.regions(id),
  keywords text[] not null default '{}',
  cover_image text,
  excerpt text,
  source text not null default 'admin',
  status text not null default 'draft'
    check (status = any (array['draft','in_review','published','rejected'])),
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  published_at timestamptz,
  related_vendor_id uuid references public.vendors(id),
  view_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================
alter table public.regions enable row level security;
alter table public.vendors enable row level security;
alter table public.follows enable row level security;
alter table public.reviews enable row level security;
alter table public.reports enable row level security;
alter table public.upgrade_requests enable row level security;
alter table public.vendor_requests enable row level security;
alter table public.premium_history enable row level security;
alter table public.announcements enable row level security;
alter table public.chat_threads enable row level security;
alter table public.chat_messages enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.faq enable row level security;
alter table public.app_secrets enable row level security;
alter table public.articles enable row level security;

-- regions: baca publik
create policy "Public read access to regions" on public.regions
  for select using (true);

-- vendors: baca & tulis publik (MVP — vendor auth pakai PIN di level aplikasi, bukan RLS)
create policy "vendors_public_read" on public.vendors for select using (true);
create policy "vendors_public_write" on public.vendors for insert with check (true);

-- follows
create policy "follows_public_read" on public.follows for select using (true);
create policy "follows_public_write" on public.follows for insert with check (true);
create policy "follows_public_delete" on public.follows for delete using (true);

-- reviews
create policy "reviews_public_insert" on public.reviews for insert with check (true);
create policy "reviews_public_update" on public.reviews for update using (true);

-- reports
create policy "reports_public_insert" on public.reports for insert with check (true);

-- upgrade_requests
create policy "upgrade_requests_public_insert" on public.upgrade_requests for insert with check (true);

-- vendor_requests
create policy "vendor_requests_public_read" on public.vendor_requests for select using (true);
create policy "vendor_requests_public_write" on public.vendor_requests for insert with check (true);
create policy "vendor_requests_public_update" on public.vendor_requests for update using (true);

-- premium_history
create policy "premium_history_public_read" on public.premium_history for select using (true);
create policy "premium_history_public_write" on public.premium_history for insert with check (true);

-- announcements
create policy "announcements_public_read" on public.announcements for select using (true);
create policy "announcements_public_write" on public.announcements for insert with check (true);
create policy "announcements_public_update" on public.announcements for update using (true);

-- chat_threads: hanya pembeli/vendor pemilik thread (via device_id) yang bisa akses
create policy "chat_threads_owner_select" on public.chat_threads
  for select using (
    buyer_device_id = jd_current_device_id()
    or vendor_id in (select id from public.vendors where owner_device_id = jd_current_device_id())
  );
create policy "chat_threads_owner_insert" on public.chat_threads
  for insert with check (buyer_device_id = jd_current_device_id());
create policy "chat_threads_owner_update" on public.chat_threads
  for update using (
    buyer_device_id = jd_current_device_id()
    or vendor_id in (select id from public.vendors where owner_device_id = jd_current_device_id())
  ) with check (
    buyer_device_id = jd_current_device_id()
    or vendor_id in (select id from public.vendors where owner_device_id = jd_current_device_id())
  );

-- chat_messages: hanya pembeli/vendor pemilik thread terkait
create policy "chat_messages_owner_select" on public.chat_messages
  for select using (
    exists (
      select 1 from public.chat_threads t
      where t.id = chat_messages.thread_id
        and (
          t.buyer_device_id = jd_current_device_id()
          or t.vendor_id in (select id from public.vendors where owner_device_id = jd_current_device_id())
        )
    )
  );
create policy "chat_messages_owner_insert" on public.chat_messages
  for insert with check (
    exists (
      select 1 from public.chat_threads t
      where t.id = chat_messages.thread_id
        and (
          (chat_messages.sender = 'buyer' and t.buyer_device_id = jd_current_device_id())
          or (chat_messages.sender = 'vendor' and t.vendor_id in (
                select id from public.vendors where owner_device_id = jd_current_device_id()
              ))
        )
    )
  );
create policy "chat_messages_owner_update" on public.chat_messages
  for update using (
    exists (
      select 1 from public.chat_threads t
      where t.id = chat_messages.thread_id
        and (
          t.buyer_device_id = jd_current_device_id()
          or t.vendor_id in (select id from public.vendors where owner_device_id = jd_current_device_id())
        )
    )
  ) with check (true);

-- push_subscriptions
create policy "push_subs_public_insert" on public.push_subscriptions for insert with check (true);
create policy "push_subscriptions_public_update" on public.push_subscriptions for update using (true);

-- faq: hanya yang aktif tampil ke publik
create policy "faq_public_read" on public.faq for select using (active = true);

-- app_secrets: tidak ada policy publik → hanya bisa diakses via service role key

-- articles: publik hanya boleh baca yang sudah published;
-- insert/update/delete (termasuk alur review draft -> in_review -> published)
-- hanya lewat service role key dari admin dashboard.
create policy "Artikel published dapat dibaca publik" on public.articles
  for select using (status = 'published');

-- ============================================
-- REALTIME
-- ============================================
alter publication supabase_realtime add table public.vendors;

-- ============================================
-- SELESAI
-- ============================================
