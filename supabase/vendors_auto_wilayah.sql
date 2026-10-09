-- ============================================
-- TRIGGER: isi otomatis wilayah pedagang (region, region_id, wilayah_kode, wilayah_label)
-- SUDAH terpasang di Supabase "jajandekat" (8 Okt 2026). File ini arsip; aman dijalankan ulang.
--
-- Berjalan setiap pedagang DIBUAT atau lat/lng/fixed_lat/fixed_lng/region/region_id/wilayah_kode diubah, jadi
-- semua jalur tercakup: RPC register_vendor_unclaimed (toko belum diklaim), pendaftaran pedagang, admin.
-- Urutan:
--   1) region_id sudah ada -> lengkapi teks region & kode yang kosong
--   2) kode wilayah ada, region_id belum -> cari di tabel regions, seragamkan teks region
--   3) dari koordinat (fixed_lat/lng, kalau kosong lat/lng) -> kabupaten/kota dengan titik tengah terdekat (maks 200 km)
-- Pedagang tanpa koordinat & tanpa teks wilayah tetap kosong sampai lokasinya terisi (lalu otomatis terisi).
-- ============================================
create or replace function public.jd_vendors_auto_wilayah()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_la double precision;
  v_lo double precision;
  v_nama text;
  v_kode text;
  v_rid uuid;
  v_km double precision;
begin
  if new.region_id is not null then
    if btrim(coalesce(new.region, '')) = '' or new.wilayah_kode is null then
      with recursive c as (
        select id, name, level, parent_id, wilayah_kode, 0 as d from public.regions where id = new.region_id
        union all
        select r.id, r.name, r.level, r.parent_id, r.wilayah_kode, c.d + 1
          from public.regions r join c on r.id = c.parent_id where c.d < 6
      )
      select coalesce((select name from c where level = 'kabupaten_kota' order by d limit 1),
                      (select name from c order by d limit 1)),
             (select wilayah_kode from c where wilayah_kode is not null order by d limit 1)
        into v_nama, v_kode;
      if btrim(coalesce(new.region, '')) = '' then new.region := v_nama; end if;
      if new.wilayah_kode is null and v_kode is not null then
        new.wilayah_kode := v_kode;
        new.wilayah_label := public.jd_wilayah_label(v_kode);
      end if;
    end if;
    return new;
  end if;

  if new.wilayah_kode is not null then
    select r.id, r.name into v_rid, v_nama
      from public.regions r where r.wilayah_kode = new.wilayah_kode and r.level = 'kabupaten_kota' limit 1;
    if v_rid is not null then
      new.region_id := v_rid;
      new.region := v_nama;
      return new;
    end if;
  end if;

  v_la := coalesce(new.fixed_lat, new.lat);
  v_lo := coalesce(new.fixed_lng, new.lng);
  if v_la is null or v_lo is null or v_la not between -11.5 and 6.5 or v_lo not between 94 and 142 then
    return new;
  end if;

  select x.rid, x.nama, x.kode, x.km into v_rid, v_nama, v_kode, v_km
    from (
      select r.id as rid, r.name as nama, w.kode as kode,
             6371 * 2 * asin(sqrt(power(sin(radians(w.lat - v_la) / 2), 2)
               + cos(radians(v_la)) * cos(radians(w.lat)) * power(sin(radians(w.lng - v_lo) / 2), 2))) as km
        from public.wilayah w
        join public.regions r on r.wilayah_kode = w.kode and r.level = 'kabupaten_kota'
       where w.level = 2 and w.lat is not null and w.lng is not null
       order by km
       limit 1
    ) x;

  if v_rid is not null and v_km <= 200 then
    new.region_id := v_rid;
    new.region := v_nama;
    new.wilayah_kode := v_kode;
    new.wilayah_label := public.jd_wilayah_label(v_kode);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_vendors_wilayah_auto on public.vendors;
create trigger trg_vendors_wilayah_auto
  before insert or update of lat, lng, fixed_lat, fixed_lng, region, region_id, wilayah_kode
  on public.vendors
  for each row execute function public.jd_vendors_auto_wilayah();
