// Backend VPS Apname: API HTTP + WebSocket realtime + sync iNOX terjadwal.
// Menggantikan Supabase (Auth/RLS/Realtime/Edge Function) sepenuhnya.
// Otorisasi ditegakkan di sini (lihat Fase2-design.md). Tidak ada
// kredensial di file ini — semua dari environment (.env, hak 600).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { pool, withTx, iso, msOf, num, seedBranches } from "./db.js";
import { signToken, verifyToken, publicUser, normalizeLogin, verifyPassword, hashPassword } from "./auth.js";
import { inoxTest, inoxSync } from "./inox.js";

const PORT = Number(process.env.PORT || 4000);
const FRONTEND_DIR = process.env.FRONTEND_DIR || "";
const SYNC_MIN = Number(process.env.SYNC_INTERVAL_MIN || 30);
const BODY_LIMIT = 50 * 1024 * 1024;

// ---------- util HTTP ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error("Body terlalu besar.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) { resolve({}); return; }
      try { resolve(JSON.parse(text)); } catch { reject(new Error("Body bukan JSON.")); }
    });
    req.on("error", reject);
  });
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function authUser(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) throw new HttpError(401, "Login dulu (token tidak ditemukan).");
  const data = verifyToken(m[1]);
  if (!data) throw new HttpError(401, "Sesi login tidak valid / kedaluwarsa. Login ulang.");
  return data;
}
function requireSuper(u) {
  if (u.role !== "super") throw new HttpError(403, "Hanya Super Admin.");
}
const isSuper = (u) => u.role === "super";
function canBranch(u, branchId) { return isSuper(u) || u.branchId === branchId; }

// ---------- bentuk frontend (sama seperti SBState/supabaseData.ts) ----------
const branchShape = (b) => ({ id: String(b.id), name: String(b.name), location_id: Number(b.location_id), location_name: String(b.location_name) });
const rackShape = (r) => ({
  id: String(r.id), branchId: String(r.branch_id), name: String(r.name),
  type: r.type === "retur" ? "retur" : "normal",
  levels: Array.isArray(r.levels) ? r.levels : [],
  x: Number(r.x ?? 20), y: Number(r.y ?? 20), w: Number(r.w ?? 160), h: Number(r.h ?? 90), rot: Number(r.rot ?? 0),
});
const productShape = (p) => ({
  id: String(p.id), sku: String(p.sku || ""), name: String(p.name || ""), variant: String(p.variant || ""),
  category: String(p.category || ""), price: num(p.price),
  product_id: Number(p.product_id || 0), variation_id: Number(p.variation_id || 0),
  location_id: Number(p.location_id || 0), barcode: String(p.barcode || p.sku || ""),
  location_name: p.location_name ? String(p.location_name) : undefined,
});
const scanShape = (s) => ({
  id: String(s.id), time: msOf(s.scanned_at) || 0, user: String(s.scanned_by || ""),
  productId: String(s.product_id), rackId: String(s.rack_id), level: String(s.level),
  qty: Number(s.qty || 0), mode: String(s.mode || ""), barcode: String(s.barcode || ""),
});
const mutShape = (m) => ({
  id: String(m.id), time: msOf(m.created_at) || 0, user: String(m.created_by || ""),
  productId: String(m.product_id), kind: String(m.kind || ""),
  direction: m.direction === "Masuk" ? "Masuk" : "Keluar", qty: Number(m.qty || 0),
  rackId: String(m.rack_id || ""), reference: String(m.reference || ""), note: String(m.note || ""),
});
const moveShape = (m) => ({
  id: String(m.id), time: msOf(m.moved_at) || 0, user: String(m.moved_by || ""),
  productId: String(m.product_id), fromRack: String(m.from_rack_id), fromLevel: String(m.from_level),
  toRack: String(m.to_rack_id), toLevel: String(m.to_level),
  qty: Number(m.qty || 0), reason: String(m.reason || ""), photo: String(m.photo_data_url || ""),
});
async function sessionShape(client, s) {
  const sc = await client.query("SELECT * FROM scans WHERE session_id = $1 ORDER BY scanned_at DESC", [s.id]);
  const mu = await client.query("SELECT * FROM session_mutations WHERE session_id = $1 ORDER BY created_at DESC", [s.id]);
  return {
    id: String(s.id), title: String(s.title || ""), branchId: String(s.branch_id),
    racks: Array.isArray(s.racks) ? s.racks : [],
    scopeLevels: s.scope_levels || undefined,
    status: s.status === "Selesai" ? "Selesai" : "Berjalan",
    createdAt: msOf(s.created_at) || 0, createdBy: String(s.created_by || ""),
    lockedAt: msOf(s.locked_at), snapshot: s.snapshot || {},
    scans: sc.rows.map(scanShape), mutations: mu.rows.map(mutShape),
    adjustmentStatus: s.adjustment_status === "Disetujui" ? "Disetujui" : "Menunggu",
    externalAt: msOf(s.external_at),
  };
}

// ---------- WebSocket ----------
const wsClients = new Set(); // { ws, user }
function broadcast(event) {
  const text = JSON.stringify(event);
  for (const c of wsClients) {
    if (c.ws.readyState !== 1) continue;
    if (event.branchId && !isSuper(c.user) && c.user.branchId !== event.branchId) continue;
    try { c.ws.send(text); } catch { /* abaikan */ }
  }
}

