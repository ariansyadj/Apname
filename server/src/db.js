// Pool PostgreSQL untuk backend Apname (VPS). Koneksi dari DATABASE_URL.
// Satu-satunya tempat SQL mentah tinggal; rute-rute memanggil helper ini.
import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("[apname] DATABASE_URL belum diset (lihat .env).");
  process.exit(1);
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on("error", (err) => {
  // Pool memulihkan koneksi sendiri; jangan matikan proses karena satu
  // koneksi idle putus.
  console.error("[apname] pool error:", err.message);
});

// Konversi waktu: frontend memakai ms (number), DB memakai timestamptz.
export const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
export const msOf = (s) => (s ? new Date(s).getTime() : null);
export const num = (v) => Number(v || 0);

// Jalankan fungsi dalam satu transaksi; rollback otomatis bila gagal.
export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Seed cabang standar (KWSN/MDC/SDNKG/LLF) bila tabel masih kosong.
// Dipanggil sekali saat boot; idempotent.
export async function seedBranches() {
  const rows = [
    ["KWSN", "KWSN", 6, "KWSN"],
    ["MDC", "MDC", 1, "MDC"],
    ["SDNKG", "SDNKG", 7, "SDNKG"],
    ["LLF", "LLF", 8, "LLF"],
  ];
  for (const [id, name, loc, locName] of rows) {
    await pool.query(
      "INSERT INTO branches (id, name, location_id, location_name) VALUES ($1, $2, $3, $4) ON CONFLICT (location_id) DO NOTHING",
      [id, name, loc, locName],
    );
  }
}
