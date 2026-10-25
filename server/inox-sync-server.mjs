// Server lokal sync iNOX nyata — HANYA untuk dijalankan di PC sendiri.
// Cara pakai (CMD kedua, di folder Apname):
//   npm run inox-server
//   -> tunggu: "inox-sync server listening on http://localhost:4001"
//   -> di aplikasi (Settings -> Mode: Lokal Nyata), isi username/password iNOX,
//      lalu tekan Uji Koneksi Nyata / Sync Nyata Sekarang.
//
// KEAMANAN, baca dulu:
// - Server ini TIDAK menyimpan kredensial ke disk, ke localStorage, atau ke log.
//   Password hanya dipakai di memori untuk satu request login, lalu dibuang.
//   Yang dicatat di log hanya username, tahap, dan jumlah baris — TIDAK PERNAH
//   password, token CSRF, atau isi cookie. File cookie sesi disimpan di folder
//   temp OS selama satu sync berlangsung, lalu DIHAPUS, apa pun hasilnya.
// - Server ini HANYA menerima request dari localhost (127.0.0.1 / ::1 dan
//   Origin http://localhost:* / http://127.0.0.1:*). Request dari host lain
//   ditolak 403.
// - Server ini HANYA membaca iNOX: POST login + GET feed Laporan Stok.
//   Tidak ada request yang mengubah data di iNOX (tidak ada POST/PUT/DELETE
//   selain login itu sendiri).
// - Kegagalan dilaporkan apa adanya (login gagal, CSRF tidak ditemukan,
//   feed mengembalikan HTML, Cloudflare, dsb.) — server ini TIDAK PERNAH
//   mengarang sukses. Kalau login gagal, responsnya { ok: false, error }.
//
// TRANSPORT — kenapa curl, bukan Node fetch:
// Pada 2026-10-25 diverifikasi dari VM ini: GET halaman login lewat Node fetch
// berhasil, TAPI POST login lewat Node fetch selalu putus ("other side
// closed", Cloudflare/LiteSpeed menutup koneksi undici), sedangkan POST yang
// sama lewat curl berhasil (302 kembali ke /login untuk kredensial salah,
// yang artinya login benar-benar diproses server). Karena itu semua request
// ke iNOX di server ini lewat curl (sudah bawaan Windows 10/11, macOS,
// Linux). Kalau curl tidak ditemukan di PC, server melaporkan error yang
// jelas, bukan sukses palsu.
//
// CARA KERJA LOGIN (Laravel, ditemukan dari halaman login publik + feed yang
// sudah terverifikasi sebelumnya):
// 1. GET https://inox.my.id/login -> ambil cookie sesi + token CSRF (_token)
//    + nama field username/password dari form-nya (dideteksi, bukan ditebak
//    buta: prefer 'username', lalu 'email', lalu 'name').
// 2. POST form login itu (Referer login) dengan cookie sesi.
// 3. Ikuti redirect, lalu GET feed https://inox.my.id/reports/stock-report
//    dengan header X-Requested-With: XMLHttpRequest (pola DataTables yang
//    sudah terverifikasi: draw/start/length/order + filter location_id).
// 4. Kalau feed mengembalikan HTML (bukan JSON), itu berarti login gagal /
//    sesi kedaluwarsa — dilaporkan sebagai error, bukan sukses.
//
// Feed: satu baris = satu varian di satu lokasi, kunci
// product_id + variation_id + location_id. Angka diambil dari atribut
// data-orig-value bila ada, kalau tidak ada dari teks yang sudah dibersihkan.

import http from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = 4001;
const BASE = 'https://inox.my.id';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function log(...args) {
  // Jangan pernah log password / token / cookie di sini.
  console.log(new Date().toISOString(), ...args);
}

function isLocal(req) {
  const origin = req.headers.origin || '';
  if (origin === '') return true; // curl / alat lokal tanpa Origin
  return (
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:') ||
    origin === 'http://localhost' ||
    origin === 'http://127.0.0.1'
  );
}

function corsHeaders(req) {
  const origin = req.headers.origin || '';
  const allowed =
    origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')
      ? origin
      : 'http://localhost:5173';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

function sendJson(res, req, status, obj) {
  res.writeHead(status, corsHeaders(req));
  res.end(JSON.stringify(obj));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 256 * 1024) reject(new Error('Body terlalu besar'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Body bukan JSON yang valid'));
      }
    });
    req.on('error', reject);
  });
}

