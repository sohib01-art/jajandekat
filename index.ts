import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

// Kunci VAPID sekarang dibaca dari Secrets (bukan ditulis di kode).
// Set di Supabase Dashboard -> Edge Functions -> Secrets:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY");
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY");
if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  throw new Error("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY belum di-set di Secrets");
}
webpush.setVapidDetails("mailto:admin@jajandekat.local", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  // Browser selalu kirim permintaan OPTIONS dulu sebelum POST (CORS preflight) -> wajib dijawab OK
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { vendor_id, vendor_name } = await req.json();
    if (!vendor_id) return json({ error: "vendor_id wajib diisi" }, 400);

    // Ambil data pedagang dari database (bukan dari kiriman client) supaya foto & status bisa dipercaya
    const { data: vendor, error: vendorErr } = await supabase
      .from("vendors")
      .select("name, emoji, active, photo_url")
      .eq("id", vendor_id)
      .maybeSingle();
    if (vendorErr) throw vendorErr;
    if (!vendor) return json({ error: "Pedagang tidak ditemukan" }, 404);

    // Cegah spam: hanya kirim kalau pedagang memang sedang berstatus jualan
    if (!vendor.active) return json({ sent: 0, message: "Pedagang sedang tidak aktif" });

    const { data: follows, error: followErr } = await supabase
      .from("follows")
      .select("device_id")
      .eq("vendor_id", vendor_id);
    if (followErr) throw followErr;

    const deviceIds = (follows ?? []).map((f) => f.device_id);
    if (deviceIds.length === 0) return json({ sent: 0, message: "Tidak ada pengikut" });

    const { data: subs, error: subErr } = await supabase
      .from("push_subscriptions")
      .select("*")
      .in("device_id", deviceIds);
    if (subErr) throw subErr;

    const name = vendor.name || vendor_name || "Pedagang favoritmu";
    const image =
      typeof vendor.photo_url === "string" && vendor.photo_url.startsWith("https://")
        ? vendor.photo_url
        : undefined;

    const payload = JSON.stringify({
      title: `${vendor.emoji || "🟢"} ${name} lagi jualan!`,
      body: "Buka JajanDekat, cek lokasinya sekarang sebelum kehabisan.",
      image,                          // gambar besar di notifikasi (foto lapak hari ini)
      url: "?view=peta",              // halaman yang dibuka saat notifikasi diketuk
      tag: `vendor-${vendor_id}`,     // notif dari pedagang yang sama saling menggantikan
      vendor_id,
    });

    let sent = 0;
    const invalidEndpoints: string[] = [];

    await Promise.all(
      (subs ?? []).map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
            { TTL: 60 * 60, urgency: "high" } // kedaluwarsa 1 jam: jangan kirim "sedang jualan" yang sudah basi
          );
          sent++;
        } catch (e) {
          if (e.statusCode === 404 || e.statusCode === 410) {
            invalidEndpoints.push(s.endpoint);
          }
        }
      })
    );

    if (invalidEndpoints.length > 0) {
      await supabase.from("push_subscriptions").delete().in("endpoint", invalidEndpoints);
    }

    return json({ sent, total: (subs ?? []).length });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
