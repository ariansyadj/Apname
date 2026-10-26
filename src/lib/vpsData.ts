// Lapisan data VPS untuk Apname (pengganti supabaseData.ts).
// Prinsip:
// - Mode lokal (tanpa VITE_VPS_MODE / VITE_VPS_URL) TIDAK berubah sama
//   sekali, sama seperti mode Supabase tidak mengubah mode lokal.
// - Mode VPS: backend Node di server sendiri adalah sumber kebenaran.
//   Token JWT disimpan di localStorage ('apname-vps-token'); user juga
//   disimpan ('apname-vps-user') supaya layar tidak berkedip saat reload,
//   tapi selalu divalidasi ulang lewat /api/auth/me.
// - PERBEDAAN PENTING dari Supabase: scan/mutasi ditulis PER BARIS
//   (vpsAddScan/vpsDeleteScan/vpsAddMutation) segera saat terjadi, bukan
//   lewat simpan-sesi-utuh. Metadata sesi (judul/status/kunci/snapshot)
//   tetap disimpan per sesi (vpsSaveSessionMeta). Inilah yang membuat dua
//   petugas dalam satu sesi tidak saling menghilangkan scan.
// - Realtime = WebSocket server (bukan Supabase Realtime). Event WS
//   diterjemahkan ke bentuk RTEvent yang sama seperti supabaseData.ts,
//   supaya merge di App.tsx tidak perlu ditulis ulang.
import { VPS_BASE } from "./vps";
import type { Product, Rack } from "../data";

export type VPSUser = { id: string; email: string; name: string; username: string; role: string; branchId: string | null; menus: string[] | null; claimsMissing: boolean };
export type VPSScan = { id: string; time: number; user: string; productId: string; rackId: string; level: string; qty: number; mode: string; barcode: string };
export type VPSMutation = { id: string; time: number; user: string; productId: string; kind: string; direction: "Masuk" | "Keluar"; qty: number; rackId: string; reference: string; note: string };
export type VPSSession = {
  id: string; title: string; branchId: string; racks: string[]; scopeLevels?: Record<string, string[]>;
  status: "Berjalan" | "Selesai"; createdAt: number; createdBy: string; lockedAt: number | null;
  snapshot: Record<string, number>; scans: VPSScan[]; mutations: VPSMutation[];
  adjustmentStatus: "Menunggu" | "Disetujui"; externalAt: number | null;
};
export type VPSMove = { id: string; time: number; user: string; productId: string; fromRack: string; fromLevel: string; toRack: string; toLevel: string; qty: number; reason: string; photo: string };
export type VPSState = {
  products: Product[]; racks: Rack[]; stock: Record<string, number>;
  sessions: VPSSession[]; moves: VPSMove[];
  externalTotals: Record<string, { stock: number; at: number }>;
  branches: { id: string; name: string; location_id: number; location_name: string }[];
};

const TOKEN_KEY = "apname-vps-token";
const USER_KEY = "apname-vps-user";
function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function apiHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}
async function api(path: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(`${VPS_BASE}${path}`, {
    method,
    headers: apiHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ ok: false, error: "Respons server bukan JSON" }));
  if (!res.ok || !data.ok) throw new Error(data.error || `Server gagal (HTTP ${res.status}).`);
  return data;
}

export async function vpsSignIn(emailOrUsername: string, password: string): Promise<VPSUser> {
  const data = await api("/api/auth/login", "POST", { emailOrUsername, password });
  try {
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  } catch { /* abaikan */ }
  return { ...data.user, claimsMissing: false };
}
export async function vpsSignOut() {
  try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch { /* abaikan */ }
}
export async function vpsGetSessionUser(): Promise<VPSUser | null> {
  const t = getToken();
  if (!t) return null;
  try {
    const data = await api("/api/auth/me", "GET");
    return { ...data.user, claimsMissing: false };
  } catch {
    // Token kedaluwarsa / server tidak terjangkau: bersihkan supaya layar
    // login muncul, bukan macet di state setengah login.
    try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch { /* abaikan */ }
    return null;
  }
}

