// ============================================================
// koordinator-action — edge function untuk koordinator grup ojek (Tahap 2).
// Deploy dengan verify_jwt = false (sama seperti admin-action); keamanan lewat nomor WhatsApp + PIN 6 digit
// yang dicek di database (bcrypt, terkunci 15 menit setelah 5x salah).
//
// Setiap permintaan membawa { whatsapp, pin, action, ... }. Koordinator HANYA bisa menyentuh
// grupnya sendiri dan ojek di dalam grup itu.
//
// Aksi: overview, accept_terms, save_driver, set_driver_hidden, delete_driver,
//       update_group, update_report_status, change_pin
// ============================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const TERMS_VERSION = "koordinator-1.0";
// true  = ojek yang dicatat koordinator langsung tampil (kepercayaan didelegasikan ke grup yang sudah kamu setujui).
// false = ojek baru berstatus "pending" sampai admin memverifikasi.
const AUTO_VERIFY_DRIVERS = true;

const BASE_ALLOW_HEADERS = "authorization, x-client-info, apikey, content-type";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": BASE_ALLOW_HEADERS,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const WA_GROUP_RE = /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+(\?[A-Za-z0-9=&_.-]*)?$/;

function normWa(raw: unknown): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.startsWith("0")) d = "62" + d.slice(1);
  else if (d.startsWith("8")) d = "62" + d;
  return /^62[0-9]{8,13}$/.test(d) ? d : null;
}
function cleanName(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  return s.length >= 1 && s.length <= 80 ? s : null;
}
async function audit(actor: string, action: string, targetId: string | null, detail?: unknown) {
  try {
    await supabase.from("ojek_audit").insert({ actor, action, target_id: targetId, detail: detail ?? null });
  } catch (_e) { /* audit tidak boleh menggagalkan aksi */ }
}

