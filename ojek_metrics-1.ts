// ============================================================
// ojek_metrics.ts — aksi admin untuk fitur "Ojek Sekitar" + tab "Metrik".
// Modul terpisah supaya index.ts admin-action yang sudah berjalan
// cukup diubah 2 baris (lihat PASANG.md). Dipanggil SETELAH password admin
// lolos verifikasi, jadi semua aksi di sini hanya bisa dipakai admin.
//
// Aksi:
//   list_ojek                 -> { drivers, groups, reports }
//   save_ojek_driver          -> tambah/ubah ojek  (body.driver)
//   delete_ojek_driver        -> hapus ojek        (body.ojek_id)
//   save_ojek_group           -> tambah/ubah grup  (body.group)
//   delete_ojek_group         -> hapus grup        (body.group_id)
//   update_ojek_report_status -> baru/diproses/selesai (body.report_id, body.status)
//   create_ojek_coordinator   -> buat akun koordinator grup, mengembalikan PIN sekali (Tahap 2)
//   reset_ojek_coordinator_pin / set_ojek_coordinator_status (Tahap 2)
//   get_metrics               -> ringkasan app_events & vendor_events (body.days, maks. 90)
// ============================================================
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

type JsonFn = (body: unknown, status?: number) => Response;

const WA_GROUP_RE = /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+(\?[A-Za-z0-9=&_.-]*)?$/;
const DRIVER_STATUSES = ["pending", "verified", "suspended"];
const REPORT_STATUSES = ["baru", "diproses", "selesai"];
const APP_EVENT_TYPES = ["app_open", "ojek_button_click", "ojek_wa_open", "ojek_group_click", "push_open"];
const WIB_MS = 7 * 60 * 60 * 1000;
const PAGE = 1000;
const MAX_ROWS = 50000;

// 08xxxx / 8xxxx / +62xxxx -> 62xxxx (sesuai CHECK di tabel: ^62[0-9]{8,13}$)
function normWa(raw: unknown): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.startsWith("0")) d = "62" + d.slice(1);
  else if (d.startsWith("8")) d = "62" + d;
  return /^62[0-9]{8,13}$/.test(d) ? d : null;
}

// Ubah galat Postgres yang umum jadi pesan jelas (400), sisanya tetap dilempar (500).
function friendlyDbError(err: any, json: JsonFn): Response | null {
  const msg = String(err?.message ?? "");
  if (err?.code === "23503" || /foreign key/i.test(msg)) return json({ error: "Grup atau wilayah yang dipilih tidak ditemukan" }, 400);
  if (err?.code === "23505" || /duplicate key/i.test(msg)) return json({ error: "Data yang sama sudah terdaftar" }, 400);
  if (err?.code === "23514" || /check constraint/i.test(msg)) return json({ error: "Ada isian yang tidak sesuai aturan (panjang/format)" }, 400);
  return null;
}

function cleanName(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  return s.length >= 1 && s.length <= 80 ? s : null;
}

