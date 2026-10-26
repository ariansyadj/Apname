// Lapisan data Supabase untuk Apname (migrasi penuh dari localStorage).
// Prinsip:
// - Mode lokal (tanpa VITE_SUPABASE_URL/ANON_KEY) TIDAK berubah sama sekali:
//   semua state tetap di localStorage seperti sebelumnya.
// - Mode cloud (Supabase terkonfigurasi + user login lewat Supabase Auth):
//   Supabase adalah sumber kebenaran. Data dimuat dari tabel, perubahan
//   disimpan incremental (sesi yang berubah saja, bukan seluruh produk
//   setiap scan) lewat fungsi di bawah, dipanggil dari App.tsx.
// - RLS berlaku: frontend memakai JWT user (bukan service role), jadi
//   klaim role/branch_id di Supabase Auth harus sudah diset, kalau tidak
//   data akan kosong (default aman) — lihat DEPLOYMENT.md.
// - Yang TIDAK ditulis frontend ke Supabase: tidak ada yang ditulis balik
//   ke iNOX (itu tugas Edge Function, baca-saja), dan stok rak tidak
//   pernah ditulis oleh sync — hanya oleh kunci sesi / pindah produk,
//   persis seperti versi lokal.
import { isSupabaseConfigured } from "./supabase";
import type { Product, Rack } from "../data";

export type SBUser = { id: string; email: string; name: string; username: string; role: string; branchId: string | null; menus: string[] | null; claimsMissing: boolean };