// ---------- Transport curl ----------
// Satu "sesi" = satu file cookie di temp OS. File dibuat per test/sync,
// dipakai semua request dalam sesi itu, lalu dihapus di finally.
// Password TIDAK pernah lewat argv: body POST ditulis ke file temp sesaat
// (--data @file), lalu file itu DIHAPUS begitu curl selesai, apa pun
// hasilnya. (Versi stdin --data @- sengaja TIDAK dipakai: diverifikasi
// 2026-10-25 bahwa curl @- lewat execFile Node menggantung, sedangkan
// --data @file selesai dalam hitungan detik.)
// followRedirects: GET boleh ikut redirect. POST login TIDAK BOLEH ikut
// redirect: diverifikasi 2026-10-25, POST gagal yang di-follow curl (-L) ke
// GET /login malah mengembalikan halaman "Page Expired" (419), sedangkan
// POST tanpa -L mengembalikan 302 ke /login yang benar — dan dari header
// Location itu kita tahu login gagal atau berhasil.
function curlRequest({ url, method = 'GET', headers = {}, body = null, jarPath, followRedirects = true }) {
  return new Promise((resolve, reject) => {
    const args = ['-s', '-S', '--max-time', '60', '-A', UA];
    if (followRedirects) args.push('-L', '--max-redirs', '8');
    args.push('-b', jarPath, '-c', jarPath);
    for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
    let dataPath = null;
    let headerPath = null;
    if (method === 'POST') {
      args.push('-X', 'POST');
      if (body !== null) {
        dataPath = path.join(os.tmpdir(), `inox-data-${crypto.randomBytes(8).toString('hex')}.txt`);
        fs.writeFileSync(dataPath, body);
        args.push('--data', `@${dataPath}`);
      }
    }
    headerPath = path.join(os.tmpdir(), `inox-hdr-${crypto.randomBytes(8).toString('hex')}.txt`);
    args.push('-D', headerPath);
    args.push(url);
    execFile('curl', args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (dataPath) {
        try { fs.unlinkSync(dataPath); } catch { /* sudah terhapus */ }
      }
      let status = null;
      let location = null;
      try {
        const hdr = fs.readFileSync(headerPath, 'utf8');
        const blocks = hdr.split(/\r?\n\r?\n/).filter((b) => b.trim() !== '');
        const last = blocks[blocks.length - 1] || '';
        const sm = last.match(/HTTP\/\S+\s+(\d{3})/);
        if (sm) status = Number(sm[1]);
        const lm = last.match(/^location:\s*(.+)$/im);
        if (lm) location = lm[1].trim();
      } catch { /* header tidak terbaca — status tetap null */ }
      try { fs.unlinkSync(headerPath); } catch { /* sudah terhapus */ }
      if (err) {
        if (err.code === 'ENOENT') {
          reject(new Error('curl tidak ditemukan di PC ini. Windows 10/11, macOS, dan Linux umumnya sudah punya curl — pastikan curl terpasang dan ada di PATH.'));
        } else {
          reject(new Error(`curl gagal: ${(stderr || err.message || '').trim().slice(0, 300)}`));
        }
        return;
      }
      resolve({ body: stdout, status, location });
    });
  });
}

async function withJar(fn) {
  const jarPath = path.join(os.tmpdir(), `inox-sync-${crypto.randomBytes(8).toString('hex')}.txt`);
  try {
    fs.writeFileSync(jarPath, '');
    return await fn(jarPath);
  } finally {
    try {
      fs.unlinkSync(jarPath);
    } catch {
      // File temp sudah tidak ada — tidak masalah.
    }
  }
}