async function fetchAll(
  supabase: SupabaseClient,
  table: string,
  cols: string,
  sinceIso: string,
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select(cols)
      .gte("created_at", sinceIso)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...((data || []) as Record<string, unknown>[]));
    if (!data || data.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

function wibDate(iso: string): string {
  return new Date(new Date(iso).getTime() + WIB_MS).toISOString().slice(0, 10);
}

export async function handleOjekMetrics(
  supabase: SupabaseClient,
  action: string,
  body: Record<string, any>,
  json: JsonFn,
): Promise<Response | null> {
  // ---------------- OJEK ----------------
  if (action === "list_ojek") {
    const [d, g, r, k] = await Promise.all([
      supabase.from("ojek_drivers").select("*").order("created_at", { ascending: false }),
      supabase.from("ojek_groups").select("*").order("created_at", { ascending: false }),
      // device_id pelapor sengaja tidak ikut dikirim ke dashboard
      supabase.from("ojek_reports")
        .select("id, ojek_id, group_id, reason, detail, status, created_at")
        .order("created_at", { ascending: false })
        .limit(200),
      // pin_hash sengaja tidak ikut dikirim
      supabase.from("ojek_coordinators")
        .select("id, group_id, name, whatsapp, status, terms_accepted_at, last_login_at, created_at"),
    ]);
    if (d.error) throw d.error;
    if (g.error) throw g.error;
    if (r.error) throw r.error;
    if (k.error) throw k.error;
    return json({ drivers: d.data, groups: g.data, reports: r.data, coordinators: k.data });
  }

  if (action === "save_ojek_driver") {
    const d = body.driver || {};
    const patch: Record<string, unknown> = {};

    if (d.name !== undefined) {
      const n = cleanName(d.name);
      if (!n) return json({ error: "Nama ojek wajib diisi (maks. 80 karakter)" }, 400);
      patch.name = n;
    }
    if (d.whatsapp !== undefined) {
      const wa = normWa(d.whatsapp);
      if (!wa) return json({ error: "Nomor WhatsApp tidak valid. Contoh: 081234567890" }, 400);
      patch.whatsapp = wa;
    }
    if (d.plate_number !== undefined) {
      const p = String(d.plate_number ?? "").trim().toUpperCase();
      patch.plate_number = p ? p.slice(0, 15) : null;
    }
    if (d.photo_url !== undefined) patch.photo_url = d.photo_url || null;
    if (d.region_id !== undefined) patch.region_id = d.region_id || null;
    if (d.status !== undefined) {
      if (!DRIVER_STATUSES.includes(d.status)) return json({ error: "status tidak valid" }, 400);
      patch.status = d.status;
      if (d.status === "verified") {
        patch.verified_by = "admin";
        patch.verified_at = new Date().toISOString();
        patch.suspended_by = null;
      }
      if (d.status === "suspended") patch.suspended_by = "admin"; // koordinator tidak bisa mengaktifkan lagi
    }

    if (d.id) {
      if (d.consent_confirmed !== undefined) {
        if (d.consent_confirmed) {
          // jangan timpa tanggal persetujuan yang sudah tercatat
          const { data: cur, error: curErr } = await supabase
            .from("ojek_drivers").select("consent_show_at").eq("id", d.id).maybeSingle();
          if (curErr) throw curErr;
          if (!cur) return json({ error: "Ojek tidak ditemukan" }, 404);
          if (!cur.consent_show_at) {
            patch.consent_show_at = new Date().toISOString();
            patch.consent_by = "admin";
          }
        } else {
          patch.consent_show_at = null;
          patch.consent_by = null;
        }
      }
      if (Object.keys(patch).length === 0) return json({ error: "Tidak ada yang diubah" }, 400);
      const { data, error } = await supabase
        .from("ojek_drivers").update(patch).eq("id", d.id).select("id").single();
      if (error) { const f = friendlyDbError(error, json); if (f) return f; throw error; }
      return json({ success: true, id: data.id });
    }

    if (!patch.name || !patch.whatsapp) return json({ error: "Nama dan nomor WhatsApp wajib diisi" }, 400);
    {
      const { data: dup } = await supabase.from("ojek_drivers").select("id").eq("whatsapp", patch.whatsapp as string).limit(1);
      if (dup && dup.length) return json({ error: "Nomor ini sudah terdaftar sebagai ojek" }, 400);
    }
    if (d.group_id) {
      const { data: grp, error: grpErr } = await supabase.from("ojek_groups").select("max_drivers").eq("id", d.group_id).maybeSingle();
      if (grpErr) throw grpErr;
      if (!grp) return json({ error: "Grup tidak ditemukan" }, 400);
      const { count } = await supabase.from("ojek_drivers").select("id", { count: "exact", head: true }).eq("group_id", d.group_id);
      if ((count ?? 0) >= grp.max_drivers) return json({ error: `Batas ${grp.max_drivers} ojek per grup sudah tercapai` }, 400);
    }
    if (d.consent_confirmed) { patch.consent_show_at = new Date().toISOString(); patch.consent_by = "admin"; }
    if (d.group_id) patch.group_id = d.group_id;
    if (!patch.status) patch.status = "pending";
    const { data, error } = await supabase.from("ojek_drivers").insert(patch).select("id").single();
    if (error) { const f = friendlyDbError(error, json); if (f) return f; throw error; }
    return json({ success: true, id: data.id });
  }

  if (action === "delete_ojek_driver") {
    if (!body.ojek_id) return json({ error: "ojek_id wajib diisi" }, 400);
    const { error } = await supabase.from("ojek_drivers").delete().eq("id", body.ojek_id);
    if (error) throw error;
    return json({ success: true });
  }

  if (action === "save_ojek_group") {
    const g = body.group || {};
    const patch: Record<string, unknown> = {};

    if (g.name !== undefined) {
      const n = cleanName(g.name);
      if (!n) return json({ error: "Nama grup wajib diisi (maks. 80 karakter)" }, 400);
      patch.name = n;
    }
    if (g.wa_link !== undefined) {
      const link = String(g.wa_link ?? "").trim();
      if (!WA_GROUP_RE.test(link)) {
        return json({ error: "Tautan grup harus berupa https://chat.whatsapp.com/xxxx" }, 400);
      }
      patch.wa_link = link;
    }
    if (g.region_id !== undefined) patch.region_id = g.region_id || null;
    if (g.active !== undefined) patch.active = !!g.active;
    if (g.verification_status !== undefined) {
      if (!["pending", "verified", "suspended"].includes(g.verification_status)) {
        return json({ error: "verification_status tidak valid" }, 400);
      }
      patch.verification_status = g.verification_status;
    }
    if (g.service_area !== undefined) {
      const a = String(g.service_area ?? "").trim();
      patch.service_area = a ? a.slice(0, 120) : null;
    }
    if (g.max_drivers !== undefined) {
      const m = parseInt(g.max_drivers);
      if (!(m >= 1 && m <= 50)) return json({ error: "max_drivers harus 1-50" }, 400);
      patch.max_drivers = m;
    }
    if (g.admin_note !== undefined) {
      const note = String(g.admin_note ?? "").trim();
      patch.admin_note = note ? note.slice(0, 300) : null;
    }
    patch.updated_at = new Date().toISOString();

    if (g.id) {
      const { data, error } = await supabase
        .from("ojek_groups").update(patch).eq("id", g.id).select("id").single();
      if (error) { const f = friendlyDbError(error, json); if (f) return f; throw error; }
      return json({ success: true, id: data.id });
    }
    if (!patch.name || !patch.wa_link) return json({ error: "Nama dan tautan grup wajib diisi" }, 400);
    if (patch.active === undefined) patch.active = true;
    // grup yang dibuat admin sendiri dianggap sudah diperiksa
    if (patch.verification_status === undefined) patch.verification_status = "verified";
    const { data, error } = await supabase.from("ojek_groups").insert(patch).select("id").single();
    if (error) { const f = friendlyDbError(error, json); if (f) return f; throw error; }
    return json({ success: true, id: data.id });
  }

  if (action === "delete_ojek_group") {
    if (!body.group_id) return json({ error: "group_id wajib diisi" }, 400);
    const { error } = await supabase.from("ojek_groups").delete().eq("id", body.group_id);
    if (error) throw error;
    return json({ success: true });
  }

  if (action === "create_ojek_coordinator") {
    const name = cleanName(body.name);
    const wa = normWa(body.whatsapp);
    if (!body.group_id || !name || !wa) {
      return json({ error: "group_id, nama, dan nomor WhatsApp valid wajib diisi" }, 400);
    }
    const { data: pin, error } = await supabase.rpc("koordinator_create", {
      p_group_id: body.group_id, p_name: name, p_whatsapp: wa,
    });
    if (error) {
      if (error.code === "23503" || /foreign key/i.test(error.message)) {
        return json({ error: "Grup tidak ditemukan" }, 400);
      }
      if (/duplicate key/i.test(error.message)) {
        return json({ error: "Grup ini sudah punya koordinator, atau nomor itu sudah dipakai koordinator lain" }, 400);
      }
      throw error;
    }
    await supabase.from("ojek_audit").insert({ actor: "admin", action: "create_coordinator", target_id: body.group_id });
    return json({ success: true, new_pin: pin }); // tampil sekali; sampaikan ke koordinator lewat WhatsApp
  }

  if (action === "reset_ojek_coordinator_pin") {
    if (!body.coordinator_id) return json({ error: "coordinator_id wajib diisi" }, 400);
    const { data: pin, error } = await supabase.rpc("koordinator_reset_pin", { p_id: body.coordinator_id });
    if (error) throw error;
    await supabase.from("ojek_audit").insert({ actor: "admin", action: "reset_coordinator_pin", target_id: body.coordinator_id });
    return json({ success: true, new_pin: pin });
  }

  if (action === "set_ojek_coordinator_status") {
    if (!body.coordinator_id || !["active", "suspended"].includes(body.status)) {
      return json({ error: "coordinator_id dan status valid wajib diisi" }, 400);
    }
    const { error } = await supabase.from("ojek_coordinators").update({ status: body.status }).eq("id", body.coordinator_id);
    if (error) throw error;
    await supabase.from("ojek_audit").insert({ actor: "admin", action: "coordinator_" + body.status, target_id: body.coordinator_id });
    return json({ success: true });
  }

  if (action === "update_ojek_report_status") {
    if (!body.report_id || !REPORT_STATUSES.includes(body.status)) {
      return json({ error: "report_id dan status valid wajib diisi" }, 400);
    }
    const { error } = await supabase.from("ojek_reports").update({ status: body.status }).eq("id", body.report_id);
    if (error) throw error;
    return json({ success: true });
  }

  // ---------------- METRIK ----------------
  if (action === "get_metrics") {
    const days = Math.min(Math.max(parseInt(body.days) || 30, 1), 90);
    const sinceIso = new Date(Date.now() - days * 86400000).toISOString();

    const [ev, vev, newReports] = await Promise.all([
      fetchAll(supabase, "app_events", "id, event_type, device_hash, region_id, ojek_id, group_id, created_at", sinceIso),
      fetchAll(supabase, "vendor_events", "id, kind, device_hash, created_at", sinceIso),
      supabase.from("ojek_reports").select("id", { count: "exact", head: true }).eq("status", "baru"),
    ]);

    // --- total & perangkat unik per jenis event ---
    const totals: Record<string, { events: number; devices: number }> = {};
    const devSets: Record<string, Set<string>> = {};
    for (const t of APP_EVENT_TYPES) { totals[t] = { events: 0, devices: 0 }; devSets[t] = new Set(); }
    const allDevices = new Set<string>();

    // --- per hari (WIB) ---
    const dailyMap = new Map<string, Record<string, number>>();
    for (let i = days - 1; i >= 0; i--) {
      const day = wibDate(new Date(Date.now() - i * 86400000).toISOString());
      dailyMap.set(day, Object.fromEntries(APP_EVENT_TYPES.map((t) => [t, 0])));
    }

    const regionDevices = new Map<string, Set<string>>();
    const ojekOpens = new Map<string, number>();
    const groupClicks = new Map<string, number>();

    for (const e of ev.rows as any[]) {
      const t = e.event_type as string;
      if (!totals[t]) continue;
      totals[t].events++;
      devSets[t].add(e.device_hash);
      allDevices.add(e.device_hash);
      const row = dailyMap.get(wibDate(e.created_at));
      if (row) row[t]++;
      if (t === "app_open" && e.region_id) {
        if (!regionDevices.has(e.region_id)) regionDevices.set(e.region_id, new Set());
        regionDevices.get(e.region_id)!.add(e.device_hash);
      }
      if (t === "ojek_wa_open" && e.ojek_id) ojekOpens.set(e.ojek_id, (ojekOpens.get(e.ojek_id) || 0) + 1);
      if (t === "ojek_group_click" && e.group_id) groupClicks.set(e.group_id, (groupClicks.get(e.group_id) || 0) + 1);
    }
    for (const t of APP_EVENT_TYPES) totals[t].devices = devSets[t].size;

    // --- wilayah teratas (nama diambil dari tabel regions) ---
    const topRegionIds = [...regionDevices.entries()]
      .map(([id, s]) => ({ id, devices: s.size }))
      .sort((a, b) => b.devices - a.devices)
      .slice(0, 10);
    let regionNames = new Map<string, string>();
    if (topRegionIds.length) {
      const { data } = await supabase.from("regions").select("id, name").in("id", topRegionIds.map((r) => r.id));
      regionNames = new Map((data || []).map((r: any) => [r.id, r.name]));
    }

    // --- ojek & grup paling sering diklik (nama dari tabel masing-masing) ---
    const topOjek = [...ojekOpens.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const topGroups = [...groupClicks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const ojekNames = new Map<string, string>();
    const groupNames = new Map<string, string>();
    if (topOjek.length) {
      const { data } = await supabase.from("ojek_drivers").select("id, name").in("id", topOjek.map((x) => x[0]));
      (data || []).forEach((r: any) => ojekNames.set(r.id, r.name));
    }
    if (topGroups.length) {
      const { data } = await supabase.from("ojek_groups").select("id, name").in("id", topGroups.map((x) => x[0]));
      (data || []).forEach((r: any) => groupNames.set(r.id, r.name));
    }

    // --- interaksi pedagang ---
    const vendorKinds: Record<string, { events: number; devices: number }> = {};
    const vSets: Record<string, Set<string>> = {};
    for (const e of vev.rows as any[]) {
      const k = e.kind as string;
      if (!vendorKinds[k]) { vendorKinds[k] = { events: 0, devices: 0 }; vSets[k] = new Set(); }
      vendorKinds[k].events++;
      vSets[k].add(e.device_hash);
    }
    for (const k of Object.keys(vendorKinds)) vendorKinds[k].devices = vSets[k].size;

    return json({
      days,
      since: sinceIso,
      truncated: ev.truncated || vev.truncated,
      unique_devices: allDevices.size,
      totals,
      daily: [...dailyMap.entries()].map(([date, v]) => ({ date, ...v })),
      top_regions: topRegionIds.map((r) => ({ region_id: r.id, name: regionNames.get(r.id) || "(wilayah?)", devices: r.devices })),
      top_ojek: topOjek.map(([id, n]) => ({ id, name: ojekNames.get(id) || "(ojek dihapus)", wa_opens: n })),
      top_groups: topGroups.map(([id, n]) => ({ id, name: groupNames.get(id) || "(grup dihapus)", clicks: n })),
      vendor_events: vendorKinds,
      ojek_reports_baru: newReports.count ?? 0,
    });
  }

  return null; // bukan aksi milik modul ini -> index.ts lanjut seperti biasa
}
