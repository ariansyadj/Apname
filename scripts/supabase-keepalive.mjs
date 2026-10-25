// Keep-alive Supabase (paket gratis) — 1x tiap 6 hari, pemakaian nyaris nol.
//
// CARA KERJA: 1 request baca kecil ke tabel branches (limit 1 baris) lewat
// REST Supabase memakai ANON key (bukan service role key). Tujuannya cuma
// supaya proyek tercatat "aktif" dan tidak auto-pause setelah 7 hari diam.
// - Tidak menulis data apa pun, tidak memanggil Edge Function, tidak
//   menyentuh iNOX, tidak mengubah stok.
// - 1 request / 6 hari = ~5 request per bulan, respons < 1 KB. Jauh di
//   bawah batas gratis (5 GB egress/bulan, 500.000 panggilan Edge
//   Function/bulan — dan ping ini bahkan bukan Edge Function, jadi 0).
// - Hasil kosong ([]) tetap dihitung sebagai aktivitas: request-nya sampai
//   ke database, cuma RLS menahan barisnya untuk anon. Itu sudah cukup.
// - Dijalankan GitHub Actions (.github/workflows/supabase-keepalive.yml).
//   Nilai URL/key TIDAK ada di file ini — diambil dari secrets repo
//   GitHub (SUPABASE_URL, SUPABASE_ANON_KEY).
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_ANON_KEY belum diset (isi di GitHub repo Secrets).');
  process.exit(1);
}
let res;
try {
  res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/branches?select=id&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
} catch (e) {
  console.error('keep-alive GAGAL (jaringan/URL tidak bisa dihubungi): ' + (e.message || String(e)));
  process.exit(1);
}
const body = await res.text();
console.log(`keep-alive: HTTP ${res.status}, body: ${body.slice(0, 200)}`);
if (!res.ok) {
  console.error('keep-alive GAGAL — proyek mungkin sudah pause, atau URL/key salah. Cek dashboard Supabase.');
  process.exit(1);
}
console.log('keep-alive OK — proyek tercatat aktif.');
