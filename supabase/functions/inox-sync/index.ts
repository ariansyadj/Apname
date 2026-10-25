// Supabase Edge Function: iNOX stock-report sync (PRODUKSI, bukan skeleton).
// Logika ini adalah cerminan server lokal `server/inox-sync-server.mjs`
// yang sudah terbukti jalan di PC Ucok (sync 2544 baris, 2026-10-26):
// login Laravel (CSRF + cookie sesi, TANPA mengikuti redirect POST login,
// karena redirect ke GET /login menghasilkan 419), feed DataTables
// server-side ke halaman yang sama, paging sampai terkumpul == recordsTotal,
// angka dari data-orig-value, dan VARIAN LENGKAP template + nilai.
//
// Temuan kunci (browser read-only 2026-10-26, inox.my.id):
// di iNOX TIDAK ADA field "grade" terpisah — grade ADALAH nilai variasi
// itu sendiri. Template = product_variation ("LCD", "BATT", "BG/HS2",
// "DUMMY"), nilai = variation_name ("JK", "BPE Black", "GOLD", "DUMMY").
// Nama lengkap selalu "template - nilai" ("LCD - JK"), dan kolom Varian
// di Laporan Stok menampilkannya "LCD-JK". Server lama yang hanya memakai
// product_variation menghasilkan varian template saja ("LCD") — itulah
// akar masalahnya. Fungsi ini menggabungkan keduanya dalam SATU tarikan
// feed, tanpa panggilan per produk dan tanpa import Excel.
//
// ATURAN TULIS (sama seperti import lokal, jangan dilanggar):
// - Produk BARU hanya masuk sebagai master, stok per rak/level TIDAK
//   disentuh — stok rak/level hanya berubah lewat opname yang dikunci.
// - Produk lama hanya diperbarui field master + total eksternal.
// - TIDAK ADA yang ditulis balik ke iNOX. Fungsi ini hanya membaca.
// - Stok per rak/level (tabel stock_by_rack) TIDAK PERNAH ditulis di sini.
//
// Kredensial HANYA dari secrets Edge Function (dashboard Supabase):
// INOX_USERNAME, INOX_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Jangan pernah menaruhnya di kode frontend, di file ini, atau di git.
// Frontend TIDAK memanggil fungsi ini langsung di versi ini — pemanggilan
// dari aplikasi adalah fase migrasi data berikutnya (lihat DEPLOYMENT.md).
// Sampai saat itu, fungsi ini dipanggil manual / terjadwal dari Supabase.

const BASE = "https://inox.my.id";
const LOC_MAP: Record<string, number> = { KWSN: 6, MDC: 1, SDNKG: 7, LLF: 8 };
const BRANCH_BY_LOC: Record<number, string> = { 6: "KWSN", 1: "MDC", 7: "SDNKG", 8: "LLF" };

