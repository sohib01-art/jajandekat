import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Panel "Kesiapan Tahap" di Dashboard Admin. Autentikasi sama dengan admin-header (password admin di body, verify_jwt dimatikan).
// Body: { password, action, ... }
//   get | hitung | set_syarat {tahap, metrik, ambang} | set_checklist {tahap, kunci, selesai}
//   tandai {tahap, penanda: 'belum'|'dikerjakan'|'ditunda', hari?}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const BASE_ALLOW_HEADERS = "authorization, x-client-info, apikey, content-type";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": BASE_ALLOW_HEADERS,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function getAdminPassword(): Promise<string | null> {
  const fromEnv = Deno.env.get("ADMIN_PASSWORD");
  if (fromEnv) return fromEnv;
  const { data } = await supabase.rpc("get_app_secret", { p_name: "admin_password" });
  return (data as string | null) ?? null;
}
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
const LOCK_WINDOW_MS = 10 * 60 * 1000, LOCK_MAX_FAILS = 8;
const failedLogins = new Map<string, { n: number; t: number }>();
const clientIp = (req: Request) =>
  req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
function isLocked(ip: string) {
  const r = failedLogins.get(ip);
  if (!r) return false;
  if (Date.now() - r.t > LOCK_WINDOW_MS) { failedLogins.delete(ip); return false; }
  return r.n >= LOCK_MAX_FAILS;
}
function noteFailure(ip: string) {
  const r = failedLogins.get(ip);
  if (!r || Date.now() - r.t > LOCK_WINDOW_MS) failedLogins.set(ip, { n: 1, t: Date.now() });
  else r.n++;
}

const isTahap = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 1 && (x as number) <= 4;
const today = () => new Date().toISOString().slice(0, 10);

async function ambil() {
  const [syarat, status, cek, log, snap, regs] = await Promise.all([
    supabase.from("kesiapan_syarat").select("*").order("tahap").order("metrik"),
    supabase.from("kesiapan_status").select("*").order("tahap"),
    supabase.from("kesiapan_checklist").select("tahap,kunci,label,selesai").order("tahap").order("kunci"),
    supabase.from("kesiapan_log").select("waktu,tahap,peristiwa,catatan").order("waktu", { ascending: false }).limit(20),
    supabase.from("kesiapan_snapshot").select("tanggal,scope,data").gte("tanggal", new Date(Date.now() - 35 * 864e5).toISOString().slice(0, 10)).order("tanggal"),
    supabase.from("regions").select("id,name,level").in("level", ["kecamatan", "kabupaten_kota"]),
  ]);
  for (const r of [syarat, status, cek, log, snap, regs]) if (r.error) throw r.error;
  const names: Record<string, string> = {};
  for (const g of regs.data ?? []) names[g.id] = g.name;
  const rows = snap.data ?? [];
  const tren = rows.filter((x) => x.scope === "semua").map((x) => ({ tanggal: x.tanggal, ...x.data }));
  const terakhir = rows.length ? rows[rows.length - 1].tanggal : null;
  const wilayah = rows
    .filter((x) => x.tanggal === terakhir && x.scope !== "semua")
    .map((x) => ({ id: x.scope, nama: names[x.scope] ?? x.scope, ...x.data }))
    .filter((w: any) => w.pedagang_aktif > 0 || w.klik_ojek_30d > 0 || w.ojek_aktif > 0);

  // Pengingat: tahap pertama yang belum ditandai "dikerjakan"; muncul kalau berstatus siap dan tidak sedang ditunda
  const st = status.data ?? [];
  const berikut = st.find((s) => s.penanda !== "dikerjakan") ?? null;
  const semuaSelesai = st.length > 0 && !berikut;
  const ingatkan = !!berikut && berikut.status === "siap" && !(berikut.penanda === "ditunda" && berikut.ditunda_sampai && berikut.ditunda_sampai > today());
  return { syarat: syarat.data, status: st, checklist: cek.data, log: log.data, tren, wilayah, terakhir, berikut: berikut?.tahap ?? null, ingatkan, semuaSelesai };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    const asked = req.headers.get("access-control-request-headers");
    return new Response("ok", { headers: { ...corsHeaders, "Access-Control-Allow-Headers": asked ? `${BASE_ALLOW_HEADERS}, ${asked}` : BASE_ALLOW_HEADERS } });
  }
  try {
    const body = await req.json();
    const { password, action } = body;
    const ip = clientIp(req);
    if (isLocked(ip)) return json({ error: "Terlalu banyak percobaan gagal. Coba lagi beberapa menit lagi." }, 401);
    const expected = await getAdminPassword();
    if (!expected || typeof password !== "string" || !safeEqual(password, expected)) {
      noteFailure(ip);
      return json({ error: "Password admin salah" }, 401);
    }
    failedLogins.delete(ip);

    if (action === "get") return json(await ambil());

    if (action === "hitung") {
      const { error } = await supabase.rpc("kesiapan_hitung");
      if (error) throw error;
      return json(await ambil());
    }

    if (action === "set_syarat") {
      const { tahap, metrik, ambang } = body;
      if (!isTahap(tahap) || typeof metrik !== "string" || typeof ambang !== "number" || !isFinite(ambang) || ambang < 0 || ambang > 1e7)
        return json({ error: "Data ambang tidak valid" }, 400);
      const { error, count } = await supabase.from("kesiapan_syarat").update({ ambang }, { count: "exact" }).eq("tahap", tahap).eq("metrik", metrik);
      if (error) throw error;
      if (!count) return json({ error: "Syarat tidak ditemukan" }, 404);
      await supabase.from("kesiapan_log").insert({ tahap, peristiwa: "ambang_diubah", catatan: `${metrik} = ${ambang}` });
      return json({ success: true });
    }

    if (action === "set_checklist") {
      const { tahap, kunci, selesai } = body;
      if (!isTahap(tahap) || typeof kunci !== "string" || typeof selesai !== "boolean") return json({ error: "Data checklist tidak valid" }, 400);
      const { error } = await supabase.from("kesiapan_checklist").update({ selesai, updated_at: new Date().toISOString() }).eq("tahap", tahap).eq("kunci", kunci);
      if (error) throw error;
      return json({ success: true });
    }

    if (action === "tandai") {
      const { tahap, penanda } = body;
      if (!isTahap(tahap) || !["belum", "dikerjakan", "ditunda"].includes(penanda)) return json({ error: "Data penanda tidak valid" }, 400);
      const hari = Number.isInteger(body.hari) && body.hari > 0 && body.hari <= 90 ? body.hari : 7;
      const ditunda_sampai = penanda === "ditunda" ? new Date(Date.now() + hari * 864e5).toISOString().slice(0, 10) : null;
      const { error } = await supabase.from("kesiapan_status").update({ penanda, ditunda_sampai }).eq("tahap", tahap);
      if (error) throw error;
      await supabase.from("kesiapan_log").insert({ tahap, peristiwa: "ditandai_" + penanda, catatan: penanda === "ditunda" ? `${hari} hari` : null });
      return json({ success: true });
    }

    return json({ error: "Aksi tidak dikenal" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "Terjadi kesalahan di server" }, 500);
  }
});
