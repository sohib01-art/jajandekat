-- Kesiapan Tahap: pencatatan analisis otomatis + status siap/belum per tahap.
-- Aman dijalankan ulang. Tabel hanya bisa diakses lewat Edge Function admin-kesiapan (RLS aktif, tanpa policy).

create table if not exists public.kesiapan_syarat (
  tahap smallint not null check (tahap between 1 and 4),
  metrik text not null,
  label text not null,
  ambang numeric not null,
  arah text not null default 'min' check (arah in ('min','max')),  -- min: nilai >= ambang; max: nilai <= ambang
  primary key (tahap, metrik)
);
create table if not exists public.kesiapan_snapshot (
  tanggal date not null,
  scope text not null,                    -- 'semua' atau id region (kecamatan / kabupaten_kota)
  data jsonb not null,
  primary key (tanggal, scope)
);
create table if not exists public.kesiapan_status (
  tahap smallint primary key check (tahap between 1 and 4),
  status text not null default 'belum' check (status in ('belum','hampir','siap')),
  skor numeric not null default 0,
  streak_hari int not null default 0,
  siap_sejak date,
  penanda text not null default 'belum' check (penanda in ('belum','dikerjakan','ditunda')),
  ditunda_sampai date,
  updated_at timestamptz not null default now()
);
create table if not exists public.kesiapan_checklist (
  tahap smallint not null, kunci text not null, label text not null,
  selesai boolean not null default false, updated_at timestamptz not null default now(),
  primary key (tahap, kunci)
);
create table if not exists public.kesiapan_log (
  id bigint generated always as identity primary key,
  waktu timestamptz not null default now(),
  tahap smallint, peristiwa text not null, catatan text
);
-- Konfirmasi pesanan nyata (nanti diisi tombol "Sudah dipesan" di app); dipakai metrik order_30d & batal_persen
create table if not exists public.kesiapan_konfirmasi (
  id bigint generated always as identity primary key,
  vendor_id uuid references public.vendors(id) on delete set null,
  region_id uuid, device_hash text,
  hasil text not null default 'selesai' check (hasil in ('selesai','batal')),
  created_at timestamptz not null default now()
);
alter table public.kesiapan_syarat enable row level security;
alter table public.kesiapan_snapshot enable row level security;
alter table public.kesiapan_status enable row level security;
alter table public.kesiapan_checklist enable row level security;
alter table public.kesiapan_log enable row level security;
alter table public.kesiapan_konfirmasi enable row level security;

-- Ambang awal = usulan, bisa diubah dari tab Kesiapan
insert into public.kesiapan_syarat (tahap, metrik, label, ambang, arah) values
 (1,'pedagang_aktif','Pedagang aktif (30 hari)',50,'min'),
 (1,'klik_wa_30d','Klik WhatsApp pedagang / 30 hari',300,'min'),
 (2,'ojek_aktif','Ojek terverifikasi',10,'min'),
 (2,'klik_ojek_30d','Klik ojek / 30 hari',100,'min'),
 (3,'order_30d','Pesanan terkonfirmasi / 30 hari',150,'min'),
 (3,'rating_rata','Rata-rata rating pedagang',4,'min'),
 (4,'order_30d','Pesanan terkonfirmasi / 30 hari',600,'min'),
 (4,'laporan_30d','Laporan masalah / 30 hari',5,'max'),
 (4,'batal_persen','Pesanan batal (%)',10,'max')
on conflict (tahap, metrik) do nothing;
insert into public.kesiapan_checklist (tahap, kunci, label) values
 (2,'ongkir_zona','Aturan ongkir & zona sudah ditetapkan'),
 (2,'koordinator_sepakat','Koordinator ojek sepakat dengan aturan main'),
 (3,'layanan_pelanggan','Ada orang/jalur untuk menangani komplain'),
 (4,'legal_bayar','Aturan pembayaran, pajak & status mitra sudah dicek'),
 (4,'biaya_gateway','Biaya QRIS/gateway sudah dihitung'),
 (4,'batas_supabase','Batas paket Supabase aman untuk volume baru')
on conflict (tahap, kunci) do nothing;
insert into public.kesiapan_status (tahap) values (1),(2),(3),(4) on conflict do nothing;

create or replace function public.kesiapan_hitung() returns void
language plpgsql security definer set search_path = public as $$
declare
  r record; d jsonb; v jsonb; t record; m record; st public.kesiapan_status%rowtype;
  n int; tot numeric; ok_all boolean; ok_m boolean; nilai numeric; sk numeric;
  lolos boolean; baru text; ns int;
  hari date := (now() at time zone 'Asia/Makassar')::date;