function stripHtml(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
function parseNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const str = String(v);
  const orig = str.match(/data-orig-value=["']([^"']+)["']/);
  const raw = orig ? orig[1] : stripHtml(str);
  const cleaned = raw.replace(/[^0-9\-.,]/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}
function combineVariation(template: string, value: string): string {
  if (!template) return value || "";
  if (!value || value === template) return template;
  if (value.toUpperCase().startsWith(template.toUpperCase() + "-")) return value;
  if (value.toUpperCase().startsWith(template.toUpperCase() + " - ")) {
    return template + "-" + value.slice(template.length + 3).trim();
  }
  return template + "-" + value;
}

type ParsedRow = {
  sku: string; product: string; variation: string; category: string;
  location: string; unit_price: number; stock: number; stock_price: number;
  stock_value: number; potential_profit: number; total_sold: number;
  total_transfered: number; total_adjusted: number;
  product_id: number | null; variation_id: number | null; location_id: number | null;
};

function parseRow(row: unknown): ParsedRow | null {
  if (Array.isArray(row)) {
    const locName = stripHtml(row[5]).toUpperCase();
    let location_id: number | null = null;
    for (const [k, v] of Object.entries(LOC_MAP)) {
      if (locName.includes(k)) { location_id = v; break; }
    }
    const actionHtml = typeof row[0] === "string" ? row[0] : "";
    const pidMatch = actionHtml.match(/product_id[^0-9]{0,5}(\d+)/i) || actionHtml.match(/\/products\/(\d+)/i);
    const vidMatch = actionHtml.match(/variation_id[^0-9]{0,5}(\d+)/i) || actionHtml.match(/\/variations\/(\d+)/i);
    return {
      sku: stripHtml(row[1]), product: stripHtml(row[2]), variation: stripHtml(row[3]),
      category: stripHtml(row[4]), location: stripHtml(row[5]),
      unit_price: parseNum(row[6]), stock: parseNum(row[7]), stock_price: parseNum(row[8]),
      stock_value: parseNum(row[9]), potential_profit: parseNum(row[10]),
      total_sold: parseNum(row[11]), total_transfered: parseNum(row[12]),
      total_adjusted: parseNum(row[13]),
      product_id: pidMatch ? Number(pidMatch[1]) : null,
      variation_id: vidMatch ? Number(vidMatch[1]) : null,
      location_id,
    };
  }
  if (row && typeof row === "object") {
    const r = row as Record<string, unknown>;
    const template = stripHtml(r.product_variation || "");
    const value = stripHtml(r.variation_name || "") || stripHtml(r.variation || "");
    return {
      sku: stripHtml(r.sku), product: stripHtml(r.product),
      variation: combineVariation(template, value),
      category: stripHtml(r.category_name ?? r.category ?? ""),
      location: stripHtml(r.location_name ?? r.location ?? ""),
      unit_price: parseNum(r.unit_price),
      stock: parseNum(r.stock ?? r.current_stock),
      stock_price: parseNum(r.total_stock_price ?? r.stock_price),
      stock_value: parseNum(r.stock_value_by_sale_price),
      potential_profit: parseNum(r.potential_profit),
      total_sold: parseNum(r.total_sold),
      total_transfered: parseNum(r.total_transfered),
      total_adjusted: parseNum(r.total_adjusted),
      product_id: r.product_id !== undefined && r.product_id !== null ? Number(r.product_id) : null,
      variation_id: r.variation_id !== undefined && r.variation_id !== null ? Number(r.variation_id) : null,
      location_id: r.location_id !== undefined && r.location_id !== null ? Number(r.location_id) : null,
    };
  }
  return null;
}

function extractLoginForm(html: string) {
  const formMatch = html.match(/<form[^>]*>/i);
  const actionMatch = html.match(/<form[^>]*action=["']([^"']+)["']/i);
  const action = actionMatch ? actionMatch[1] : "/login";
  let token: string | null = null;
  let m = html.match(/<input[^>]*name=["']_token["'][^>]*value=["']([^"']+)["']/i);
  if (m) token = m[1];
  if (!token) {
    m = html.match(/<input[^>]*value=["']([^"']+)["'][^>]*name=["']_token["']/i);
    if (m) token = m[1];
  }
  const inputNames = [...html.matchAll(/<input[^>]*name=["']([^"']+)["']/gi)].map((x) => x[1]);
  const passwordInputs = [...html.matchAll(/<input[^>]*type=["']password["'][^>]*name=["']([^"']+)["']/gi)].map((x) => x[1]);
  const passwordField = passwordInputs[0] || "password";
  let usernameField: string | null = null;
  for (const cand of ["username", "email", "name", "user"]) {
    if (inputNames.includes(cand)) { usernameField = cand; break; }
  }
  if (!usernameField) {
    usernameField = inputNames.find((n) => !["_token", "_method", "password", passwordField, "remember"].includes(n)) || "username";
  }
  return { hasForm: !!formMatch, action, token, usernameField, passwordField };
}

function cookiesToHeader(setCookie: string[]): string {
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}
function getSetCookie(res: Response): string[] {
  const fn = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof fn === "function") return fn.call(res.headers);
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

async function loginSession(username: string, password: string): Promise<string> {
  const loginPage = await fetch(`${BASE}/login`, { headers: { Accept: "text/html,application/xhtml+xml" } });
  const html = await loginPage.text();
  if (/cloudflare|cf-chl/i.test(html.slice(0, 2000))) {
    throw new Error("Halaman login diblokir Cloudflare (challenge). Coba lagi nanti.");
  }
  const form = extractLoginForm(html);
  if (!form.hasForm || !html.toLowerCase().includes("password")) {
    throw new Error(`Struktur halaman login tidak dikenali (panjang HTML ${html.length}). Kemungkinan halaman berubah atau diblokir.`);
  }
  const body = new URLSearchParams();
  if (form.token) body.set("_token", form.token);
  body.set(form.usernameField, username);
  body.set(form.passwordField, password);
  const loginUrl = new URL(form.action, `${BASE}/login`).toString();
  // PENTING: jangan ikuti redirect. POST login yang diikuti ke GET /login
  // menghasilkan 419 "Page Expired" — keputusan dibaca dari header 302.
  const postRes = await fetch(loginUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html,application/xhtml+xml",
      Referer: `${BASE}/login`,
      Cookie: cookiesToHeader(getSetCookie(loginPage)),
    },
    body: body.toString(),
    redirect: "manual",
  });
  const location = postRes.headers.get("location") || "";
  if (location && new URL(location, BASE).pathname === "/login") {
    throw new Error("Login ditolak iNOX (username/password salah, atau akun terkunci).");
  }
  if (postRes.status === 419) {
    throw new Error("Token CSRF kedaluwarsa (419). Coba lagi — token baru diambil setiap kali.");
  }
  const postHtml = await postRes.text();
  const stillLogin =
    postHtml.toLowerCase().includes("kata sandi") ||
    (postHtml.toLowerCase().includes("nama pengguna") && postHtml.toLowerCase().includes("password"));
  if (stillLogin) {
    throw new Error("Login ditolak iNOX (username/password salah, atau akun terkunci).");
  }
  return cookiesToHeader(getSetCookie(postRes).length > 0 ? getSetCookie(postRes) : getSetCookie(loginPage));
}

function feedParams({ start, length, draw, search }: { start: number; length: number; draw: number; search: string }) {
  const params = new URLSearchParams();
  params.set("draw", String(draw));
  const columns = [
    "action", "sku", "product", "variation", "category_name", "location_name", "unit_price", "stock",
    "stock_price", "stock_value_by_sale_price", "potential_profit", "total_sold", "total_transfered",
    "total_adjusted", "product_custom_field1", "product_custom_field2", "product_custom_field3", "product_custom_field4",
  ];
  const columnData = [
    "action", "variations.sub_sku", "p.name", "variation", "c.name", "l.name", "variations.sell_price_inc_tax",
    "stock", "stock_price", "stock_value_by_sale_price", "potential_profit", "total_sold", "total_transfered",
    "total_adjusted", "product_custom_field1", "product_custom_field2", "product_custom_field3", "product_custom_field4",
  ];
  columns.forEach((c, i) => {
    params.set(`columns[${i}][data]`, c);
    params.set(`columns[${i}][name]`, columnData[i]);
    params.set(`columns[${i}][searchable]`, i === 0 ? "false" : "true");
    params.set(`columns[${i}][orderable]`, i === 0 ? "false" : "true");
    params.set(`columns[${i}][search][value]`, "");
    params.set(`columns[${i}][search][regex]`, "false");
  });
  params.set("order[0][column]", "2");
  params.set("order[0][dir]", "asc");
  params.set("order[1][column]", "3");
  params.set("order[1][dir]", "asc");
  params.set("order[2][column]", "1");
  params.set("order[2][dir]", "asc");
  params.set("start", String(start));
  params.set("length", String(length));
  params.set("search[value]", search);
  params.set("search[regex]", "false");
  params.set("location_id", "");
  params.set("category_id", "");
  params.set("sub_category_id", "");
  params.set("brand_id", "");
  params.set("unit_id", "");
  params.set("only_mfg_products", "0");
  params.set("_", String(Date.now()));
  return params;
}

async function fetchFeedPage(cookie: string, opts: { start: number; length: number; draw: number; search: string }) {
  const params = feedParams(opts);
  const res = await fetch(`${BASE}/reports/stock-report?${params.toString()}`, {
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${BASE}/reports/stock-report`,
      Cookie: cookie,
    },
  });
  const text = await res.text();
  const t = text.trim();
  if (!t.startsWith("{")) {
    throw new Error("Feed mengembalikan HTML, bukan JSON. Sesi login tidak diterima iNOX.");
  }
  const json = JSON.parse(t) as { data: unknown[]; recordsTotal: number };
  if (!Array.isArray(json.data) || typeof json.recordsTotal !== "number") {
    throw new Error("Struktur feed tidak sesuai (tidak ada data[] / recordsTotal).");
  }
  return { total: json.recordsTotal, rows: json.data.map(parseRow).filter((r): r is ParsedRow => !!r) };
}

async function syncAll(cookie: string) {
  const first = await fetchFeedPage(cookie, { start: 0, length: 100, draw: 1, search: "" });
  if (first.total > first.rows.length && first.total <= 4000) {
    const all = await fetchFeedPage(cookie, { start: 0, length: first.total, draw: 2, search: "" });
    if (all.rows.length === all.total) return { total: all.total, rows: all.rows };
  }
  const total = first.total;
  const all = [...first.rows];
  let start = first.rows.length;
  let draw = 2;
  while (start < total && draw <= 500) {
    await new Promise((r) => setTimeout(r, 150));
    const page = await fetchFeedPage(cookie, { start, length: 100, draw, search: "" });
    if (page.rows.length === 0) break;
    all.push(...page.rows);
    start += page.rows.length;
    draw += 1;
  }
  if (all.length !== total) {
    throw new Error(`Paging terhenti: terkumpul ${all.length} dari ${total} baris yang dijanjikan feed. Sync dibatalkan — data lama tidak diubah.`);
  }
  return { total, rows: all };
}

// --- Supabase REST (service role, melewati RLS — hanya dipakai fungsi ini) ---
async function sb(sbUrl: string, serviceKey: string, path: string, method: string, body?: unknown) {
  const res = await fetch(`${sbUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal,resolution=merge-duplicates",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase ${method} ${path} gagal (${res.status}): ${txt.slice(0, 300)}`);
  }
  return res;
}
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

Deno.serve(async (req: Request) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "POST only" }), { status: 405, headers: cors });
    }
    const username = Deno.env.get("INOX_USERNAME") || "";
    const password = Deno.env.get("INOX_PASSWORD") || "";
    const sbUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!username || !password) {
      return new Response(JSON.stringify({ ok: false, error: "INOX_USERNAME / INOX_PASSWORD secrets belum diset di dashboard Supabase." }), { status: 500, headers: cors });
    }
    let action = "sync";
    try {
      const body = await req.json() as { action?: string };
      if (body.action === "test") action = "test";
    } catch { /* body kosong = sync */ }

    const cookie = await loginSession(username, password);
    if (action === "test") {
      const first = await fetchFeedPage(cookie, { start: 0, length: 25, draw: 1, search: "" });
      return new Response(JSON.stringify({
        ok: true, action: "test", recordsTotal: first.total, fetched: first.rows.length,
        sample: first.rows.slice(0, 3),
      }), { headers: cors });
    }

    const { total, rows } = await syncAll(cookie);
    if (!sbUrl || !serviceKey) {
      return new Response(JSON.stringify({ ok: false, error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum diset — feed berhasil ditarik tapi tidak ditulis ke Supabase." }), { status: 500, headers: cors });
    }

    // Klasifikasi persis seperti import lokal: tanpa SKU atau lokasi = dilewati.
    const usable = rows.filter((r) => r.sku && r.location_id !== null);
    const skipped = rows.length - usable.length;
    const branchCounts: Record<string, number> = {};
    for (const r of usable) {
      const bid = BRANCH_BY_LOC[r.location_id as number] || `LOC-${r.location_id}`;
      branchCounts[bid] = (branchCounts[bid] || 0) + 1;
    }
    const branchSummary = Object.entries(branchCounts).map(([k, v]) => `${k}: ${v}`).join(", ");
    const lcdVariants = [...new Set(usable.filter((r) => r.variation.toUpperCase().startsWith("LCD-")).map((r) => r.variation))].sort();

    // Cabang dari lokasi yang muncul di feed.
    const branches = [...new Map(usable.map((r) => {
      const bid = BRANCH_BY_LOC[r.location_id as number] || `LOC-${r.location_id}`;
      return [r.location_id, { id: bid, name: r.location || bid, location_id: r.location_id, location_name: r.location || bid }];
    })).values()];
    for (const b of chunk(branches, 100)) {
      await sb(sbUrl, serviceKey, "branches?on_conflict=location_id", "POST", b);
    }

    // Produk yang sudah ada, untuk menghitung added vs updated.
    const existingRes = await fetch(`${sbUrl}/rest/v1/products?select=id&limit=10000`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    const existingIds = new Set<string>((await existingRes.json() as { id: string }[]).map((x) => x.id));
    const products = usable.map((r) => ({
      id: `inox-${r.product_id}-${r.variation_id}-${r.location_id}`,
      sku: r.sku, name: r.product, variant: r.variation, category: r.category || null,
      price: r.unit_price, product_id: r.product_id, variation_id: r.variation_id,
      location_id: r.location_id, location_name: r.location || null, barcode: r.sku,
    }));
    let added = 0;
    for (const pr of products) if (!existingIds.has(pr.id)) added += 1;
    for (const b of chunk(products, 500)) {
      await sb(sbUrl, serviceKey, "products?on_conflict=product_id,variation_id,location_id", "POST", b);
    }
    // Total eksternal — TIDAK PERNAH menyentuh stock_by_rack.
    const totals = usable.map((r) => ({
      product_id: `inox-${r.product_id}-${r.variation_id}-${r.location_id}`,
      stock: r.stock, stock_value: r.stock_value, total_sold: r.total_sold,
      total_transfered: r.total_transfered, total_adjusted: r.total_adjusted,
      updated_at: new Date().toISOString(),
    }));
    for (const b of chunk(totals, 500)) {
      await sb(sbUrl, serviceKey, "external_totals?on_conflict=product_id", "POST", b);
    }
    await sb(sbUrl, serviceKey, "sync_runs", "POST", [{
      records_total: total, fetched: rows.length, added, updated: usable.length - added,
      skipped, branch_summary: branchSummary, status: "ok",
    }]);

    return new Response(JSON.stringify({
      ok: true, action: "sync", recordsTotal: total, fetched: rows.length,
      added, updated: usable.length - added, skipped, branchSummary, lcdVariants,
      syncedAt: new Date().toISOString(),
    }), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: cors });
  }
});
