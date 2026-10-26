// Buat akun Super Admin pertama di backend VPS.
// Pemakaian (di server, sebagai root): node scripts/create-super.mjs
// Script bertanya email + nama + password secara interaktif; password
// dibaca tanpa echo dan TIDAK PERNAH dicetak / ditulis ke file.
// Akun yang sudah ada (email sama) tidak ditimpa — script menolak.
import readline from "node:readline";
import { pool } from "../src/db.js";
import { hashPassword } from "../src/auth.js";

function askHidden(rl, q) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write(q);
    let out = "";
    const onData = (c) => {
      const s = String(c);
      if (s === "\r" || s === "\n" || s === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(out);
      } else if (s === "\u0003") {
        process.exit(1);
      } else if (s === "\u007f") {
        out = out.slice(0, -1);
      } else {
        out += s;
      }
    };
    stdin.on("data", onData);
  });
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

const emailRaw = (await ask("Email super admin: ")).trim();
const email = emailRaw.includes("@") ? emailRaw : `${emailRaw.toLowerCase()}@apname.com`;
const name = (await ask("Nama: ")).trim() || email;
const usernameRaw = (await ask("Username (kosongkan = dari email): ")).trim();
rl.close();
const password = await askHidden(rl, "Password (minimal 6 karakter, tidak tampil saat diketik): ");
const password2 = await askHidden(rl, "Ulangi password: ");
if (password.length < 6) { console.error("Password minimal 6 karakter."); process.exit(1); }
if (password !== password2) { console.error("Password tidak sama."); process.exit(1); }

const ex = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
if (ex.rows[0]) { console.error(`Akun ${email} sudah ada — tidak dibuat ulang.`); process.exit(1); }
const id = `u-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
await pool.query(
  "INSERT INTO users (id, email, username, name, role, branch_id, menus, password_hash) VALUES ($1, $2, $3, $4, 'super', NULL, NULL, $5)",
  [id, email, usernameRaw || null, name, hashPassword(password)],
);
console.log(`Super admin ${email} berhasil dibuat. Silakan login di aplikasi.`);
process.exit(0);