export async function vpsLoadAll(): Promise<VPSState> {
  const data = await api("/api/state", "GET");
  return data.state as VPSState;
}
export async function vpsLoadSession(id: string): Promise<VPSSession | null> {
  const data = await api(`/api/sessions/${encodeURIComponent(id)}`, "GET");
  return (data.session || null) as VPSSession | null;
}
// Metadata sesi saja — TIDAK menyentuh scan/mutasi di server.
export async function vpsSaveSessionMeta(s: VPSSession) {
  await api(`/api/sessions/${encodeURIComponent(s.id)}`, "PUT", s);
}
export async function vpsAddScan(sessionId: string, scan: VPSScan) {
  await api(`/api/sessions/${encodeURIComponent(sessionId)}/scans`, "POST", scan);
}
export async function vpsDeleteScan(sessionId: string, scanId: string) {
  await api(`/api/sessions/${encodeURIComponent(sessionId)}/scans/${encodeURIComponent(scanId)}`, "DELETE");
}
export async function vpsAddMutation(sessionId: string, m: VPSMutation) {
  await api(`/api/sessions/${encodeURIComponent(sessionId)}/mutations`, "POST", m);
}
export async function vpsDeleteSession(sessionId: string) {
  await api(`/api/sessions/${encodeURIComponent(sessionId)}`, "DELETE");
}
export async function vpsSaveRacks(racks: Rack[]) {
  await api("/api/racks", "PUT", { racks });
}
export async function vpsSaveStock(stock: Record<string, number>) {
  await api("/api/stock", "PUT", { stock });
}
export async function vpsSaveProducts(products: Product[]) {
  await api("/api/products", "PUT", { products });
}
export async function vpsSaveMoves(moves: VPSMove[]) {
  await api("/api/moves", "PUT", { moves });
}
export async function vpsSaveExternalTotals(externalTotals: Record<string, { stock: number; at: number }>) {
  await api("/api/external-totals", "PUT", { externalTotals });
}
export async function vpsCallSync(action: "test" | "sync"): Promise<any> {
  return api(`/api/sync/${action === "test" ? "test" : "run"}`, "POST", {});
}
export async function vpsAdminCreateUser(input: { email: string; password: string; name: string; username?: string; role: string; branchId: string | null }): Promise<any> {
  return api("/api/admin/users", "POST", input);
}
export async function vpsAdminUsers(action: "list" | "update" | "delete", payload: any = {}): Promise<any> {
  if (action === "list") return api("/api/admin/users", "GET");
  if (action === "update") return api(`/api/admin/users/${encodeURIComponent(payload.userId)}`, "PATCH", payload);
  return api(`/api/admin/users/${encodeURIComponent(payload.userId)}`, "DELETE");
}
export async function vpsImport(state: VPSState): Promise<any> {
  return api("/api/admin/import", "POST", { confirm: true, state });
}

export type RTEvent = { eventType: "INSERT" | "UPDATE" | "DELETE"; table: string; newRow: any; oldRow: any };
export type RTHandlers = {
  onStatus?: (connected: boolean) => void;
  onSession?: (e: RTEvent) => void;
  onScan?: (e: RTEvent) => void;
  onMutation?: (e: RTEvent) => void;
  onStock?: (e: RTEvent) => void;
  onUnplaced?: (e: RTEvent) => void;
  onMove?: (e: RTEvent) => void;
  onRack?: (e: RTEvent) => void;
  onProduct?: (e: RTEvent) => void;
  onExternal?: (e: RTEvent) => void;
  onSyncDone?: () => void;
};

