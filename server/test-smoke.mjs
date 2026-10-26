// Smoke test backend Apname (lokal). Jalankan saat server tes hidup:
//   node test-smoke.mjs
// Menguji: login, otorisasi cabang, CRUD sesi/scan/rak/produk/stok,
// guard admin, WebSocket broadcast, import. Keluar 1 bila ada yang gagal.
import WebSocket from "ws";

const BASE = process.env.TEST_BASE || "http://localhost:4000";
let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures += 1;
}
async function call(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Login super (dibuat sebelum server jalan) + tanpa token ditolak
const loginSuper = await call("POST", "/api/auth/login", null, { emailOrUsername: "super@apname.com", password: "super123" });
check("login super", loginSuper.status === 200 && !!loginSuper.data.token, JSON.stringify(loginSuper.data).slice(0, 120));
const superTok = loginSuper.data.token;
const noAuth = await call("GET", "/api/state", null);
check("state tanpa token -> 401", noAuth.status === 401);
const badLogin = await call("POST", "/api/auth/login", null, { emailOrUsername: "super@apname.com", password: "salah" });
check("login password salah -> 401", badLogin.status === 401);

// 2. Admin: super buat karyawan KWSN; karyawan login; karyawan tidak boleh buat akun
const mkKaryawan = await call("POST", "/api/admin/users", superTok, { email: "nisa@apname.com", password: "nisa123", name: "Nisa", username: "nisa", role: "karyawan", branchId: "KWSN" });
check("super buat akun karyawan", mkKaryawan.status === 200, JSON.stringify(mkKaryawan.data).slice(0, 120));
const karyawanId = mkKaryawan.data.id;
const loginKar = await call("POST", "/api/auth/login", null, { emailOrUsername: "nisa", password: "nisa123" });
check("login karyawan via username", loginKar.status === 200 && loginKar.data.user.branchId === "KWSN", JSON.stringify(loginKar.data.user || {}));
const karTok = loginKar.data.token;
const karMkUser = await call("POST", "/api/admin/users", karTok, { email: "x@apname.com", password: "x123456", name: "X", role: "karyawan", branchId: "KWSN" });
check("karyawan buat akun -> 403", karMkUser.status === 403);
const delSelf = await call("DELETE", `/api/admin/users/${loginSuper.data.user.id}`, superTok);
check("super hapus akun sendiri -> 403", delSelf.status === 403);

// 3. Rak + produk (super)
const racks = await call("PUT", "/api/racks", superTok, { racks: [
  { id: "KWSN-A", branchId: "KWSN", name: "Rak A", type: "normal", levels: ["Level 1", "Level 2"], x: 20, y: 20, w: 160, h: 90, rot: 0 },
  { id: "MDC-A", branchId: "MDC", name: "Rak A", type: "normal", levels: ["Level 1"], x: 20, y: 20, w: 160, h: 90, rot: 0 },
] });
check("super simpan rak", racks.status === 200);
const prods = await call("PUT", "/api/products", superTok, { products: [
  { id: "inox-1040-1756-6", sku: "8990124000135", name: "Battery iPhone 14 Pro", variant: "BATT-HX P", category: "Battery", price: 150000, product_id: 1040, variation_id: 1756, location_id: 6, barcode: "8990124000135", location_name: "KWSN" },
  { id: "inox-1040-1756-1", sku: "8990124000135", name: "Battery iPhone 14 Pro", variant: "BATT-HX P", category: "Battery", price: 150000, product_id: 1040, variation_id: 1756, location_id: 1, barcode: "8990124000135", location_name: "MDC" },
] });
check("super simpan produk", prods.status === 200, JSON.stringify(prods.data));

// 4. Sesi KWSN (super) + scan karyawan (cabang sama OK, cabang lain 403)
const sess = await call("PUT", "/api/sessions/OP-TEST", superTok, {
  id: "OP-TEST", title: "Tes", branchId: "KWSN", racks: ["KWSN-A"], status: "Berjalan",
  createdBy: "Super Admin", createdAt: Date.now(), lockedAt: null, snapshot: {}, adjustmentStatus: "Menunggu", externalAt: null,
});
check("super buat sesi KWSN", sess.status === 200);
const sessMdc = await call("PUT", "/api/sessions/OP-MDC", superTok, {
  id: "OP-MDC", title: "Tes MDC", branchId: "MDC", racks: ["MDC-A"], status: "Berjalan",
  createdBy: "Super Admin", createdAt: Date.now(), lockedAt: null, snapshot: {}, adjustmentStatus: "Menunggu", externalAt: null,
});
check("super buat sesi MDC", sessMdc.status === 200);
const scan1 = await call("POST", "/api/sessions/OP-TEST/scans", karTok, { id: "sc-1", time: Date.now(), user: "Nisa", productId: "inox-1040-1756-6", rackId: "KWSN-A", level: "Level 1", qty: 3, mode: "scan", barcode: "8990124000135" });
check("karyawan scan di sesi cabangnya", scan1.status === 200, JSON.stringify(scan1.data));
const scanX = await call("POST", "/api/sessions/OP-MDC/scans", karTok, { id: "sc-x", time: Date.now(), user: "Nisa", productId: "inox-1040-1756-1", rackId: "MDC-A", level: "Level 1", qty: 1, mode: "scan", barcode: "8990124000135" });
check("karyawan scan di sesi cabang lain -> 403", scanX.status === 403);

// 5. State karyawan hanya cabangnya; sesi super memuat scan
const stateKar = await call("GET", "/api/state", karTok);
check("state karyawan: rak hanya KWSN", stateKar.status === 200 && stateKar.data.state.racks.every((r) => r.branchId === "KWSN") && stateKar.data.state.racks.length === 1, `racks=${stateKar.data.state.racks.length}`);
check("state karyawan: sesi hanya KWSN", stateKar.data.state.sessions.every((s) => s.branchId === "KWSN"));
const sessGet = await call("GET", "/api/sessions/OP-TEST", superTok);
check("GET sesi memuat 1 scan", sessGet.status === 200 && sessGet.data.session.scans.length === 1, `scans=${sessGet.data.session?.scans?.length}`);

// 6. WebSocket: karyawan terima event scan + stock dari super
const events = [];
const ws = new WebSocket(`ws://localhost:4000/ws?token=${encodeURIComponent(karTok)}`);
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
ws.on("message", (d) => { try { events.push(JSON.parse(String(d))); } catch {} });
await wait(300);
await call("POST", "/api/sessions/OP-TEST/scans", superTok, { id: "sc-2", time: Date.now(), user: "Super Admin", productId: "inox-1040-1756-6", rackId: "KWSN-A", level: "Level 2", qty: 2, mode: "scan", barcode: "8990124000135" });
await call("PUT", "/api/stock", superTok, { stock: { "inox-1040-1756-6|KWSN-A|Level 1": 3, "inox-1040-1756-6|KWSN-A|Level 2": 2 } });
await wait(500);
const gotScan = events.some((e) => e.kind === "scan" && e.data?.id === "sc-2");
const gotStock = events.some((e) => e.kind === "stock" && e.data?.key === "inox-1040-1756-6|KWSN-A|Level 1");
check("WS terima event scan", gotScan, `events=${events.map((e) => e.kind).join(",")}`);
check("WS terima event stock", gotStock);
const delScan = await call("DELETE", "/api/sessions/OP-TEST/scans/sc-2", superTok);
check("hapus scan", delScan.status === 200);
await wait(300);
const gotDel = events.some((e) => e.kind === "scan" && e.action === "delete" && e.data?.id === "sc-2");
check("WS terima event hapus scan", gotDel);
ws.close();

// 7. Mutasi + pindah + total eksternal
const mut = await call("POST", "/api/sessions/OP-TEST/mutations", karTok, { id: "mu-1", time: Date.now(), user: "Nisa", productId: "inox-1040-1756-6", kind: "Penjualan", direction: "Keluar", qty: 1, rackId: "KWSN-A", reference: "NOTA-1", note: "" });
check("karyawan catat mutasi", mut.status === 200);
const mv = await call("PUT", "/api/moves", karTok, { moves: [{ id: "mv-1", time: Date.now(), user: "Nisa", productId: "inox-1040-1756-6", fromRack: "KWSN-A", fromLevel: "Level 1", toRack: "KWSN-A", toLevel: "Level 2", qty: 1, reason: "Penataan Ulang", photo: "" }] });
check("karyawan catat pindah", mv.status === 200);
const ext = await call("PUT", "/api/external-totals", superTok, { externalTotals: { "inox-1040-1756-6": { stock: 9, at: Date.now() } } });
check("super simpan total eksternal", ext.status === 200);

// 8. Sync tanpa kredensial -> error rapi (bukan crash); import butuh confirm
const syncTest = await call("POST", "/api/sync/test", superTok, {});
check("sync test tanpa kredensial -> error rapi", syncTest.status === 500 && /INOX/.test(syncTest.data.error || ""));
const impNoConfirm = await call("POST", "/api/admin/import", superTok, { state: {} });
check("import tanpa confirm -> 400", impNoConfirm.status === 400);
const imp = await call("POST", "/api/admin/import", superTok, { confirm: true, state: { branches: [], racks: [], products: [], stock: {}, sessions: [], moves: [], externalTotals: {} } });
check("import kosong dengan confirm -> 200", imp.status === 200);

// 9. Hapus sesi + daftar akun
const delSess = await call("DELETE", "/api/sessions/OP-MDC", superTok);
check("super hapus sesi MDC", delSess.status === 200);
const users = await call("GET", "/api/admin/users", superTok);
check("daftar akun (tanpa hash)", users.status === 200 && users.data.users.length === 2 && !("password_hash" in (users.data.users[0] || {})), `n=${users.data.users?.length}`);
const delKar = await call("DELETE", `/api/admin/users/${karyawanId}`, superTok);
check("super hapus akun karyawan", delKar.status === 200);

console.log(failures === 0 ? "\nSEMUA TES LOLOS" : `\n${failures} TES GAGAL`);
process.exit(failures === 0 ? 0 : 1);
