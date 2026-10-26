// Sync iNOX untuk backend VPS — port dari Edge Function inox-sync.
// Logika feed DIPERTAHANKAN PERSIS (login Laravel tanpa ikut redirect,
// feed DataTables server-side, angka dari data-orig-value, varian lengkap
// template-nilai). Yang berubah hanya tujuan tulis: PostgreSQL lokal
// lewat `pg`, bukan Supabase REST.
// ATURAN TULIS (jangan dilanggar): produk baru hanya jadi master, stok
// rak/level TIDAK PERNAH disentuh di sini, tidak ada yang ditulis balik
// ke iNOX.

const BASE = "https://inox.my.id";
const LOC_MAP = { KWSN: 6, MDC: 1, SDNKG: 7, LLF: 8 };
const BRANCH_BY_LOC = { 6: "KWSN", 1: "MDC", 7: "SDNKG", 8: "LLF" };

function stripHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
function parseNum(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const str = String(v);
  const orig = str.match(/data-orig-value=["']([^"']+)["']/);
  const raw = orig ? orig[1] : stripHtml(str);
  const cleaned = raw.replace(/[^0-9\-.,]/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}
function combineVariation(template, value) {
  if (!template) return value || "";
  if (!value || value === template) return template;
  if (value.toUpperCase().startsWith(template.toUpperCase() + "-")) return value;
  if (value.toUpperCase().startsWith(template.toUpperCase() + " - ")) {
    return template + "-" + value.slice(template.length + 3).trim();
  }
  return template + "-" + value;
}

function parseRow(row) {
  if (Array.isArray(row)) {
    const locName = stripHtml(row[5]).toUpperCase();
    let location_id = null;
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
    const r = row;
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

function extractLoginForm(html) {
  const formMatch = html.match(/<form[^>]*>/i);
  const actionMatch = html.match(/<form[^>]*action=["']([^"']+)["']/i);
  const action = actionMatch ? actionMatch[1] : "/login";
  let token = null;
  let m = html.match(/<input[^>]*name=["']_token["'][^>]*value=["']([^"']+)["']/i);
  if (m) token = m[1];
  if (!token) {
    m = html.match(/<input[^>]*value=["']([^"']+)["'][^>]*name=["']_token["']/i);
    if (m) token = m[1];
  }
  const inputNames = [...html.matchAll(/<input[^>]*name=["']([^"']+)["']/gi)].map((x) => x[1]);
  const passwordInputs = [...html.matchAll(/<input[^>]*type=["']password["'][^>]*name=["']([^"']+)["']/gi)].map((x) => x[1]);
  const passwordField = passwordInputs[0] || "password";
  let usernameField = null;
  for (const cand of ["username", "email", "name", "user"]) {
    if (inputNames.includes(cand)) { usernameField = cand; break; }
  }
  if (!usernameField) {
    usernameField = inputNames.find((n) => !["_token", "_method", "password", passwordField, "remember"].includes(n)) || "username";
  }
  return { hasForm: !!formMatch, action, token, usernameField, passwordField };
}

function cookiesToHeader(setCookie) {
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}
function getSetCookie(res) {
  // Node 24 (undici): getSetCookie() tersedia; fallback ke header tunggal.
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

async function loginSession(username, password) {
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
  // PENTING: jangan ikuti redirect (redirect ke GET /login = 419).
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

function feedParams({ start, length, draw, search }) {
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

async function fetchFeedPage(cookie, opts) {
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
  const json = JSON.parse(t);
  if (!Array.isArray(json.data) || typeof json.recordsTotal !== "number") {
    throw new Error("Struktur feed tidak sesuai (tidak ada data[] / recordsTotal).");
  }
  return { total: json.recordsTotal, rows: json.data.map(parseRow).filter(Boolean) };
}

async function syncAll(cookie) {
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

// Tarik feed saja (untuk action "test"): tidak menulis apa pun ke DB.
export async function inoxTest(username, password) {
  const cookie = await loginSession(username, password);
  const first = await fetchFeedPage(cookie, { start: 0, length: 25, draw: 1, search: "" });
  return { recordsTotal: first.total, fetched: first.rows.length, sample: first.rows.slice(0, 3) };
}

// Sync penuh: tarik feed, tulis branches/products/external_totals ke pg,
// catat sync_runs. TIDAK PERNAH menyentuh stock_by_rack / unplaced_stock.
export async function inoxSync(pool, username, password) {
  const cookie = await loginSession(username, password);
  const { total, rows } = await syncAll(cookie);

  const usable = rows.filter((r) => r.sku && r.location_id !== null);
  const skipped = rows.length - usable.length;
  const branchCounts = {};
  for (const r of usable) {
    const bid = BRANCH_BY_LOC[r.location_id] || `LOC-${r.location_id}`;
    branchCounts[bid] = (branchCounts[bid] || 0) + 1;
  }
  const branchSummary = Object.entries(branchCounts).map(([k, v]) => `${k}: ${v}`).join(", ");
  const lcdVariants = [...new Set(usable.filter((r) => r.variation.toUpperCase().startsWith("LCD-")).map((r) => r.variation))].sort();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const branches = [...new Map(usable.map((r) => {
      const bid = BRANCH_BY_LOC[r.location_id] || `LOC-${r.location_id}`;
      return [r.location_id, { id: bid, name: r.location || bid, location_id: r.location_id, location_name: r.location || bid }];
    })).values()];
    for (const b of branches) {
      await client.query(
        "INSERT INTO branches (id, name, location_id, location_name) VALUES ($1, $2, $3, $4) ON CONFLICT (location_id) DO UPDATE SET name = EXCLUDED.name, location_name = EXCLUDED.location_name",
        [b.id, b.name, b.location_id, b.location_name],
      );
    }
    const existing = await client.query("SELECT id FROM products");
    const existingIds = new Set(existing.rows.map((x) => x.id));
    let added = 0;
    const products = usable.map((r) => ({
      id: `inox-${r.product_id}-${r.variation_id}-${r.location_id}`,
      sku: r.sku, name: r.product, variant: r.variation, category: r.category || null,
      price: r.unit_price, product_id: r.product_id, variation_id: r.variation_id,
      location_id: r.location_id, location_name: r.location || null, barcode: r.sku,
    }));
    for (const pr of products) if (!existingIds.has(pr.id)) added += 1;
    for (const pr of products) {
      await client.query(
        `INSERT INTO products (id, sku, name, variant, category, price, product_id, variation_id, location_id, location_name, barcode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (product_id, variation_id, location_id) DO UPDATE SET
           sku = EXCLUDED.sku, name = EXCLUDED.name, variant = EXCLUDED.variant,
           category = EXCLUDED.category, price = EXCLUDED.price,
           location_name = EXCLUDED.location_name, barcode = EXCLUDED.barcode`,
        [pr.id, pr.sku, pr.name, pr.variant, pr.category, pr.price, pr.product_id, pr.variation_id, pr.location_id, pr.location_name, pr.barcode],
      );
    }
    for (const r of usable) {
      const pid = `inox-${r.product_id}-${r.variation_id}-${r.location_id}`;
      await client.query(
        `INSERT INTO external_totals (product_id, stock, stock_value, total_sold, total_transfered, total_adjusted, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (product_id) DO UPDATE SET stock = EXCLUDED.stock, stock_value = EXCLUDED.stock_value,
           total_sold = EXCLUDED.total_sold, total_transfered = EXCLUDED.total_transfered,
           total_adjusted = EXCLUDED.total_adjusted, updated_at = now()`,
        [pid, r.stock, r.stock_value, r.total_sold, r.total_transfered, r.total_adjusted],
      );
    }
    await client.query(
      "INSERT INTO sync_runs (records_total, fetched, added, updated, skipped, branch_summary, status) VALUES ($1, $2, $3, $4, $5, $6, 'ok')",
      [total, rows.length, added, usable.length - added, skipped, branchSummary],
    );
    await client.query("COMMIT");
    return { recordsTotal: total, fetched: rows.length, added, updated: usable.length - added, skipped, branchSummary, lcdVariants, syncedAt: new Date().toISOString() };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