// Tipe lokal (bentuknya sama dengan tipe di App.tsx, didefinisikan ulang
// di sini supaya modul ini tidak mengimpor App.tsx).
export type SBScan = { id: string; time: number; user: string; productId: string; rackId: string; level: string; qty: number; mode: string; barcode: string };
export type SBMutation = { id: string; time: number; user: string; productId: string; kind: string; direction: "Masuk" | "Keluar"; qty: number; rackId: string; reference: string; note: string };
export type SBSession = {
  id: string; title: string; branchId: string; racks: string[]; scopeLevels?: Record<string, string[]>;
  status: "Berjalan" | "Selesai"; createdAt: number; createdBy: string; lockedAt: number | null;
  snapshot: Record<string, number>; scans: SBScan[]; mutations: SBMutation[];
  adjustmentStatus: "Menunggu" | "Disetujui"; externalAt: number | null;
};
export type SBMove = { id: string; time: number; user: string; productId: string; fromRack: string; fromLevel: string; toRack: string; toLevel: string; qty: number; reason: string; photo: string };
export type SBState = {
  products: Product[]; racks: Rack[]; stock: Record<string, number>;
  sessions: SBSession[]; moves: SBMove[];
  externalTotals: Record<string, { stock: number; at: number }>;
  branches: { id: string; name: string; location_id: number; location_name: string }[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any = null;
async function getClient() {
  if (!isSupabaseConfigured) return null;
  if (client) return client;
  const { createClient } = await import("@supabase/supabase-js");
  const url = import.meta.env.VITE_SUPABASE_URL as string;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  client = createClient(url, anonKey);
  return client;
}

export async function sbSignIn(emailOrUsername: string, password: string): Promise<SBUser> {
  const c = await getClient();
  if (!c) throw new Error("Supabase belum dikonfigurasi (VITE_SUPABASE_URL / ANON_KEY kosong).");
  // Login boleh pakai username saja: "nisa" -> nisa@apname.com. Email lengkap
  // (termasuk akun lama yang bukan @apname.com) tetap dipakai apa adanya.
  const login = emailOrUsername.trim();
  const email = login.includes("@") ? login : `${login.toLowerCase()}@apname.com`;
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(error?.message || "Login Supabase gagal.");
  return userFromSession(data.user);
}
export async function sbSignOut() {
  const c = await getClient();
  if (c) await c.auth.signOut();
  client = null;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function userFromSession(u: any): SBUser {
  const meta = u.app_metadata || {};
  const role = typeof meta.role === "string" ? meta.role : "";
  const branchId = typeof meta.branch_id === "string" ? meta.branch_id : null;
  const menus = Array.isArray(meta.menus) ? meta.menus.filter((m: unknown) => typeof m === "string") : null;
  const claimsMissing = !["super", "admin", "karyawan"].includes(role);
  return {
    id: u.id || "",
    email: u.email || "",
    name: (u.user_metadata && u.user_metadata.name) || u.email || "",
    username: (u.user_metadata && typeof u.user_metadata.username === "string") ? u.user_metadata.username : "",
    role: claimsMissing ? "karyawan" : role,
    branchId,
    menus,
    claimsMissing,
  };
}
export async function sbGetSessionUser(): Promise<SBUser | null> {
  const c = await getClient();
  if (!c) return null;
  const { data } = await c.auth.getSession();
  if (!data.session?.user) return null;
  return userFromSession(data.session.user);
}

async function fetchAll(c: any, table: string, columns: string): Promise<any[]> {
  const out: any[] = [];
  const page = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await c.from(table).select(columns).range(from, from + page - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < page) break;
    from += page;
  }
  return out;
}
function iso(ms: number | null): string | null {
  return ms ? new Date(ms).toISOString() : null;
}
function msOf(s: string | null): number | null {
  return s ? new Date(s).getTime() : null;
}

export async function sbLoadAll(): Promise<SBState> {
  const c = await getClient();
  if (!c) throw new Error("Supabase belum dikonfigurasi.");
  const [branchRows, rackRows, productRows, stockRows, unplacedRows, sessionRows, scanRows, mutRows, moveRows, extRows] = await Promise.all([
    fetchAll(c, "branches", "*"),
    fetchAll(c, "racks", "*"),
    fetchAll(c, "products", "*"),
    fetchAll(c, "stock_by_rack", "*"),
    fetchAll(c, "unplaced_stock", "*").catch(() => [] as any[]),
    fetchAll(c, "sessions", "*"),
    fetchAll(c, "scans", "*"),
    fetchAll(c, "session_mutations", "*"),
    fetchAll(c, "moves", "*"),
    fetchAll(c, "external_totals", "*").catch(() => [] as any[]),
  ]);
  const branches = branchRows.map((b: any) => ({ id: String(b.id), name: String(b.name), location_id: Number(b.location_id), location_name: String(b.location_name) }));
  const racks: Rack[] = rackRows.map((r: any) => ({
    id: String(r.id), branchId: String(r.branch_id), name: String(r.name),
    type: r.type === "retur" ? "retur" : "normal",
    levels: Array.isArray(r.levels) ? r.levels : [],
    x: Number(r.x ?? 20), y: Number(r.y ?? 20), w: Number(r.w ?? 160), h: Number(r.h ?? 90), rot: Number(r.rot ?? 0),
  }));
  const products: Product[] = productRows.map((p: any) => ({
    id: String(p.id), sku: String(p.sku || ""), name: String(p.name || ""), variant: String(p.variant || ""),
    category: String(p.category || ""), price: Number(p.price || 0),
    product_id: Number(p.product_id || 0), variation_id: Number(p.variation_id || 0),
    location_id: Number(p.location_id || 0), barcode: String(p.barcode || p.sku || ""),
    location_name: p.location_name ? String(p.location_name) : undefined,
  }));
  const prodById = new Map(products.map((p) => [p.id, p]));
  const stock: Record<string, number> = {};
  for (const s of stockRows) stock[`${s.product_id}|${s.rack_id}|${s.level}`] = Number(s.qty || 0);
  // Belum Ditempatkan disimpan di unplaced_stock (bukan stock_by_rack,
  // karena BELUM bukan rak dan tidak punya FK ke racks).
  for (const u of unplacedRows) {
    const pr = prodById.get(String(u.product_id));
    if (!pr) continue;
    // Cabang dari produk (location_id -> branch id via BRANCHES tidak ada di
    // modul ini, jadi pakai location_name / fallback LOC-id; App akan
    // menormalkannya lewat branchIdOfProduct saat dipakai).
    stock[`${u.product_id}|${u.branch_id || ""}|BELUM`] = Number(u.qty || 0);
  }
  const scansBySession = new Map<string, SBScan[]>();
  for (const s of scanRows) {
    const arr = scansBySession.get(String(s.session_id)) || [];
    arr.push({ id: String(s.id), time: msOf(s.scanned_at) || 0, user: String(s.scanned_by || ""), productId: String(s.product_id), rackId: String(s.rack_id), level: String(s.level), qty: Number(s.qty || 0), mode: String(s.mode || ""), barcode: String(s.barcode || "") });
    scansBySession.set(String(s.session_id), arr);
  }
  const mutsBySession = new Map<string, SBMutation[]>();
  for (const m of mutRows) {
    const arr = mutsBySession.get(String(m.session_id)) || [];
    arr.push({ id: String(m.id), time: msOf(m.created_at) || 0, user: String(m.created_by || ""), productId: String(m.product_id), kind: String(m.kind || ""), direction: m.direction === "Masuk" ? "Masuk" : "Keluar", qty: Number(m.qty || 0), rackId: String(m.rack_id || ""), reference: String(m.reference || ""), note: String(m.note || "") });
    mutsBySession.set(String(m.session_id), arr);
  }
  const sessions: SBSession[] = sessionRows.map((s: any) => ({
    id: String(s.id), title: String(s.title || ""), branchId: String(s.branch_id),
    racks: Array.isArray(s.racks) ? s.racks : [],
    scopeLevels: s.scope_levels || undefined,
    status: s.status === "Selesai" ? "Selesai" : "Berjalan",
    createdAt: msOf(s.created_at) || 0, createdBy: String(s.created_by || ""),
    lockedAt: msOf(s.locked_at), snapshot: (s.snapshot || {}) as Record<string, number>,
    scans: (scansBySession.get(String(s.id)) || []).sort((a, b) => b.time - a.time),
    mutations: (mutsBySession.get(String(s.id)) || []).sort((a, b) => b.time - a.time),
    adjustmentStatus: s.adjustment_status === "Disetujui" ? "Disetujui" : "Menunggu",
    externalAt: msOf(s.external_at),
  }));
  const moves: SBMove[] = moveRows.map((m: any) => ({
    id: String(m.id), time: msOf(m.moved_at) || 0, user: String(m.moved_by || ""), productId: String(m.product_id),
    fromRack: String(m.from_rack_id), fromLevel: String(m.from_level), toRack: String(m.to_rack_id), toLevel: String(m.to_level),
    qty: Number(m.qty || 0), reason: String(m.reason || ""), photo: String(m.photo_data_url || ""),
  })).sort((a, b) => b.time - a.time);
  const externalTotals: Record<string, { stock: number; at: number }> = {};
  for (const e of extRows) externalTotals[String(e.product_id)] = { stock: Number(e.stock || 0), at: msOf(e.updated_at) || 0 };
  return { products, racks, stock, sessions, moves, externalTotals, branches };
}

function sessionRow(s: SBSession) {
  return {
    id: s.id, title: s.title, branch_id: s.branchId, racks: s.racks,
    scope_levels: s.scopeLevels || null, status: s.status, created_by: s.createdBy,
    created_at: iso(s.createdAt), locked_at: iso(s.lockedAt), snapshot: s.snapshot,
    external_at: iso(s.externalAt), adjustment_status: s.adjustmentStatus,
  };
}
export async function sbSaveSession(s: SBSession) {
  const c = await getClient();
  if (!c) throw new Error("Supabase belum dikonfigurasi.");
  const { error } = await c.from("sessions").upsert(sessionRow(s), { onConflict: "id" });
  if (error) throw new Error(`sessions: ${error.message}`);
  // Scan & mutasi ditulis ulang per sesi (jumlahnya kecil, maks ratusan) —
  // ini yang membuat hapus scan/mutasi ikut tersimpan, bukan hanya tambah.
  const { error: delSc } = await c.from("scans").delete().eq("session_id", s.id);
  if (delSc) throw new Error(`scans delete: ${delSc.message}`);
  if (s.scans.length > 0) {
    const { error: insSc } = await c.from("scans").insert(s.scans.map((sc) => ({
      id: sc.id, session_id: s.id, scanned_at: iso(sc.time), scanned_by: sc.user,
      product_id: sc.productId, rack_id: sc.rackId, level: sc.level, qty: sc.qty, mode: sc.mode, barcode: sc.barcode,
    })));
    if (insSc) throw new Error(`scans insert: ${insSc.message}`);
  }
  const { error: delMu } = await c.from("session_mutations").delete().eq("session_id", s.id);
  if (delMu) throw new Error(`mutations delete: ${delMu.message}`);
  if (s.mutations.length > 0) {
    const { error: insMu } = await c.from("session_mutations").insert(s.mutations.map((m) => ({
      id: m.id, session_id: s.id, created_at: iso(m.time), created_by: m.user,
      product_id: m.productId, kind: m.kind, direction: m.direction, qty: m.qty,
      rack_id: m.rackId || null, reference: m.reference, note: m.note,
    })));
    if (insMu) throw new Error(`mutations insert: ${insMu.message}`);
  }
}
export async function sbDeleteSession(sessionId: string) {
  const c = await getClient();
  if (!c) return;
  const { error } = await c.from("sessions").delete().eq("id", sessionId);
  if (error) throw new Error(`sessions delete: ${error.message}`);
}
export async function sbSaveRacks(racks: Rack[]) {
  const c = await getClient();
  if (!c) throw new Error("Supabase belum dikonfigurasi.");
  const existing = await fetchAll(c, "racks", "id");
  const keep = new Set(racks.map((r) => r.id));
  for (const row of existing) {
    if (!keep.has(String(row.id))) await c.from("racks").delete().eq("id", String(row.id));
  }
  if (racks.length > 0) {
    const { error } = await c.from("racks").upsert(racks.map((r) => ({
      id: r.id, branch_id: r.branchId, name: r.name, type: r.type, levels: r.levels,
      x: r.x, y: r.y, w: r.w, h: r.h, rot: r.rot,
    })), { onConflict: "id" });
    if (error) throw new Error(`racks: ${error.message}`);
  }
}
export async function sbSaveStock(stock: Record<string, number>, products: Product[], branchIdOf: (p: Product) => string) {
  const c = await getClient();
  if (!c) throw new Error("Supabase belum dikonfigurasi.");
  const rackRows: any[] = [];
  const unplacedRows: any[] = [];
  for (const [k, qty] of Object.entries(stock)) {
    if (!qty) continue;
    const parts = k.split("|");
    if (parts.length !== 3) continue;
    const [pid, rid, lv] = parts;
    if (lv === "BELUM" || rid === "BELUM") {
      const pr = products.find((p) => p.id === pid);
      if (!pr) continue;
      unplacedRows.push({ product_id: pid, branch_id: branchIdOf(pr), qty });
    } else {
      rackRows.push({ product_id: pid, rack_id: rid, level: lv, qty });
    }
  }
  // Stok ditulis ulang penuh (hanya saat kunci sesi / pindah / rename level,
  // bukan saat scan — scan tidak mengubah stok). Baris qty 0 dihapus, karena
  // saat dimuat, yang tidak ada dianggap 0.
  await c.from("stock_by_rack").delete().neq("qty", -999999);
  if (rackRows.length > 0) {
    const { error } = await c.from("stock_by_rack").insert(rackRows);
    if (error) throw new Error(`stock_by_rack: ${error.message}`);
  }
  await c.from("unplaced_stock").delete().neq("qty", -999999);
  if (unplacedRows.length > 0) {
    const { error } = await c.from("unplaced_stock").insert(unplacedRows);
    if (error) throw new Error(`unplaced_stock: ${error.message}`);
  }
}
export async function sbSaveProducts(products: Product[]) {
  const c = await getClient();
  if (!c) throw new Error("Supabase belum dikonfigurasi.");
  const rows = products.map((p) => ({
    id: p.id, sku: p.sku, name: p.name, variant: p.variant, category: p.category || null,
    price: p.price, product_id: p.product_id, variation_id: p.variation_id,
    location_id: p.location_id, location_name: p.location_name || null, barcode: p.barcode,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await c.from("products").upsert(rows.slice(i, i + 500), { onConflict: "product_id,variation_id,location_id" });
    if (error) throw new Error(`products: ${error.message}`);
  }
}
export async function sbSaveMoves(moves: SBMove[]) {
  const c = await getClient();
  if (!c) throw new Error("Supabase belum dikonfigurasi.");
  if (moves.length === 0) return;
  const rows = moves.map((m) => ({
    id: m.id, moved_at: iso(m.time), moved_by: m.user, product_id: m.productId,
    from_rack_id: m.fromRack, from_level: m.fromLevel, to_rack_id: m.toRack, to_level: m.toLevel,
    qty: m.qty, reason: m.reason, photo_data_url: m.photo || null,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await c.from("moves").upsert(rows.slice(i, i + 500), { onConflict: "id" });
    if (error) throw new Error(`moves: ${error.message}`);
  }
}
export async function sbSaveExternalTotals(externalTotals: Record<string, { stock: number; at: number }>, products: Product[]) {
  const c = await getClient();
  if (!c) throw new Error("Supabase belum dikonfigurasi.");
  const ids = new Set(products.map((p) => p.id));
  const rows = Object.entries(externalTotals)
    .filter(([id]) => ids.has(id))
    .map(([id, v]) => ({ product_id: id, stock: v.stock, updated_at: iso(v.at) }));
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await c.from("external_totals").upsert(rows.slice(i, i + 500), { onConflict: "product_id" });
    if (error) throw new Error(`external_totals: ${error.message}`);
  }
}
export async function sbMigrateLocal(state: SBState): Promise<{ products: number; racks: number; stockRows: number; sessions: number; moves: number }> {
  const c = await getClient();
  if (!c) throw new Error("Supabase belum dikonfigurasi.");
  // Cabang dulu (FK racks/products tidak mengacu branches secara langsung
  // di semua tabel, tapi branches dipakai RLS & daftar cabang).
  if (state.branches.length > 0) {
    const { error } = await c.from("branches").upsert(state.branches, { onConflict: "location_id" });
    if (error) throw new Error(`branches: ${error.message}`);
  }
  await sbSaveRacks(state.racks);
  await sbSaveProducts(state.products);
  // Stok: butuh branchId per produk — di App, branchIdOfProduct dipakai;
  // di sini, turunkan dari location_id via branches yang ikut dimigrasi.
  const branchByLoc = new Map(state.branches.map((b) => [b.location_id, b.id]));
  await sbSaveStock(state.stock, state.products, (p) => branchByLoc.get(p.location_id) || "");
  for (const s of state.sessions) await sbSaveSession(s);
  await sbSaveMoves(state.moves);
  await sbSaveExternalTotals(state.externalTotals, state.products);
  const stockRows = Object.values(state.stock).filter((q) => q).length;
  return { products: state.products.length, racks: state.racks.length, stockRows, sessions: state.sessions.length, moves: state.moves.length };
}
export async function sbCallEdgeSync(action: "test" | "sync"): Promise<any> {
  const url = import.meta.env.VITE_SUPABASE_URL as string;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  if (!url || !anonKey) throw new Error("Supabase belum dikonfigurasi.");
  const res = await fetch(`${url}/functions/v1/inox-sync`, {
    method: "POST",
    headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const data = await res.json().catch(() => ({ ok: false, error: "Respons Edge Function bukan JSON" }));
  if (!data.ok) throw new Error(data.error || "Edge Function gagal.");
  return data;
}

export async function sbAdminCreateUser(input: { email: string; password: string; name: string; username?: string; role: string; branchId: string | null }): Promise<any> {
  const c = await getClient();
  if (!c) throw new Error("Supabase belum dikonfigurasi.");
  const { data: { session } } = await c.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("Login Supabase dulu (sesi tidak ditemukan).");
  const url = import.meta.env.VITE_SUPABASE_URL as string;
  if (!url) throw new Error("Supabase belum dikonfigurasi.");
  const res = await fetch(`${url}/functions/v1/admin-create-user`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => ({ ok: false, error: "Respons Edge Function bukan JSON" }));
  if (!res.ok || !data.ok) throw new Error(data.error || `Edge Function gagal (HTTP ${res.status}).`);
  return data;
}

export async function sbAdminUsers(action: "list" | "update" | "delete", payload: any = {}): Promise<any> {
  const c = await getClient();
  if (!c) throw new Error("Supabase belum dikonfigurasi.");
  const { data: { session } } = await c.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("Login Supabase dulu (sesi tidak ditemukan).");
  const url = import.meta.env.VITE_SUPABASE_URL as string;
  if (!url) throw new Error("Supabase belum dikonfigurasi.");
  const res = await fetch(`${url}/functions/v1/admin-manage-users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json().catch(() => ({ ok: false, error: "Respons Edge Function bukan JSON" }));
  if (!res.ok || !data.ok) throw new Error(data.error || `Edge Function gagal (HTTP ${res.status}).`);
  return data;
}