function iso(ms: number | null): string | null {
  return ms ? new Date(ms).toISOString() : null;
}
// Terjemahkan event WebSocket (sudah berbentuk frontend) ke RTEvent
// bentuk baris Supabase, supaya merge di App.tsx berlaku apa adanya.
function toRTEvent(kind: string, action: string, data: any, sessionId?: string): RTEvent {
  const eventType = action === "delete" ? "DELETE" : action === "insert" ? "INSERT" : "UPDATE";
  const tableMap: Record<string, string> = {
    session: "sessions", scan: "scans", mutation: "session_mutations",
    stock: "stock_by_rack", unplaced: "unplaced_stock", move: "moves",
    rack: "racks", product: "products", external: "external_totals",
  };
  const table = tableMap[kind] || kind;
  if (eventType === "DELETE") {
    if (kind === "scan" || kind === "mutation") return { eventType, table, newRow: null, oldRow: { id: data.id, session_id: sessionId } };
    if (kind === "session" || kind === "rack") return { eventType, table, newRow: null, oldRow: { id: data.id } };
    if (kind === "stock" || kind === "unplaced") {
      const [pid, rid, lv] = String(data.key || "").split("|");
      return { eventType, table, newRow: null, oldRow: kind === "unplaced" ? { product_id: pid, branch_id: rid } : { product_id: pid, rack_id: rid, level: lv } };
    }
    return { eventType, table, newRow: null, oldRow: data };
  }
  switch (kind) {
    case "session": {
      const s = data;
      return { eventType, table, newRow: { id: s.id, title: s.title, branch_id: s.branchId, racks: s.racks, scope_levels: s.scopeLevels || null, status: s.status, created_by: s.createdBy, created_at: iso(s.createdAt), locked_at: iso(s.lockedAt), snapshot: s.snapshot, external_at: iso(s.externalAt), adjustment_status: s.adjustmentStatus }, oldRow: null };
    }
    case "scan": {
      const sc = data;
      return { eventType, table, newRow: { id: sc.id, session_id: sessionId, scanned_at: iso(sc.time), scanned_by: sc.user, product_id: sc.productId, rack_id: sc.rackId, level: sc.level, qty: sc.qty, mode: sc.mode, barcode: sc.barcode }, oldRow: null };
    }
    case "mutation": {
      const m = data;
      return { eventType, table, newRow: { id: m.id, session_id: sessionId, created_at: iso(m.time), created_by: m.user, product_id: m.productId, kind: m.kind, direction: m.direction, qty: m.qty, rack_id: m.rackId || null, reference: m.reference, note: m.note }, oldRow: null };
    }
    case "stock": {
      const [pid, rid, lv] = String(data.key || "").split("|");
      return { eventType, table, newRow: { product_id: pid, rack_id: rid, level: lv, qty: data.qty }, oldRow: null };
    }
    case "unplaced": {
      const [pid, bid] = String(data.key || "").split("|");
      return { eventType, table, newRow: { product_id: pid, branch_id: bid, qty: data.qty }, oldRow: null };
    }
    case "move": {
      const m = data;
      return { eventType, table, newRow: { id: m.id, moved_at: iso(m.time), moved_by: m.user, product_id: m.productId, from_rack_id: m.fromRack, from_level: m.fromLevel, to_rack_id: m.toRack, to_level: m.toLevel, qty: m.qty, reason: m.reason, photo_data_url: m.photo || null }, oldRow: null };
    }
    case "rack": {
      const r = data;
      return { eventType, table, newRow: { id: r.id, branch_id: r.branchId, name: r.name, type: r.type, levels: r.levels, x: r.x, y: r.y, w: r.w, h: r.h, rot: r.rot }, oldRow: null };
    }
    case "product": {
      const p = data;
      return { eventType, table, newRow: { id: p.id, sku: p.sku, name: p.name, variant: p.variant, category: p.category, price: p.price, product_id: p.product_id, variation_id: p.variation_id, location_id: p.location_id, barcode: p.barcode, location_name: p.location_name }, oldRow: null };
    }
    case "external": {
      const e = data;
      return { eventType, table, newRow: { product_id: e.productId, stock: e.stock, updated_at: iso(e.at) }, oldRow: null };
    }
    default:
      return { eventType, table, newRow: data, oldRow: null };
  }
}

export function vpsSubscribe(h: RTHandlers): () => void {
  const token = getToken();
  if (!token) { h.onStatus?.(false); return () => {}; }
  const proto = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss" : "ws";
  const host = VPS_BASE ? VPS_BASE.replace(/^https?:\/\//, "") : window.location.host;
  const url = `${proto}://${host}/ws?token=${encodeURIComponent(token)}`;
  let ws: WebSocket | null = null;
  let closed = false;
  let retryMs = 3000;
  const connect = () => {
    if (closed) return;
    try { ws = new WebSocket(url); } catch { schedule(); return; }
    ws.onopen = () => { retryMs = 3000; h.onStatus?.(true); };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.kind === "hello") return;
        if (msg.kind === "sync") { h.onSyncDone?.(); return; }
        const rt = toRTEvent(msg.kind, msg.action, msg.data, msg.sessionId);
        if (msg.kind === "session") h.onSession?.(rt);
        else if (msg.kind === "scan") h.onScan?.(rt);
        else if (msg.kind === "mutation") h.onMutation?.(rt);
        else if (msg.kind === "stock") h.onStock?.(rt);
        else if (msg.kind === "unplaced") h.onUnplaced?.(rt);
        else if (msg.kind === "move") h.onMove?.(rt);
        else if (msg.kind === "rack") h.onRack?.(rt);
        else if (msg.kind === "product") h.onProduct?.(rt);
        else if (msg.kind === "external") h.onExternal?.(rt);
      } catch { /* abaikan pesan rusak */ }
    };
    ws.onclose = () => { h.onStatus?.(false); schedule(); };
    ws.onerror = () => { try { ws?.close(); } catch { /* abaikan */ } };
  };
  const schedule = () => {
    if (closed) return;
    const ms = retryMs;
    retryMs = Math.min(retryMs * 2, 30000);
    setTimeout(connect, ms);
  };
  connect();
  return () => { closed = true; try { ws?.close(); } catch { /* abaikan */ } };
}