// ---------- state ----------
async function loadState(u) {
  const superUser = isSuper(u);
  const branchParam = superUser ? null : u.branchId;
  const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const branches = await q(superUser ? "SELECT * FROM branches ORDER BY id" : "SELECT * FROM branches WHERE id = $1 ORDER BY id", superUser ? [] : [branchParam]);
  const racks = await q(superUser ? "SELECT * FROM racks ORDER BY name" : "SELECT * FROM racks WHERE branch_id = $1 ORDER BY name", superUser ? [] : [branchParam]);
  const products = await q("SELECT * FROM products ORDER BY name, variant");
  const stockRows = await q(
    superUser
      ? "SELECT * FROM stock_by_rack"
      : "SELECT s.* FROM stock_by_rack s JOIN racks r ON r.id = s.rack_id WHERE r.branch_id = $1",
    superUser ? [] : [branchParam],
  );
  const unplacedRows = await q(superUser ? "SELECT * FROM unplaced_stock" : "SELECT * FROM unplaced_stock WHERE branch_id = $1", superUser ? [] : [branchParam]);
  const sessionRows = await q(superUser ? "SELECT * FROM sessions ORDER BY created_at DESC" : "SELECT * FROM sessions WHERE branch_id = $1 ORDER BY created_at DESC", superUser ? [] : [branchParam]);
  const sessionIds = sessionRows.map((s) => s.id);
  let scanRows = [];
  let mutRows = [];
  if (sessionIds.length > 0) {
    scanRows = await q("SELECT * FROM scans WHERE session_id = ANY($1) ORDER BY scanned_at DESC", [sessionIds]);
    mutRows = await q("SELECT * FROM session_mutations WHERE session_id = ANY($1) ORDER BY created_at DESC", [sessionIds]);
  }
  const moves = await q("SELECT * FROM moves ORDER BY moved_at DESC");
  const extRows = await q("SELECT * FROM external_totals");

  const prodList = products.map(productShape);
  const prodById = new Map(prodList.map((p) => [p.id, p]));
  const stock = {};
  for (const s of stockRows) stock[`${s.product_id}|${s.rack_id}|${s.level}`] = Number(s.qty || 0);
  for (const x of unplacedRows) stock[`${x.product_id}|${x.branch_id}|BELUM`] = Number(x.qty || 0);
  const scansBy = new Map();
  for (const s of scanRows) { const a = scansBy.get(s.session_id) || []; a.push(scanShape(s)); scansBy.set(s.session_id, a); }
  const mutsBy = new Map();
  for (const m of mutRows) { const a = mutsBy.get(m.session_id) || []; a.push(mutShape(m)); mutsBy.set(m.session_id, a); }
  const sessions = sessionRows.map((s) => ({
    id: String(s.id), title: String(s.title || ""), branchId: String(s.branch_id),
    racks: Array.isArray(s.racks) ? s.racks : [], scopeLevels: s.scope_levels || undefined,
    status: s.status === "Selesai" ? "Selesai" : "Berjalan",
    createdAt: msOf(s.created_at) || 0, createdBy: String(s.created_by || ""),
    lockedAt: msOf(s.locked_at), snapshot: s.snapshot || {},
    scans: scansBy.get(s.id) || [], mutations: mutsBy.get(s.id) || [],
    adjustmentStatus: s.adjustment_status === "Disetujui" ? "Disetujui" : "Menunggu",
    externalAt: msOf(s.external_at),
  }));
  const externalTotals = {};
  for (const e of extRows) {
    const v = { stock: Number(e.stock || 0), at: msOf(e.updated_at) || 0 };
    externalTotals[String(e.product_id)] = v;
    const pr = prodById.get(String(e.product_id));
    if (pr) externalTotals[`${pr.product_id}|${pr.variation_id}|${pr.location_id}`] = v;
  }
  return {
    products: prodList, racks: racks.map(rackShape), stock, sessions,
    moves: moves.map(moveShape), externalTotals,
    branches: branches.map(branchShape),
  };
}

// ---------- sync iNOX ----------
let syncRunning = false;
async function runSyncNow() {
  const username = process.env.INOX_USERNAME || "";
  const password = process.env.INOX_PASSWORD || "";
  if (!username || !password) throw new Error("INOX_USERNAME / INOX_PASSWORD belum diset di .env server.");
  if (syncRunning) throw new HttpError(409, "Sync sedang berjalan. Tunggu selesai.");
  syncRunning = true;
  try {
    const res = await inoxSync(pool, username, password);
    broadcast({ kind: "sync", action: "done", branchId: null, data: res });
    return res;
  } finally {
    syncRunning = false;
  }
}
async function runScheduledSync() {
  try {
    const res = await runSyncNow();
    console.log("[apname] sync terjadwal OK:", res.branchSummary, `(${res.fetched}/${res.recordsTotal})`);
  } catch (e) {
    console.log("[apname] sync terjadwal gagal:", e.message);
  }
}

