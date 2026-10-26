// Autentikasi backend Apname (menggantikan Supabase Auth + klaim JWT).
// - Hash: scrypt bawaan Node (tanpa dependensi), format
//   "scrypt$<salt hex>$<hash hex>".
// - Token: JWT HMAC-SHA256 buatan sendiri (tanpa dependensi), berlaku 30
//   hari, payload: sub, email, name, username, role, branchId, menus.
// - Secret WAJIB dari APNAME_JWT_SECRET; server menolak boot tanpanya,
//   supaya token tidak pernah ditandatangani secret acak yang hilang saat
//   restart (yang akan menendang semua user keluar).
import crypto from "node:crypto";

const SECRET = process.env.APNAME_JWT_SECRET || "";
if (!SECRET) {
  console.error("[apname] APNAME_JWT_SECRET belum diset (lihat .env).");
  process.exit(1);
}

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const unb64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  try {
    const [, saltHex, hashHex] = String(stored).split("$");
    const hash = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 64);
    return crypto.timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
  } catch {
    return false;
  }
}

export function signToken(user) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      sub: user.id,
      email: user.email,
      name: user.name,
      username: user.username || "",
      role: user.role,
      branchId: user.branch_id || null,
      menus: Array.isArray(user.menus) ? user.menus : null,
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    }),
  );
  const sig = b64url(crypto.createHmac("sha256", SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

export function verifyToken(token) {
  try {
    const [header, payload, sig] = String(token).split(".");
    if (!header || !payload || !sig) return null;
    const expect = b64url(crypto.createHmac("sha256", SECRET).update(`${header}.${payload}`).digest());
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const data = JSON.parse(unb64url(payload).toString("utf8"));
    if (typeof data.exp === "number" && data.exp * 1000 < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

// Bentuk user yang dikirim ke frontend (tanpa password_hash).
export function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    username: u.username || "",
    role: u.role,
    branchId: u.branch_id || null,
    menus: Array.isArray(u.menus) ? u.menus : null,
    claimsMissing: false,
  };
}

// Login boleh pakai username saja: "nisa" -> nisa@apname.com.
// Email lengkap dipakai apa adanya (sama seperti versi Supabase).
export function normalizeLogin(login) {
  const s = String(login || "").trim();
  return s.includes("@") ? s : `${s.toLowerCase()}@apname.com`;
}
