import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Kelola foto header beranda dari Dashboard Admin.
// Autentikasi sama dengan `admin-banners` (password admin di body; verify_jwt dimatikan karena password dicek di sini).
// Body: { password, action, ... }
//   get_header | save_header {image_url, enabled, scrim} | set_enabled {enabled} | set_scrim {scrim} | reset_header

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
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// Batasi tebakan password: maks 8 kegagalan per IP per 10 menit (per instans fungsi)
const LOCK_WINDOW_MS = 10 * 60 * 1000;
const LOCK_MAX_FAILS = 8;
const failedLogins = new Map<string, { n: number; t: number }>();
function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown";
}
function isLocked(ip: string): boolean {
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

const KEY = "header_photo";
// Foto header diunggah klien ke folder banners/ dengan awalan header- (folder yang sudah diizinkan policy Storage).
const IMAGE_PREFIX = `${SUPABASE_URL}/storage/v1/object/public/vendor-photos/banners/header-`;
const DEFAULTS = { image_url: null as string | null, enabled: true, scrim: 0.6 };

type Setting = { image_url: string | null; enabled: boolean; scrim: number; v?: number };

async function readSetting(): Promise<Setting> {
  const { data, error } = await supabase.from("app_settings").select("value").eq("key", KEY).maybeSingle();
  if (error) throw error;
  return { ...DEFAULTS, ...((data?.value as Partial<Setting>) ?? {}) };
}

async function writeSetting(s: Setting) {
  const value: Setting = { image_url: s.image_url, enabled: s.enabled, scrim: s.scrim, v: Date.now() };
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: KEY, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
  return value;
}

function cleanScrim(raw: unknown): number | false {
  if (typeof raw !== "number" || !isFinite(raw)) return false;
  if (raw < 0 || raw > 0.85) return false;
  return Math.round(raw * 100) / 100;
}

// Hapus file foto header lama dari Storage (hanya yang berawalan header- di folder banners/)
async function removeHeaderFile(imageUrl: unknown) {
  if (typeof imageUrl !== "string" || !imageUrl.startsWith(IMAGE_PREFIX)) return;
  const name = imageUrl.slice(`${SUPABASE_URL}/storage/v1/object/public/vendor-photos/`.length).split("?")[0];
  await supabase.storage.from("vendor-photos").remove([name]);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    const asked = req.headers.get("access-control-request-headers");
    return new Response("ok", {
      headers: { ...corsHeaders, "Access-Control-Allow-Headers": asked ? `${BASE_ALLOW_HEADERS}, ${asked}` : BASE_ALLOW_HEADERS },
    });
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

    if (action === "get_header") {
      return json({ header: await readSetting() });
    }

    if (action === "save_header") {
      const cur = await readSetting();
      const url = body.image_url;
      if (typeof url !== "string" || !url.startsWith(IMAGE_PREFIX) || url.length > 400) {
        return json({ error: "Gambar header tidak valid, unggah ulang gambarnya" }, 400);
      }
      const scrim = body.scrim === undefined ? cur.scrim : cleanScrim(body.scrim);
      if (scrim === false) return json({ error: "Nilai gelap atas harus 0 sampai 0.85" }, 400);
      const enabled = body.enabled === undefined ? true : body.enabled === true;
      const saved = await writeSetting({ image_url: url, enabled, scrim });
      if (cur.image_url && cur.image_url !== url) await removeHeaderFile(cur.image_url);
      return json({ success: true, header: saved });
    }

    if (action === "set_enabled") {
      if (typeof body.enabled !== "boolean") return json({ error: "enabled wajib true/false" }, 400);
      const cur = await readSetting();
      return json({ success: true, header: await writeSetting({ ...cur, enabled: body.enabled }) });
    }

    if (action === "set_scrim") {
      const scrim = cleanScrim(body.scrim);
      if (scrim === false) return json({ error: "Nilai gelap atas harus 0 sampai 0.85" }, 400);
      const cur = await readSetting();
      return json({ success: true, header: await writeSetting({ ...cur, scrim }) });
    }

    if (action === "reset_header") {
      const cur = await readSetting();
      const saved = await writeSetting({ ...DEFAULTS });
      await removeHeaderFile(cur.image_url);
      return json({ success: true, header: saved });
    }

    return json({ error: "Aksi tidak dikenal: " + action }, 400);
  } catch (e) {
    const msg = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
    return json({ error: msg }, 500);
  }
});