// ---------- rute ----------
async function handleApi(req, res, pathname) {
  const parts = pathname.split("/").filter(Boolean); // ["api", ...]
  const method = req.method;
  const seg = parts.slice(1);

  if (method === "GET" && pathname === "/api/health") return sendJson(res, 200, { ok: true, time: Date.now() });

  // --- auth ---
  if (method === "POST" && pathname === "/api/auth/login") {
    const body = await readBody(req);
    const email = normalizeLogin(body.emailOrUsername || body.email || "");
    const usernameRaw = String(body.emailOrUsername || body.email || "").trim();
    const { rows } = await pool.query("SELECT * FROM users WHERE email = $1 OR username = $2 LIMIT 1", [email, usernameRaw]);
    const user = rows[0];
    if (!user || !verifyPassword(String(body.password || ""), user.password_hash)) {
      throw new HttpError(401, "Email/username atau password salah.");
    }
    return sendJson(res, 200, { ok: true, user: publicUser(user), token: signToken(user) });
  }
  if (method === "GET" && pathname === "/api/auth/me") {
    const u = authUser(req);
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [u.sub]);
    if (!rows[0]) throw new HttpError(401, "Akun tidak ditemukan.");
    return sendJson(res, 200, { ok: true, user: publicUser(rows[0]) });
  }

  // Semua rute di bawah butuh login.
  const u = authUser(req);

  if (method === "GET" && pathname === "/api/state") {
    return sendJson(res, 200, { ok: true, state: await loadState(u) });
  }

  // --- sesi: baca satu sesi (untuk realtime INSERT dari device lain) ---
  if (method === "GET" && seg[0] === "sessions" && seg.length === 2) {
    const id = decodeURIComponent(seg[1]);
    const row = (await pool.query("SELECT * FROM sessions WHERE id = $1", [id])).rows[0];
    if (!row) throw new HttpError(404, "Sesi tidak ditemukan.");
    if (!canBranch(u, row.branch_id)) throw new HttpError(403, "Bukan cabang Anda.");
    const shape = await withTx(async (c) => sessionShape(c, row));
    return sendJson(res, 200, { ok: true, session: shape });
  }

  // --- sesi: metadata saja (scan/mutasi lewat endpoint per baris) ---
  if (method === "PUT" && seg[0] === "sessions" && seg.length === 2) {
    const body = await readBody(req);
    const id = decodeURIComponent(seg[1]);
    const saved = await withTx(async (c) => {
      const ex = await c.query("SELECT * FROM sessions WHERE id = $1", [id]);
      const branchId = ex.rows[0] ? String(ex.rows[0].branch_id) : String(body.branchId || "");
      if (!canBranch(u, branchId)) throw new HttpError(403, "Bukan cabang Anda.");
      await c.query(
        `INSERT INTO sessions (id, title, branch_id, racks, scope_levels, status, created_by, created_at, locked_at, snapshot, external_at, adjustment_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, racks = EXCLUDED.racks, scope_levels = EXCLUDED.scope_levels,
           status = EXCLUDED.status, locked_at = EXCLUDED.locked_at, snapshot = EXCLUDED.snapshot,
           external_at = EXCLUDED.external_at, adjustment_status = EXCLUDED.adjustment_status`,
        [id, String(body.title || ""), branchId, JSON.stringify(Array.isArray(body.racks) ? body.racks : []),
         body.scopeLevels ? JSON.stringify(body.scopeLevels) : null, body.status === "Selesai" ? "Selesai" : "Berjalan",
         String(body.createdBy || u.name), iso(body.createdAt) || new Date().toISOString(), iso(body.lockedAt),
         JSON.stringify(body.snapshot || {}), iso(body.externalAt), body.adjustmentStatus === "Disetujui" ? "Disetujui" : "Menunggu"],
      );
      const row = (await c.query("SELECT * FROM sessions WHERE id = $1", [id])).rows[0];
      return { shape: await sessionShape(c, row), isNew: !ex.rows[0], branchId };
    });
    broadcast({ kind: "session", action: saved.isNew ? "insert" : "update", branchId: saved.branchId, data: saved.shape });
    return sendJson(res, 200, { ok: true, session: saved.shape });
  }

  // --- scan per baris ---
  if (method === "POST" && seg[0] === "sessions" && seg[2] === "scans" && seg.length === 3) {
    const body = await readBody(req);
    const sessionId = decodeURIComponent(seg[1]);
    const sess = (await pool.query("SELECT branch_id FROM sessions WHERE id = $1", [sessionId])).rows[0];
    if (!sess) throw new HttpError(404, "Sesi tidak ditemukan.");
    if (!canBranch(u, sess.branch_id)) throw new HttpError(403, "Bukan cabang Anda.");
    await pool.query(
      `INSERT INTO scans (id, session_id, scanned_at, scanned_by, product_id, rack_id, level, qty, mode, barcode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET scanned_at = EXCLUDED.scanned_at, scanned_by = EXCLUDED.scanned_by,
         product_id = EXCLUDED.product_id, rack_id = EXCLUDED.rack_id, level = EXCLUDED.level,
         qty = EXCLUDED.qty, mode = EXCLUDED.mode, barcode = EXCLUDED.barcode`,
      [String(body.id), sessionId, iso(body.time) || new Date().toISOString(), String(body.user || u.name),
       String(body.productId), String(body.rackId), String(body.level), Number(body.qty || 0),
       String(body.mode || ""), String(body.barcode || "")],
    );
    broadcast({ kind: "scan", action: "insert", branchId: String(sess.branch_id), sessionId, data: { ...body, id: String(body.id) } });
    return sendJson(res, 200, { ok: true });
  }
  if (method === "DELETE" && seg[0] === "sessions" && seg[2] === "scans" && seg.length === 4) {
    const sessionId = decodeURIComponent(seg[1]);
    const scanId = decodeURIComponent(seg[3]);
    const sess = (await pool.query("SELECT branch_id FROM sessions WHERE id = $1", [sessionId])).rows[0];
    if (!sess) throw new HttpError(404, "Sesi tidak ditemukan.");
    if (!canBranch(u, sess.branch_id)) throw new HttpError(403, "Bukan cabang Anda.");
    const del = await pool.query("DELETE FROM scans WHERE id = $1 AND session_id = $2", [scanId, sessionId]);
    if (del.rowCount === 0) throw new HttpError(404, "Scan tidak ditemukan.");
    broadcast({ kind: "scan", action: "delete", branchId: String(sess.branch_id), sessionId, data: { id: scanId } });
    return sendJson(res, 200, { ok: true });
  }

  // --- mutasi per baris ---
  if (method === "POST" && seg[0] === "sessions" && seg[2] === "mutations" && seg.length === 3) {
    const body = await readBody(req);
    const sessionId = decodeURIComponent(seg[1]);
    const sess = (await pool.query("SELECT branch_id FROM sessions WHERE id = $1", [sessionId])).rows[0];
    if (!sess) throw new HttpError(404, "Sesi tidak ditemukan.");
    if (!canBranch(u, sess.branch_id)) throw new HttpError(403, "Bukan cabang Anda.");
    await pool.query(
      `INSERT INTO session_mutations (id, session_id, created_at, created_by, product_id, kind, direction, qty, rack_id, reference, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET created_at = EXCLUDED.created_at, created_by = EXCLUDED.created_by,
         product_id = EXCLUDED.product_id, kind = EXCLUDED.kind, direction = EXCLUDED.direction,
         qty = EXCLUDED.qty, rack_id = EXCLUDED.rack_id, reference = EXCLUDED.reference, note = EXCLUDED.note`,
      [String(body.id), sessionId, iso(body.time) || new Date().toISOString(), String(body.user || u.name),
       String(body.productId), String(body.kind || ""), body.direction === "Masuk" ? "Masuk" : "Keluar",
       Number(body.qty || 0), String(body.rackId || "") || null, String(body.reference || ""), String(body.note || "")],
    );
    broadcast({ kind: "mutation", action: "insert", branchId: String(sess.branch_id), sessionId, data: { ...body, id: String(body.id) } });
    return sendJson(res, 200, { ok: true });
  }
  if (method === "DELETE" && seg[0] === "sessions" && seg[2] === "mutations" && seg.length === 4) {
    const sessionId = decodeURIComponent(seg[1]);
    const mutId = decodeURIComponent(seg[3]);
    const sess = (await pool.query("SELECT branch_id FROM sessions WHERE id = $1", [sessionId])).rows[0];
    if (!sess) throw new HttpError(404, "Sesi tidak ditemukan.");
    if (!canBranch(u, sess.branch_id)) throw new HttpError(403, "Bukan cabang Anda.");
    const del = await pool.query("DELETE FROM session_mutations WHERE id = $1 AND session_id = $2", [mutId, sessionId]);
    if (del.rowCount === 0) throw new HttpError(404, "Mutasi tidak ditemukan.");
    broadcast({ kind: "mutation", action: "delete", branchId: String(sess.branch_id), sessionId, data: { id: mutId } });
    return sendJson(res, 200, { ok: true });
  }

  // --- hapus sesi ---
  if (method === "DELETE" && seg[0] === "sessions" && seg.length === 2) {
    const id = decodeURIComponent(seg[1]);
    const sess = (await pool.query("SELECT branch_id FROM sessions WHERE id = $1", [id])).rows[0];
    if (!sess) throw new HttpError(404, "Sesi tidak ditemukan.");
    if (!canBranch(u, sess.branch_id)) throw new HttpError(403, "Bukan cabang Anda.");
    await pool.query("DELETE FROM sessions WHERE id = $1", [id]);
    broadcast({ kind: "session", action: "delete", branchId: String(sess.branch_id), data: { id } });
    return sendJson(res, 200, { ok: true });
  }

  // --- rak (ganti per scope) ---
  if (method === "PUT" && pathname === "/api/racks") {
    const body = await readBody(req);
    const list = Array.isArray(body.racks) ? body.racks : (Array.isArray(body) ? body : []);
    const mine = isSuper(u) ? list : list.filter((r) => String(r.branchId) === u.branchId);
    const events = await withTx(async (c) => {
      const oldRows = isSuper(u)
        ? (await c.query("SELECT id, branch_id FROM racks")).rows
        : (await c.query("SELECT id, branch_id FROM racks WHERE branch_id = $1", [u.branchId])).rows;
      const keep = new Set(mine.map((r) => String(r.id)));
      const ev = [];
      for (const row of oldRows) {
        if (!keep.has(String(row.id))) {
          await c.query("DELETE FROM racks WHERE id = $1", [row.id]);
          ev.push({ kind: "rack", action: "delete", branchId: String(row.branch_id), data: { id: String(row.id) } });
        }
      }
      for (const r of mine) {
        await c.query(
          `INSERT INTO racks (id, branch_id, name, type, levels, x, y, w, h, rot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO UPDATE SET branch_id = EXCLUDED.branch_id, name = EXCLUDED.name, type = EXCLUDED.type,
             levels = EXCLUDED.levels, x = EXCLUDED.x, y = EXCLUDED.y, w = EXCLUDED.w, h = EXCLUDED.h, rot = EXCLUDED.rot`,
          [String(r.id), String(r.branchId), String(r.name), r.type === "retur" ? "retur" : "normal",
           JSON.stringify(Array.isArray(r.levels) ? r.levels : []), Number(r.x ?? 20), Number(r.y ?? 20),
           Number(r.w ?? 160), Number(r.h ?? 90), Number(r.rot ?? 0)],
        );
        ev.push({ kind: "rack", action: "upsert", branchId: String(r.branchId), data: rackShape({ ...r, branch_id: r.branchId }) });
      }
      return ev;
    });
    for (const ev of events) broadcast(ev);
    return sendJson(res, 200, { ok: true });
  }

  // --- stok (ganti per scope; hanya saat kunci/pindah/rename) ---
  if (method === "PUT" && pathname === "/api/stock") {
    const body = await readBody(req);
    const dict = body.stock || {};
    const events = await withTx(async (c) => {
      const rackRows = (await c.query("SELECT id, branch_id FROM racks")).rows;
      const rackBranch = new Map(rackRows.map((r) => [String(r.id), String(r.branch_id)]));
      const inScope = (key) => {
        const [pid, rid, lv] = key.split("|");
        if (lv === "BELUM" || rid === "BELUM") return isSuper(u) || rid === u.branchId;
        const b = rackBranch.get(rid);
        return b !== undefined && (isSuper(u) || b === u.branchId);
      };
      const oldStock = isSuper(u)
        ? (await c.query("SELECT product_id, rack_id, level FROM stock_by_rack")).rows.map((r) => `${r.product_id}|${r.rack_id}|${r.level}`)
        : (await c.query("SELECT s.product_id, s.rack_id, s.level FROM stock_by_rack s JOIN racks r ON r.id = s.rack_id WHERE r.branch_id = $1", [u.branchId])).rows.map((r) => `${r.product_id}|${r.rack_id}|${r.level}`);
      const oldUnplaced = isSuper(u)
        ? (await c.query("SELECT product_id, branch_id FROM unplaced_stock")).rows.map((r) => `${r.product_id}|${r.branch_id}|BELUM`)
        : (await c.query("SELECT product_id, branch_id FROM unplaced_stock WHERE branch_id = $1", [u.branchId])).rows.map((r) => `${r.product_id}|${r.branch_id}|BELUM`);
      const oldMap = new Map([...oldStock, ...oldUnplaced].map((k) => [k, 1]));
      const newMap = new Map();
      for (const [k, qty] of Object.entries(dict)) {
        if (!qty || !inScope(k)) continue;
        newMap.set(k, Number(qty));
      }
      if (isSuper(u)) {
        await c.query("DELETE FROM stock_by_rack");
        await c.query("DELETE FROM unplaced_stock");
      } else {
        await c.query("DELETE FROM stock_by_rack s USING racks r WHERE s.rack_id = r.id AND r.branch_id = $1", [u.branchId]);
        await c.query("DELETE FROM unplaced_stock WHERE branch_id = $1", [u.branchId]);
      }
      const prodIds = new Set((await c.query("SELECT id FROM products")).rows.map((r) => String(r.id)));
      for (const [k, qty] of newMap) {
        const [pid, rid, lv] = k.split("|");
        if (!prodIds.has(pid)) continue;
        if (lv === "BELUM" || rid === "BELUM") {
          await c.query("INSERT INTO unplaced_stock (product_id, branch_id, qty) VALUES ($1, $2, $3) ON CONFLICT (product_id) DO UPDATE SET branch_id = EXCLUDED.branch_id, qty = EXCLUDED.qty, updated_at = now()", [pid, rid, qty]);
        } else {
          if (!rackBranch.has(rid)) continue;
          await c.query("INSERT INTO stock_by_rack (product_id, rack_id, level, qty) VALUES ($1, $2, $3, $4) ON CONFLICT (product_id, rack_id, level) DO UPDATE SET qty = EXCLUDED.qty", [pid, rid, lv, qty]);
        }
      }
      const ev = [];
      const allKeys = new Set([...oldMap.keys(), ...newMap.keys()]);
      for (const k of allKeys) {
        const isUnplaced = k.endsWith("|BELUM");
        const [, rid] = k.split("|");
        const branchId = isUnplaced ? rid : rackBranch.get(rid);
        if (newMap.has(k)) ev.push({ kind: isUnplaced ? "unplaced" : "stock", action: "upsert", branchId: branchId || null, data: { key: k, qty: newMap.get(k) } });
        else ev.push({ kind: isUnplaced ? "unplaced" : "stock", action: "delete", branchId: branchId || null, data: { key: k, qty: 0 } });
      }
      return ev;
    });
    for (const ev of events) broadcast(ev);
    return sendJson(res, 200, { ok: true });
  }

  // --- produk (super) ---
  if (method === "PUT" && pathname === "/api/products") {
    requireSuper(u);
    const body = await readBody(req);
    const list = Array.isArray(body.products) ? body.products : (Array.isArray(body) ? body : []);
    for (const p of list) {
      const res1 = await pool.query(
        `INSERT INTO products (id, sku, name, variant, category, price, product_id, variation_id, location_id, location_name, barcode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (product_id, variation_id, location_id) DO UPDATE SET sku = EXCLUDED.sku, name = EXCLUDED.name,
           variant = EXCLUDED.variant, category = EXCLUDED.category, price = EXCLUDED.price,
           location_name = EXCLUDED.location_name, barcode = EXCLUDED.barcode
         RETURNING id`,
        [String(p.id), String(p.sku || ""), String(p.name || ""), String(p.variant || ""), p.category || null,
         Number(p.price || 0), Number(p.product_id || 0), Number(p.variation_id || 0), Number(p.location_id || 0),
         p.location_name || null, String(p.barcode || p.sku || "")],
      );
      const row = (await pool.query("SELECT * FROM products WHERE id = $1", [res1.rows[0].id])).rows[0];
      if (row) broadcast({ kind: "product", action: "upsert", branchId: null, data: productShape(row) });
    }
    return sendJson(res, 200, { ok: true, count: list.length });
  }

  // --- pindah ---
  if (method === "PUT" && pathname === "/api/moves") {
    const body = await readBody(req);
    const list = Array.isArray(body.moves) ? body.moves : (Array.isArray(body) ? body : []);
    for (const m of list) {
      await pool.query(
        `INSERT INTO moves (id, moved_at, moved_by, product_id, from_rack_id, from_level, to_rack_id, to_level, qty, reason, photo_data_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET moved_at = EXCLUDED.moved_at, moved_by = EXCLUDED.moved_by, product_id = EXCLUDED.product_id,
           from_rack_id = EXCLUDED.from_rack_id, from_level = EXCLUDED.from_level, to_rack_id = EXCLUDED.to_rack_id,
           to_level = EXCLUDED.to_level, qty = EXCLUDED.qty, reason = EXCLUDED.reason, photo_data_url = EXCLUDED.photo_data_url`,
        [String(m.id), iso(m.time) || new Date().toISOString(), String(m.user || u.name), String(m.productId),
         String(m.fromRack), String(m.fromLevel), String(m.toRack), String(m.toLevel), Number(m.qty || 0),
         String(m.reason || ""), String(m.photo || "") || null],
      );
      broadcast({ kind: "move", action: "insert", branchId: null, data: { ...m, id: String(m.id) } });
    }
    return sendJson(res, 200, { ok: true, count: list.length });
  }

  // --- total eksternal (super) ---
  if (method === "PUT" && pathname === "/api/external-totals") {
    requireSuper(u);
    const body = await readBody(req);
    const dict = body.externalTotals || body;
    const prodIds = new Set((await pool.query("SELECT id FROM products")).rows.map((r) => String(r.id)));
    for (const [id, v] of Object.entries(dict)) {
      if (!prodIds.has(id)) continue;
      await pool.query(
        "INSERT INTO external_totals (product_id, stock, updated_at) VALUES ($1, $2, $3) ON CONFLICT (product_id) DO UPDATE SET stock = EXCLUDED.stock, updated_at = EXCLUDED.updated_at",
        [id, Number(v.stock || 0), iso(v.at) || new Date().toISOString()],
      );
      broadcast({ kind: "external", action: "upsert", branchId: null, data: { productId: id, stock: Number(v.stock || 0), at: Number(v.at || 0) } });
    }
    return sendJson(res, 200, { ok: true });
  }

  // --- sync iNOX (super) ---
  if (method === "POST" && pathname === "/api/sync/test") {
    requireSuper(u);
    const username = process.env.INOX_USERNAME || "";
    const password = process.env.INOX_PASSWORD || "";
    if (!username || !password) throw new Error("INOX_USERNAME / INOX_PASSWORD belum diset di .env server.");
    const t = await inoxTest(username, password);
    return sendJson(res, 200, { ok: true, action: "test", ...t });
  }
  if (method === "POST" && pathname === "/api/sync/run") {
    requireSuper(u);
    const r = await runSyncNow();
    return sendJson(res, 200, { ok: true, action: "sync", ...r });
  }
  if (method === "GET" && pathname === "/api/sync/runs") {
    requireSuper(u);
    const { rows } = await pool.query("SELECT * FROM sync_runs ORDER BY created_at DESC LIMIT 20");
    return sendJson(res, 200, { ok: true, runs: rows });
  }

  // --- admin users (super) ---
  if (pathname === "/api/admin/users" && method === "GET") {
    requireSuper(u);
    const { rows } = await pool.query("SELECT id, email, username, name, role, branch_id, menus, created_at FROM users ORDER BY created_at");
    return sendJson(res, 200, { ok: true, users: rows.map((r) => ({ id: r.id, email: r.email, username: r.username || "", name: r.name, role: r.role, branchId: r.branch_id || null, menus: Array.isArray(r.menus) ? r.menus : null })) });
  }
  if (pathname === "/api/admin/users" && method === "POST") {
    requireSuper(u);
    const body = await readBody(req);
    const email = normalizeLogin(body.email || "");
    if (!body.password || String(body.password).length < 6) throw new HttpError(400, "Password minimal 6 karakter.");
    const role = ["super", "admin", "karyawan"].includes(body.role) ? body.role : "karyawan";
    const id = `u-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    try {
      await pool.query(
        "INSERT INTO users (id, email, username, name, role, branch_id, menus, password_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [id, email, body.username ? String(body.username) : null, String(body.name || email), role, body.branchId || null, body.menus ? JSON.stringify(body.menus) : null, hashPassword(String(body.password))],
      );
    } catch (e) {
      if (String(e.message).includes("duplicate")) throw new HttpError(400, "Email/username sudah dipakai.");
      throw e;
    }
    return sendJson(res, 200, { ok: true, id });
  }
  if (seg[0] === "admin" && seg[1] === "users" && seg.length === 3) {
    requireSuper(u);
    const id = decodeURIComponent(seg[2]);
    if (method === "PATCH") {
      const body = await readBody(req);
      if (id === u.sub && body.role && body.role !== "super") throw new HttpError(403, "Tidak bisa menurunkan role akun sendiri.");
      const sets = [];
      const params = [];
      const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
      if (body.name !== undefined) push("name", String(body.name));
      if (body.username !== undefined) push("username", body.username ? String(body.username) : null);
      if (body.role !== undefined && ["super", "admin", "karyawan"].includes(body.role)) push("role", body.role);
      if (body.branchId !== undefined) push("branch_id", body.branchId || null);
      if (body.menus !== undefined) push("menus", body.menus ? JSON.stringify(body.menus) : null);
      if (body.password !== undefined) {
        if (String(body.password).length < 6) throw new HttpError(400, "Password minimal 6 karakter.");
        push("password_hash", hashPassword(String(body.password)));
      }
      if (sets.length === 0) throw new HttpError(400, "Tidak ada perubahan.");
      params.push(id);
      const r = await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
      if (r.rowCount === 0) throw new HttpError(404, "Akun tidak ditemukan.");
      return sendJson(res, 200, { ok: true });
    }
    if (method === "DELETE") {
      if (id === u.sub) throw new HttpError(403, "Tidak bisa menghapus akun sendiri.");
      const r = await pool.query("DELETE FROM users WHERE id = $1", [id]);
      if (r.rowCount === 0) throw new HttpError(404, "Akun tidak ditemukan.");
      return sendJson(res, 200, { ok: true });
    }
  }

  // --- import migrasi (super; butuh confirm: true) ---
  if (method === "POST" && pathname === "/api/admin/import") {
    requireSuper(u);
    const body = await readBody(req);
    if (body.confirm !== true) throw new HttpError(400, "Import butuh confirm: true.");
    const st = body.state || {};
    await withTx(async (c) => {
      for (const b of st.branches || []) {
        await c.query("INSERT INTO branches (id, name, location_id, location_name) VALUES ($1,$2,$3,$4) ON CONFLICT (location_id) DO UPDATE SET name = EXCLUDED.name, location_name = EXCLUDED.location_name", [String(b.id), String(b.name), Number(b.location_id), String(b.location_name)]);
      }
      for (const r of st.racks || []) {
        await c.query(
          "INSERT INTO racks (id, branch_id, name, type, levels, x, y, w, h, rot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO UPDATE SET branch_id = EXCLUDED.branch_id, name = EXCLUDED.name, type = EXCLUDED.type, levels = EXCLUDED.levels, x = EXCLUDED.x, y = EXCLUDED.y, w = EXCLUDED.w, h = EXCLUDED.h, rot = EXCLUDED.rot",
          [String(r.id), String(r.branchId), String(r.name), r.type === "retur" ? "retur" : "normal", JSON.stringify(r.levels || []), Number(r.x ?? 20), Number(r.y ?? 20), Number(r.w ?? 160), Number(r.h ?? 90), Number(r.rot ?? 0)],
        );
      }
      for (const p of st.products || []) {
        await c.query(
          "INSERT INTO products (id, sku, name, variant, category, price, product_id, variation_id, location_id, location_name, barcode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (product_id, variation_id, location_id) DO UPDATE SET sku = EXCLUDED.sku, name = EXCLUDED.name, variant = EXCLUDED.variant, category = EXCLUDED.category, price = EXCLUDED.price, location_name = EXCLUDED.location_name, barcode = EXCLUDED.barcode",
          [String(p.id), String(p.sku || ""), String(p.name || ""), String(p.variant || ""), p.category || null, Number(p.price || 0), Number(p.product_id || 0), Number(p.variation_id || 0), Number(p.location_id || 0), p.location_name || null, String(p.barcode || p.sku || "")],
        );
      }
      await c.query("DELETE FROM stock_by_rack");
      await c.query("DELETE FROM unplaced_stock");
      const prodIds = new Set((await c.query("SELECT id FROM products")).rows.map((r) => String(r.id)));
      for (const [k, qty] of Object.entries(st.stock || {})) {
        if (!qty) continue;
        const [pid, rid, lv] = k.split("|");
        if (!prodIds.has(pid)) continue;
        if (lv === "BELUM" || rid === "BELUM") await c.query("INSERT INTO unplaced_stock (product_id, branch_id, qty) VALUES ($1,$2,$3) ON CONFLICT (product_id) DO UPDATE SET branch_id = EXCLUDED.branch_id, qty = EXCLUDED.qty", [pid, rid, qty]);
        else await c.query("INSERT INTO stock_by_rack (product_id, rack_id, level, qty) VALUES ($1,$2,$3,$4) ON CONFLICT (product_id, rack_id, level) DO UPDATE SET qty = EXCLUDED.qty", [pid, rid, lv, qty]);
      }
      for (const s of st.sessions || []) {
        await c.query(
          "INSERT INTO sessions (id, title, branch_id, racks, scope_levels, status, created_by, created_at, locked_at, snapshot, external_at, adjustment_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, racks = EXCLUDED.racks, scope_levels = EXCLUDED.scope_levels, status = EXCLUDED.status, locked_at = EXCLUDED.locked_at, snapshot = EXCLUDED.snapshot, external_at = EXCLUDED.external_at, adjustment_status = EXCLUDED.adjustment_status",
          [String(s.id), String(s.title || ""), String(s.branchId), JSON.stringify(s.racks || []), s.scopeLevels ? JSON.stringify(s.scopeLevels) : null, s.status === "Selesai" ? "Selesai" : "Berjalan", String(s.createdBy || ""), iso(s.createdAt) || new Date().toISOString(), iso(s.lockedAt), JSON.stringify(s.snapshot || {}), iso(s.externalAt), s.adjustmentStatus === "Disetujui" ? "Disetujui" : "Menunggu"],
        );
        await c.query("DELETE FROM scans WHERE session_id = $1", [String(s.id)]);
        for (const sc of s.scans || []) {
          await c.query("INSERT INTO scans (id, session_id, scanned_at, scanned_by, product_id, rack_id, level, qty, mode, barcode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING", [String(sc.id), String(s.id), iso(sc.time) || new Date().toISOString(), String(sc.user || ""), String(sc.productId), String(sc.rackId), String(sc.level), Number(sc.qty || 0), String(sc.mode || ""), String(sc.barcode || "")]);
        }
        await c.query("DELETE FROM session_mutations WHERE session_id = $1", [String(s.id)]);
        for (const m of s.mutations || []) {
          await c.query("INSERT INTO session_mutations (id, session_id, created_at, created_by, product_id, kind, direction, qty, rack_id, reference, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING", [String(m.id), String(s.id), iso(m.time) || new Date().toISOString(), String(m.user || ""), String(m.productId), String(m.kind || ""), m.direction === "Masuk" ? "Masuk" : "Keluar", Number(m.qty || 0), String(m.rackId || "") || null, String(m.reference || ""), String(m.note || "")]);
        }
      }
      for (const m of st.moves || []) {
        await c.query(
          "INSERT INTO moves (id, moved_at, moved_by, product_id, from_rack_id, from_level, to_rack_id, to_level, qty, reason, photo_data_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING",
          [String(m.id), iso(m.time) || new Date().toISOString(), String(m.user || ""), String(m.productId), String(m.fromRack), String(m.fromLevel), String(m.toRack), String(m.toLevel), Number(m.qty || 0), String(m.reason || ""), String(m.photo || "") || null],
        );
      }
      for (const [id, v] of Object.entries(st.externalTotals || {})) {
        if (!prodIds.has(id)) continue;
        await c.query("INSERT INTO external_totals (product_id, stock, updated_at) VALUES ($1,$2,$3) ON CONFLICT (product_id) DO UPDATE SET stock = EXCLUDED.stock, updated_at = EXCLUDED.updated_at", [id, Number(v.stock || 0), iso(v.at) || new Date().toISOString()]);
      }
    });
    broadcast({ kind: "sync", action: "import-done", branchId: null, data: {} });
    return sendJson(res, 200, { ok: true });
  }

  throw new HttpError(404, "Rute tidak ditemukan.");
}

// ---------- server HTTP ----------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2" };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      });
      res.end();
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    // Frontend statis (bila FRONTEND_DIR diset, mis. saat deploy VPS).
    if (FRONTEND_DIR && req.method === "GET") {
      let file = path.join(FRONTEND_DIR, url.pathname === "/" ? "index.html" : url.pathname);
      if (!file.startsWith(FRONTEND_DIR)) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(FRONTEND_DIR, "index.html");
      const ext = path.extname(file);
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600",
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Tidak ditemukan." }));
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { ok: false, error: e.message });
    console.error("[apname] error:", e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message || "Kesalahan server." });
  }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/ws") { socket.destroy(); return; }
    const token = url.searchParams.get("token") || "";
    const user = verifyToken(token);
    if (!user) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client = { ws, user };
      wsClients.add(client);
      ws.send(JSON.stringify({ kind: "hello", branchId: null, data: { user: user.name } }));
      ws.on("close", () => wsClients.delete(client));
      ws.on("error", () => wsClients.delete(client));
    });
  } catch {
    socket.destroy();
  }
});

process.on("unhandledRejection", (e) => console.error("[apname] unhandled:", e));

// ---------- boot ----------
seedBranches()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`[apname] server jalan di port ${PORT} (FRONTEND_DIR=${FRONTEND_DIR || "-"}, sync tiap ${SYNC_MIN} menit)`);
    });
    if (SYNC_MIN > 0) {
      setInterval(runScheduledSync, SYNC_MIN * 60 * 1000);
      setTimeout(runScheduledSync, 60 * 1000); // sync pertama 60 detik setelah boot
    }
  })
  .catch((e) => {
    console.error("[apname] gagal boot:", e.message);
    process.exit(1);
  });