begin
  for r in select 'semua'::text as scope, null::uuid as rid
           union all select id::text, id from regions where level in ('kecamatan','kabupaten_kota') loop
    d := jsonb_build_object(
      'pedagang_aktif', (select count(*) from vendors x where coalesce(x.suspended,false)=false and (r.rid is null or x.region_id=r.rid) and (x.active or x.last_activity_ping >= now()-interval '30 days')),
      'klik_wa_30d', (select count(*) from vendor_events e join vendors x on x.id=e.vendor_id where e.kind='wa' and e.created_at>=now()-interval '30 days' and (r.rid is null or x.region_id=r.rid)),
      'klik_ojek_30d', (select count(*) from app_events e where e.event_type in ('ojek_button_click','ojek_wa_open','ojek_group_click') and e.created_at>=now()-interval '30 days' and (r.rid is null or e.region_id=r.rid)),
      'ojek_aktif', (select count(*) from ojek_drivers o where o.status='verified' and (r.rid is null or o.region_id=r.rid)),
      'rating_rata', coalesce((select round(avg(x.rating_avg),2) from vendors x where x.rating_count>0 and (r.rid is null or x.region_id=r.rid)),0),
      'order_30d', (select count(*) from kesiapan_konfirmasi k where k.hasil='selesai' and k.created_at>=now()-interval '30 days' and (r.rid is null or k.region_id=r.rid)),
      'batal_persen', coalesce((select round(100.0*count(*) filter (where k.hasil='batal')/nullif(count(*),0),1) from kesiapan_konfirmasi k where k.created_at>=now()-interval '30 days' and (r.rid is null or k.region_id=r.rid)),0),
      'laporan_30d', (select count(*) from reports p join vendors x on x.id=p.vendor_id where p.created_at>=now()-interval '30 days' and (r.rid is null or x.region_id=r.rid))
                   + (select count(*) from ojek_reports p left join ojek_groups g on g.id=p.group_id where p.created_at>=now()-interval '30 days' and (r.rid is null or g.region_id=r.rid))
    );
    insert into kesiapan_snapshot (tanggal, scope, data) values (hari, r.scope, d)
      on conflict (tanggal, scope) do update set data = excluded.data;
    if r.scope = 'semua' then v := d; end if;
  end loop;
  delete from kesiapan_snapshot where tanggal < hari - 180;

  for t in select tahap from kesiapan_status order by tahap loop
    select * into st from kesiapan_status where tahap = t.tahap;
    n := 0; tot := 0; ok_all := true;
    for m in select * from kesiapan_syarat where tahap = t.tahap loop
      nilai := coalesce((v->>m.metrik)::numeric, 0);
      if m.arah = 'min' then
        ok_m := nilai >= m.ambang; sk := least(nilai / nullif(m.ambang,0), 1);
      else
        ok_m := nilai <= m.ambang; sk := case when nilai <= m.ambang then 1 else m.ambang / nilai end;
      end if;
      n := n + 1; tot := tot + coalesce(sk,1); ok_all := ok_all and ok_m;
    end loop;
    sk := case when n = 0 then 0 else round(tot / n, 3) end;
    lolos := ok_all and n > 0 and not exists (select 1 from kesiapan_checklist c where c.tahap = t.tahap and not c.selesai);
    -- streak naik maks 1x per hari (aman kalau tombol "Hitung sekarang" ditekan berulang)
    ns := case when not lolos then 0
               when st.updated_at::date = now()::date and st.streak_hari > 0 then st.streak_hari
               else st.streak_hari + 1 end;
    baru := case when lolos and ns >= 14 then 'siap'
                 when lolos or sk >= 0.8 then 'hampir' else 'belum' end;
    update kesiapan_status set skor = sk, streak_hari = ns, status = baru,
      siap_sejak = case when baru = 'siap' then coalesce(st.siap_sejak, hari) else null end,
      updated_at = now()
    where tahap = t.tahap;
    if baru is distinct from st.status then
      insert into kesiapan_log (tahap, peristiwa, catatan) values (t.tahap, 'status_'||baru, 'Skor '||round(sk*100)||'%');
    end if;
  end loop;
end $$;
revoke all on function public.kesiapan_hitung() from public, anon, authenticated;

-- Jadwal harian 01:00 WITA (17:00 UTC). Kalau pg_cron belum aktif, aktifkan di Dashboard > Database > Extensions lalu jalankan ulang blok ini.
do $$ begin
  create extension if not exists pg_cron;
  perform cron.schedule('kesiapan-harian', '0 17 * * *', 'select public.kesiapan_hitung()');
exception when others then
  raise notice 'pg_cron belum aktif (%). Tombol "Hitung sekarang" di tab Kesiapan tetap berfungsi.', sqlerrm;
end $$;

select public.kesiapan_hitung();