async function loadOverview(me: { c_id: string; c_group_id: string; c_name: string; c_terms_at: string | null }) {
  const { data: group, error: gErr } = await supabase
    .from("ojek_groups")
    .select("id, name, wa_link, active, verification_status, service_area, max_drivers, region_id")
    .eq("id", me.c_group_id)
    .single();
  if (gErr) throw gErr;

  const { data: drivers, error: dErr } = await supabase
    .from("ojek_drivers")
    .select("id, name, whatsapp, plate_number, status, suspended_by, consent_show_at, consent_by, consent_note, created_at")
    .eq("group_id", me.c_group_id)
    .order("created_at", { ascending: false });
  if (dErr) throw dErr;

  // laporan untuk grup ini atau ojek di dalamnya (device pelapor tidak dikirim)
  const ids = (drivers || []).map((d) => d.id);
  const filters = [`group_id.eq.${me.c_group_id}`];
  if (ids.length) filters.push(`ojek_id.in.(${ids.join(",")})`);
  const { data: reports, error: rErr } = await supabase
    .from("ojek_reports")
    .select("id, ojek_id, group_id, reason, detail, status, created_at")
    .or(filters.join(","))
    .order("created_at", { ascending: false })
    .limit(100);
  if (rErr) throw rErr;

  return {
    coordinator: { name: me.c_name, terms_accepted: !!me.c_terms_at, terms_version: TERMS_VERSION },
    group,
    drivers,
    reports,
  };
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
    const action = String(body.action || "overview");
    const wa = normWa(body.whatsapp);
    const pin = String(body.pin ?? "");
    if (!wa || !/^[0-9]{6}$/.test(pin)) return json({ error: "Nomor WhatsApp atau PIN salah" }, 401);

    const { data: rows, error: vErr } = await supabase.rpc("koordinator_verify", { p_whatsapp: wa, p_pin: pin });
    if (vErr) {
      if (/locked/i.test(vErr.message)) {
        return json({ error: "Terlalu banyak percobaan salah. Coba lagi 15 menit lagi." }, 429);
      }
      throw vErr;
    }
    const me = rows?.[0];
    if (!me) return json({ error: "Nomor WhatsApp atau PIN salah" }, 401);
    const actor = "koordinator:" + me.c_id;

    if (action === "overview") return json(await loadOverview(me));

    if (action === "accept_terms") {
      const { error } = await supabase
        .from("ojek_coordinators")
        .update({ terms_version: TERMS_VERSION, terms_accepted_at: new Date().toISOString() })
        .eq("id", me.c_id);
      if (error) throw error;
      await audit(actor, "accept_terms", me.c_id, { version: TERMS_VERSION });
      return json({ success: true });
    }

    if (action === "change_pin") {
      const np = String(body.new_pin ?? "");
      if (!/^[0-9]{6}$/.test(np)) return json({ error: "PIN baru harus 6 digit angka" }, 400);
      if (np === pin) return json({ error: "PIN baru harus berbeda dari PIN lama" }, 400);
      const { error } = await supabase.rpc("koordinator_set_pin", { p_id: me.c_id, p_new_pin: np });
      if (error) throw error;
      await audit(actor, "change_pin", me.c_id);
      return json({ success: true });
    }

    // ---- semua aksi di bawah mengubah data: syarat koordinator harus sudah disetujui ----
    if (!me.c_terms_at) {
      return json({ error: "Setujui ketentuan koordinator dulu.", code: "terms_required" }, 403);
    }

    const { data: group, error: gErr } = await supabase
      .from("ojek_groups")
      .select("id, region_id, max_drivers, verification_status")
      .eq("id", me.c_group_id)
      .single();
    if (gErr) throw gErr;
    if (group.verification_status === "suspended") {
      return json({ error: "Grup sedang ditangguhkan admin. Hubungi admin JajanDekat." }, 403);
    }

    // ambil ojek milik grup ini; ojek grup lain tidak pernah bisa disentuh
    async function ownDriver(id: unknown) {
      if (!id) return null;
      const { data } = await supabase
        .from("ojek_drivers")
        .select("id, status, suspended_by, consent_show_at, whatsapp")
        .eq("id", String(id))
        .eq("group_id", me.c_group_id)
        .maybeSingle();
      return data;
    }

    if (action === "save_driver") {
      const d = body.driver || {};
      const patch: Record<string, unknown> = {};

      if (d.name !== undefined) {
        const n = cleanName(d.name);
        if (!n) return json({ error: "Nama ojek wajib diisi (maks. 80 karakter)" }, 400);
        patch.name = n;
      }
      if (d.whatsapp !== undefined) {
        const w = normWa(d.whatsapp);
        if (!w) return json({ error: "Nomor WhatsApp ojek tidak valid. Contoh: 081234567890" }, 400);
        patch.whatsapp = w;
      }
      if (d.plate_number !== undefined) {
        const p = String(d.plate_number ?? "").trim().toUpperCase();
        patch.plate_number = p ? p.slice(0, 15) : null;
      }

      // nomor yang sama tidak boleh terdaftar dua kali
      if (patch.whatsapp) {
        const { data: dup } = await supabase
          .from("ojek_drivers").select("id").eq("whatsapp", patch.whatsapp as string).maybeSingle();
        if (dup && dup.id !== d.id) return json({ error: "Nomor ini sudah terdaftar sebagai ojek" }, 400);
      }

      if (d.id) {
        const own = await ownDriver(d.id);
        if (!own) return json({ error: "Ojek tidak ditemukan di grupmu" }, 404);
        if (Object.keys(patch).length === 0) return json({ error: "Tidak ada yang diubah" }, 400);
        const { error } = await supabase.from("ojek_drivers").update(patch).eq("id", own.id);
        if (error) throw error;
        await audit(actor, "update_driver", own.id, { fields: Object.keys(patch) });
        return json({ success: true, id: own.id });
      }

      if (!patch.name || !patch.whatsapp) return json({ error: "Nama dan nomor WhatsApp ojek wajib diisi" }, 400);
      // persetujuan tampil harus dikonfirmasi; nomor ojek ikut tampil ke pembeli
      if (!d.consent_confirmed) {
        return json({ error: "Konfirmasi dulu bahwa ojek ini sendiri setuju nama & nomornya ditampilkan." }, 400);
      }
      const note = String(d.consent_note ?? "").trim();
      if (!note) return json({ error: "Isi catatan persetujuan, misal: 'setuju lewat chat WA 29/9'." }, 400);

      const { count } = await supabase
        .from("ojek_drivers").select("id", { count: "exact", head: true }).eq("group_id", me.c_group_id);
      if ((count ?? 0) >= group.max_drivers) {
        return json({ error: `Batas ${group.max_drivers} ojek per grup sudah tercapai.` }, 400);
      }

      const now = new Date().toISOString();
      const { data: created, error } = await supabase.from("ojek_drivers").insert({
        ...patch,
        group_id: me.c_group_id,
        region_id: group.region_id,
        status: AUTO_VERIFY_DRIVERS ? "verified" : "pending",
        verified_by: AUTO_VERIFY_DRIVERS ? actor : null,
        verified_at: AUTO_VERIFY_DRIVERS ? now : null,
        consent_show_at: now,
        consent_by: "koordinator",
        consent_note: note.slice(0, 200),
      }).select("id").single();
      if (error) throw error;
      await audit(actor, "create_driver", created.id);
      return json({ success: true, id: created.id });
    }

    // sembunyikan / tampilkan lagi ojek milik grup
    if (action === "set_driver_hidden") {
      const own = await ownDriver(body.ojek_id);
      if (!own) return json({ error: "Ojek tidak ditemukan di grupmu" }, 404);
      if (body.hidden) {
        const { error } = await supabase.from("ojek_drivers")
          .update({ status: "suspended", suspended_by: "koordinator" }).eq("id", own.id);
        if (error) throw error;
      } else {
        // ojek yang ditangguhkan admin tidak bisa diaktifkan lagi oleh koordinator
        if (own.status === "suspended" && own.suspended_by !== "koordinator") {
          return json({ error: "Ojek ini ditangguhkan admin. Hubungi admin JajanDekat." }, 403);
        }
        const { error } = await supabase.from("ojek_drivers")
          .update({ status: AUTO_VERIFY_DRIVERS ? "verified" : "pending", suspended_by: null }).eq("id", own.id);
        if (error) throw error;
      }
      await audit(actor, body.hidden ? "hide_driver" : "show_driver", own.id);
      return json({ success: true });
    }

    if (action === "delete_driver") {
      const own = await ownDriver(body.ojek_id);
      if (!own) return json({ error: "Ojek tidak ditemukan di grupmu" }, 404);
      const { error } = await supabase.from("ojek_drivers").delete().eq("id", own.id);
      if (error) throw error;
      await audit(actor, "delete_driver", own.id);
      return json({ success: true });
    }

    if (action === "update_group") {
      const g = body.group || {};
      const patch: Record<string, unknown> = {};
      if (g.name !== undefined) {
        const n = cleanName(g.name);
        if (!n) return json({ error: "Nama grup wajib diisi (maks. 80 karakter)" }, 400);
        patch.name = n;
      }
      if (g.wa_link !== undefined) {
        const link = String(g.wa_link ?? "").trim();
        if (!WA_GROUP_RE.test(link)) return json({ error: "Tautan harus berbentuk https://chat.whatsapp.com/kode-undangan" }, 400);
        const { data: cur } = await supabase.from("ojek_groups").select("wa_link, verification_status").eq("id", me.c_group_id).single();
        if (cur && cur.wa_link !== link) {
          patch.wa_link = link;
                    // tautan baru belum pernah diperiksa admin: grup kembali menunggu persetujuan
          if (cur.verification_status === "verified") patch.verification_status = "pending";
        }
      }
      if (g.service_area !== undefined) {
        const a = String(g.service_area ?? "").trim();
        patch.service_area = a ? a.slice(0, 120) : null;
      }
      if (g.active !== undefined) patch.active = !!g.active;
      // sengaja tidak bisa diubah koordinator: region_id, verification_status, max_drivers
      if (Object.keys(patch).length === 0) return json({ error: "Tidak ada yang diubah" }, 400);
      patch.updated_at = new Date().toISOString();
      const { error } = await supabase.from("ojek_groups").update(patch).eq("id", me.c_group_id);
      if (error) throw error;
      await audit(actor, "update_group", me.c_group_id, { fields: Object.keys(patch).filter((k) => k !== "updated_at") });
      return json({ success: true, needs_reverify: patch.verification_status === "pending" });
    }

    if (action === "update_report_status") {
      if (!body.report_id || !["diproses", "selesai"].includes(body.status)) {
        return json({ error: "report_id dan status (diproses/selesai) wajib diisi" }, 400);
      }
      const { data: rep } = await supabase
        .from("ojek_reports").select("id, ojek_id, group_id").eq("id", body.report_id).maybeSingle();
      let mine = !!rep && rep.group_id === me.c_group_id;
      if (rep && !mine && rep.ojek_id) mine = !!(await ownDriver(rep.ojek_id));
      if (!rep || !mine) return json({ error: "Laporan tidak ditemukan untuk grupmu" }, 404);
      const { error } = await supabase.from("ojek_reports").update({ status: body.status }).eq("id", rep.id);
      if (error) throw error;
      await audit(actor, "report_" + body.status, rep.id);
      return json({ success: true });
    }

    return json({ error: "Aksi tidak dikenal: " + action }, 400);
  } catch (e) {
    const msg = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
    console.error("koordinator-action:", msg);
    if (/locked/i.test(msg)) return json({ error: "Terlalu banyak percobaan salah. Coba lagi 15 menit lagi." }, 429);
    return json({ error: "Terjadi kesalahan di server. Coba lagi sebentar." }, 500);
  }
});