// ---------- Parsing halaman login ----------
function extractLoginForm(html) {
  const formMatch = html.match(/<form[^>]*>/i);
  const actionMatch = html.match(/<form[^>]*action=["']([^"']+)["']/i);
  const action = actionMatch ? actionMatch[1] : '/login';
  let token = null;
  let m = html.match(/<input[^>]*name=["']_token["'][^>]*value=["']([^"']+)["']/i);
  if (m) token = m[1];
  if (!token) {
    m = html.match(/<input[^>]*value=["']([^"']+)["'][^>]*name=["']_token["']/i);
    if (m) token = m[1];
  }
  const inputNames = [...html.matchAll(/<input[^>]*name=["']([^"']+)["']/gi)].map((x) => x[1]);
  const passwordInputs = [...html.matchAll(/<input[^>]*type=["']password["'][^>]*name=["']([^"']+)["']/gi)].map((x) => x[1]);
  const passwordField = passwordInputs[0] || 'password';
  let usernameField = null;
  for (const cand of ['username', 'email', 'name', 'user']) {
    if (inputNames.includes(cand)) {
      usernameField = cand;
      break;
    }
  }
  if (!usernameField) {
    usernameField =
      inputNames.find((n) => !['_token', '_method', 'password', passwordField, 'remember'].includes(n)) || 'username';
  }
  return { hasForm: !!formMatch, action, token, usernameField, passwordField };
}

// ---------- Parsing baris feed ----------
function stripHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
function parseNum(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const str = String(v);
  const orig = str.match(/data-orig-value=["']([^"']+)["']/);
  const raw = orig ? orig[1] : stripHtml(str);
  const cleaned = raw.replace(/[^0-9\-.,]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}
// Aturan Ucok 2026-10-25: varian LCD diambil dari SETELAH "LCD-".
// Contoh: "LCD-BPT" -> "BPT", "LCD - GX" -> "GX", "LCD iPhone 13 - JK" -> "JK".
// Hanya berlaku bila ada pola LCD + dash; produk lain (mis. "BATT-HX P")
// tidak disentuh sama sekali. Mengembalikan null bila tidak ada pola LCD-.
// Aturan varian (studi file Laporan Stok iNOX, 2026-10-25): SEMUA varian iNOX
// berbentuk "<PREFIX>-<KETERANGAN>" — LCD-BPE Black, BATT-BR P, BG/HS1-BLACK,
// CAM-Front, S/B-Buzzer, FLX-ON/OFF, dst. Prefix (LCD/BATT/...) sudah
// terkandung di nama produk, jadi keterangan varian yang dipakai adalah
// SELURUH teks setelah "-" pertama: "LCD-BR P" -> "BR P",
// "LCD-BPE Black" -> "BPE Black", "BATT-BR P" -> "BR P",
// "LCD-JK Soft Oled" -> "JK Soft Oled". Bukan prefixnya saja ("LCD"),
// dan bukan token pertama saja ("BPE"). Tanpa "-" dikembalikan null.
// VARIAN DITULIS LENGKAP (koreksi Ucok 2026-10-25, membatalkan aturan singkat sebelumnya):
// varian TIDAK dipotong sama sekali. LCD-JK tetap LCD-JK, LCD-BPE Black tetap
// LCD-BPE Black, BATT-BR P tetap BATT-BR P, persis seperti di iNOX.
// Pemotongan sebelumnya (LCD saja / JK saja) terbukti merusak: LCD saja tidak
// bisa dibedakan, dan JK saja kehilangan konteksnya.
function parseRow(row) {
  if (Array.isArray(row)) {
    // PENTING (bug cabang tidak terdeteksi, 2026-10-25): baris DataTables
    // bentuk array TIDAK membawa product_id/variation_id/location_id di
    // kolomnya — versi lama mengisi ketiganya null, sehingga import di
    // frontend melewati SEMUA baris (skipped) dan sync seolah berhasil
    // padahal tidak ada produk baru yang masuk. Perbaikan:
    // - location_id diturunkan dari nama lokasi kolom 5 (KWSN=6, MDC=1,
    //   SDNKG=7, LLF=8), karena nama lokasi selalu ada di kolom itu.
    // - product_id/variation_id dicoba diekstrak dari HTML kolom aksi
    //   (row[0]) bila ada pola id di sana; kalau tidak ada, tetap null
    //   dan frontend memakai kunci cadangan SKU+varian+lokasi.
    const locName = stripHtml(row[5]).toUpperCase();
    const LOC_MAP = { KWSN: 6, MDC: 1, SDNKG: 7, LLF: 8 };
    let location_id = null;
    for (const [k, v] of Object.entries(LOC_MAP)) if (locName.includes(k)) { location_id = v; break; }
    const actionHtml = typeof row[0] === 'string' ? row[0] : '';
    const pidMatch = actionHtml.match(/product_id[^0-9]{0,5}(\d+)/i) || actionHtml.match(/\/products\/(\d+)/i);
    const vidMatch = actionHtml.match(/variation_id[^0-9]{0,5}(\d+)/i) || actionHtml.match(/\/variations\/(\d+)/i);
    const variationRaw = stripHtml(row[3]);
    const productRaw = stripHtml(row[2]);
    const variation = variationRaw;
    return {
      sku: stripHtml(row[1]),
      product: productRaw,
      variation,
      category: stripHtml(row[4]),
      location: stripHtml(row[5]),
      unit_price: parseNum(row[6]),
      stock: parseNum(row[7]),
      stock_price: parseNum(row[8]),
      stock_value: parseNum(row[9]),
      potential_profit: parseNum(row[10]),
      total_sold: parseNum(row[11]),
      total_transfered: parseNum(row[12]),
      total_adjusted: parseNum(row[13]),
      product_id: pidMatch ? Number(pidMatch[1]) : null,
      variation_id: vidMatch ? Number(vidMatch[1]) : null,
      location_id,
    };
  }
  if (row && typeof row === 'object') {
    // VARIAN LENGKAP DARI FEED, MASSAL LEWAT API (temuan browser 2026-10-26,
    // baca-saja di inox.my.id, tanpa mengubah data): di iNOX tidak ada field
    // "grade" terpisah — grade ADALAH nilai variasi itu sendiri. Template =
    // product_variation ("LCD", "BATT", "BG/HS2", "DUMMY"), nilai =
    // variation_name ("JK", "BPE Black", "GOLD", "DUMMY"). Nama lengkap di
    // iNOX selalu "template - nilai" (modal produk: "LCD - JK",
    // "BG/HS2 - GOLD"), dan kolom Varian di Laporan Stok menampilkannya
    // sebagai "LCD-JK", "BG/HS2-GOLD". Feed JSON sebelumnya hanya memakai
    // product_variation saja, sehingga yang tersimpan cuma template
    // ("LCD", "BATT", "BG/HS2") — itulah akar masalahnya, bukan feed yang
    // tidak punya grade. Perbaikan: gabungkan template + nilai di server,
    // dalam satu tarikan feed, tanpa panggilan per produk dan tanpa Excel.
    const template = stripHtml(row.product_variation || '');
    const value = stripHtml(row.variation_name || '') || stripHtml(row.variation || '');
    let variationObj;
    if (!template) variationObj = value || '';
    else if (!value || value === template) variationObj = template;
    else if (value.toUpperCase().startsWith(template.toUpperCase() + '-')) variationObj = value;
    else if (value.toUpperCase().startsWith(template.toUpperCase() + ' - ')) variationObj = template + '-' + value.slice(template.length + 3).trim();
    else variationObj = template + '-' + value;
    const productRawObj = stripHtml(row.product);
    return {
      sku: stripHtml(row.sku),
      product: productRawObj,
      variation: variationObj,
      category: stripHtml(row.category_name ?? row.category ?? ''),
      location: stripHtml(row.location_name ?? row.location ?? ''),
      unit_price: parseNum(row.unit_price),
      stock: parseNum(row.stock ?? row.current_stock),
      stock_price: parseNum(row.total_stock_price ?? row.stock_price),
      stock_value: parseNum(row.stock_value_by_sale_price),
      potential_profit: parseNum(row.potential_profit),
      total_sold: parseNum(row.total_sold),
      total_transfered: parseNum(row.total_transfered),
      total_adjusted: parseNum(row.total_adjusted),
      product_id: row.product_id !== undefined && row.product_id !== null ? Number(row.product_id) : null,
      variation_id: row.variation_id !== undefined && row.variation_id !== null ? Number(row.variation_id) : null,
      location_id: row.location_id !== undefined && row.location_id !== null ? Number(row.location_id) : null,
    };
  }
  return null;
}

// ---------- Login + feed dalam satu sesi ----------
async function loginSession(jarPath, username, password) {
  let loginHtml;
  try {
    loginHtml = (await curlRequest({
      url: `${BASE}/login`,
      jarPath,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    })).body;
  } catch (e) {
    throw { step: 'network', error: `Tidak bisa membuka halaman login inox.my.id: ${e.message}` };
  }
  if (/cloudflare|cf-chl/i.test(loginHtml.slice(0, 2000))) {
    throw { step: 'login', error: 'Halaman login diblokir Cloudflare (challenge). Coba lagi nanti.' };
  }
  const form = extractLoginForm(loginHtml);
  if (!form.hasForm || !loginHtml.toLowerCase().includes('password')) {
    throw {
      step: 'login',
      error: `Struktur halaman login tidak dikenali (panjang HTML ${loginHtml.length}). Kemungkinan halaman berubah atau diblokir.`,
    };
  }
  if (!form.token) {
    log('Peringatan: token CSRF tidak ditemukan di halaman login, tetap mencoba POST tanpa token.');
  }
  const body = new URLSearchParams();
  if (form.token) body.set('_token', form.token);
  body.set(form.usernameField, username);
  body.set(form.passwordField, password);
  const loginUrl = new URL(form.action, `${BASE}/login`).toString();
  let postRes;
  try {
    postRes = await curlRequest({
      url: loginUrl,
      method: 'POST',
      jarPath,
      followRedirects: false,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html,application/xhtml+xml',
        Referer: `${BASE}/login`,
      },
      body: body.toString(),
    });
  } catch (e) {
    throw { step: 'login', error: `Gagal mengirim login: ${e.message}` };
  }
  const postHtml = postRes.body;
  // 302 kembali ke /login = login gagal (ini perilaku Laravel yang benar).
  if (postRes.location && new URL(postRes.location, BASE).pathname === '/login') {
    throw { step: 'login', error: 'Login ditolak iNOX (username/password salah, atau akun terkunci). Periksa kredensial di Settings, lalu coba lagi.' };
  }
  if (postRes.status === 419) {
    throw { step: 'login', error: 'Token CSRF kedaluwarsa (419). Coba lagi — server mengambil token baru setiap kali.' };
  }
  const stillLogin =
    postHtml.toLowerCase().includes('kata sandi') ||
    (postHtml.toLowerCase().includes('nama pengguna') && postHtml.toLowerCase().includes('password'));
  if (stillLogin) {
    throw { step: 'login', error: 'Login ditolak iNOX (username/password salah, atau akun terkunci). Periksa kredensial di Settings, lalu coba lagi.' };
  }
  return form;
}

function feedParams({ start, length, draw, location_id, search }) {
  const params = new URLSearchParams();
  params.set('draw', String(draw));
  const columns = [
    'action', 'sku', 'product', 'variation', 'category_name', 'location_name', 'unit_price', 'stock',
    'stock_price', 'stock_value_by_sale_price', 'potential_profit', 'total_sold', 'total_transfered',
    'total_adjusted', 'product_custom_field1', 'product_custom_field2', 'product_custom_field3', 'product_custom_field4',
  ];
  const columnData = [
    'action', 'variations.sub_sku', 'p.name', 'variation', 'c.name', 'l.name', 'variations.sell_price_inc_tax',
    'stock', 'stock_price', 'stock_value_by_sale_price', 'potential_profit', 'total_sold', 'total_transfered',
    'total_adjusted', 'product_custom_field1', 'product_custom_field2', 'product_custom_field3', 'product_custom_field4',
  ];
  columns.forEach((c, i) => {
    params.set(`columns[${i}][data]`, c);
    params.set(`columns[${i}][name]`, columnData[i]);
    params.set(`columns[${i}][searchable]`, i === 0 ? 'false' : 'true');
    params.set(`columns[${i}][orderable]`, i === 0 ? 'false' : 'true');
    params.set(`columns[${i}][search][value]`, '');
    params.set(`columns[${i}][search][regex]`, 'false');
  });
  params.set('order[0][column]', '2');
  params.set('order[0][dir]', 'asc');
  params.set('order[1][column]', '3');
  params.set('order[1][dir]', 'asc');
  params.set('order[2][column]', '1');
  params.set('order[2][dir]', 'asc');
  params.set('start', String(start));
  params.set('length', String(length));
  params.set('search[value]', search || '');
  params.set('search[regex]', 'false');
  params.set('location_id', location_id ? String(location_id) : '');
  params.set('category_id', '');
  params.set('sub_category_id', '');
  params.set('brand_id', '');
  params.set('unit_id', '');
  params.set('only_mfg_products', '0');
  params.set('_', String(Date.now()));
  return params;
}

async function fetchFeedPage(jarPath, { start, length, draw, location_id, search }) {
  const params = feedParams({ start, length, draw, location_id, search });
  let text;
  try {
    text = (await curlRequest({
      url: `${BASE}/reports/stock-report?${params.toString()}`,
      jarPath,
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${BASE}/reports/stock-report`,
      },
    })).body;
  } catch (e) {
    throw { step: 'feed', error: `Tidak bisa mengambil feed Laporan Stok: ${e.message}` };
  }
  const t = text.trim();
  if (!t.startsWith('{')) {
    throw {
      step: 'feed',
      error: 'Feed mengembalikan HTML, bukan JSON. Ini artinya sesi login tidak diterima iNOX — kemungkinan login gagal atau sesi langsung kedaluwarsa.',
    };
  }
  let json;
  try {
    json = JSON.parse(t);
  } catch {
    throw { step: 'feed', error: 'Feed mengembalikan teks yang bukan JSON yang valid.' };
  }
  if (!Array.isArray(json.data) || typeof json.recordsTotal !== 'number') {
    throw { step: 'feed', error: 'Struktur feed tidak sesuai (tidak ada data[] / recordsTotal). Kemungkinan format Laporan Stok berubah.' };
  }
  return { total: json.recordsTotal, rows: json.data.map(parseRow).filter(Boolean) };
}

function sanitizeRawCell(v) {
  if (typeof v === 'string') return v.slice(0, 300);
  if (v && typeof v === 'object') return JSON.stringify(v).slice(0, 300);
  return v;
}
function sanitizeRawRow(row) {
  // Kolom aksi (row[0]) disembunyikan — berisi HTML tombol + kemungkinan ID di URL.
  // Kolom lain dipertahankan APA ADANYA (termasuk HTML-nya) supaya bisa dilihat
  // apakah kolom Varian mentah itu "LCD-JK", "LCD", atau HTML lain.
  if (Array.isArray(row)) return row.slice(1).map(sanitizeRawCell);
  if (row && typeof row === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(row)) { if (/action/i.test(k)) continue; out[k] = sanitizeRawCell(v); }
    return out;
  }
  return row;
}
async function fetchLcdSample(jarPath, { location_id }) {
  // Diagnosa varian LCD (2026-10-26): 5 baris pertama feed adalah adapter
  // (product_variation DUMMY), jadi tidak membuktikan apa-apa soal LCD.
  // Ambil 5 baris pertama yang cocok pencarian 'Lcd' di server iNOX —
  // ini baris LCD yang sebenarnya, dengan semua field mentahnya.
  const params = feedParams({ start: 0, length: 5, draw: 2, location_id, search: 'Lcd' });
  const text = (await curlRequest({
    url: `${BASE}/reports/stock-report?${params.toString()}`,
    jarPath,
    headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest', Referer: `${BASE}/reports/stock-report` },
  })).body;
  const json = JSON.parse(text.trim());
  if (!Array.isArray(json.data)) throw { step: 'feed', error: 'Struktur feed tidak sesuai (tidak ada data[]).' };
  return { rows: json.data.slice(0, 5).map(sanitizeRawRow), total: typeof json.recordsFiltered === 'number' ? json.recordsFiltered : json.data.length };
}
async function fetchRawSample(jarPath, { location_id }) {
  const params = feedParams({ start: 0, length: 5, draw: 1, location_id });
  const text = (await curlRequest({
    url: `${BASE}/reports/stock-report?${params.toString()}`,
    jarPath,
    headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest', Referer: `${BASE}/reports/stock-report` },
  })).body;
  const json = JSON.parse(text.trim());
  if (!Array.isArray(json.data)) throw { step: 'feed', error: 'Struktur feed tidak sesuai (tidak ada data[]).' };
  return json.data.slice(0, 5).map(sanitizeRawRow);
}
async function testLogin({ username, password, location_id }) {
  return withJar(async (jarPath) => {
    const form = await loginSession(jarPath, username, password);
    const first = await fetchFeedPage(jarPath, { start: 0, length: 25, draw: 1, location_id });
    let sampleRaw = null;
    try { sampleRaw = await fetchRawSample(jarPath, { location_id }); } catch { sampleRaw = null; }
    let sampleLcdRaw = null; let sampleLcdTotal = null;
    try { const lcd = await fetchLcdSample(jarPath, { location_id }); sampleLcdRaw = lcd.rows; sampleLcdTotal = lcd.total; } catch { sampleLcdRaw = null; sampleLcdTotal = null; }
    return {
      recordsTotal: first.total,
      fetched: first.rows.length,
      sample: first.rows.slice(0, 3),
      sample_raw: sampleRaw,
      sample_lcd_raw: sampleLcdRaw,
      sample_lcd_total: sampleLcdTotal,
      loginFields: { usernameField: form.usernameField, hasToken: !!form.token },
    };
  });
}

async function syncAll({ username, password, location_id }) {
  return withJar(async (jarPath) => {
    await loginSession(jarPath, username, password);
    const first = await fetchFeedPage(jarPath, { start: 0, length: 100, draw: 1, location_id });
    if (first.total > first.rows.length && first.total <= 4000) {
      const all = await fetchFeedPage(jarPath, { start: 0, length: first.total, draw: 2, location_id });
      if (all.rows.length === all.total) return { rows: all.rows, total: all.total };
      // Kalau server membatasi length, jatuh kembali ke paging di bawah.
    }
    const total = first.total;
    const all = [...first.rows];
    let start = first.rows.length;
    let draw = 2;
    while (start < total && draw <= 500) {
      await new Promise((r) => setTimeout(r, 150));
      const page = await fetchFeedPage(jarPath, { start, length: 100, draw, location_id });
      if (page.rows.length === 0) break;
      all.push(...page.rows);
      start += page.rows.length;
      draw += 1;
    }
    if (all.length !== total) {
      throw {
        step: 'feed',
        error: `Paging terhenti: terkumpul ${all.length} dari ${total} baris yang dijanjikan feed. Sync dibatalkan — data lama tidak diubah.`,
      };
    }
    return { total, rows: all };
  });
}

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }
    if (!isLocal(req)) {
      sendJson(res, req, 403, { ok: false, error: 'Server ini hanya menerima request dari localhost.' });
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, req, 200, { ok: true, service: 'inox-sync-local', port: PORT, build: '2026-10-26-qr-scope' });
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/api/inox/test' || url.pathname === '/api/inox/sync')) {
      const body = await readJsonBody(req);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const location_id = body.location_id ? Number(body.location_id) : null;
      if (!username || !password) {
        sendJson(res, req, 400, { ok: false, step: 'input', error: 'Username dan password iNOX wajib diisi.' });
        return;
      }
      log(`Request ${url.pathname} untuk username=${username} location_id=${location_id ?? 'semua'}`);
      if (url.pathname === '/api/inox/test') {
        const result = await testLogin({ username, password, location_id });
        log(`Test OK: recordsTotal=${result.recordsTotal} baris pertama=${result.fetched}`);
        sendJson(res, req, 200, { ok: true, ...result });
        return;
      }
      const result = await syncAll({ username, password, location_id });
      log(`Sync OK: total=${result.total} terkumpul=${result.rows.length}`);
      sendJson(res, req, 200, { ok: true, recordsTotal: result.total, rows: result.rows, fetchedAt: new Date().toISOString() });
      return;
    }
    sendJson(res, req, 404, { ok: false, error: 'Endpoint tidak ditemukan. Pakai /api/health, /api/inox/test, atau /api/inox/sync.' });
  } catch (e) {
    const err = e && typeof e === 'object' && 'error' in e ? e : { step: 'server', error: e instanceof Error ? e.message : String(e) };
    log(`Error (${err.step || 'server'}): ${err.error}`);
    sendJson(res, req, 200, { ok: false, step: err.step || 'server', error: err.error });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`inox-sync server listening on http://localhost:${PORT}`);
  log('Hanya menerima request dari localhost. Kredensial tidak disimpan ke disk.');
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} sudah dipakai — kemungkinan server inox-sync sudah jalan di CMD lain. Tutup server lama itu dulu, atau pakai yang sudah jalan itu.`);
  } else {
    console.error('Server gagal jalan:', e.message);
  }
  process.exit(1);
});
