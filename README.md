# Apname — Opname Per Rak

Aplikasi web opname stok per rak dan per level (React + TypeScript + Vite +
Tailwind, komponen shadcn/ui). Repo: https://github.com/ariansyadj/Apname
— branch `main` untuk kerja harian, branch `production` untuk deploy
Netlify + Supabase (lihat `DEPLOYMENT.md`).

Build saat ini: **2026-10-26-dibuat-oleh-cari-username** (footer aplikasi dan
`GET http://localhost:4001/api/health` harus menampilkan build yang sama —
kalau beda, berarti server yang jalan masih versi lama).

## Fitur yang sudah jalan (versi lokal, teruji di PC)

- **Cabang & rak:** KWSN (location_id 6), MDC (1), SDNKG (7), LLF (8);
  cabang baru otomatis aktif dari data sync. Rak per cabang dengan level
  yang bisa diubah, plus RAK RETUR per cabang. Master Rak, Visual Gudang
  (SVG, zoom ala Google Maps: jendela tetap, isi yang membesar/mengecil,
  geser area kosong = pan), Cetak Label Rak (QR `APNAME|cabang|rak|level`).
- **Sesi opname fleksibel:** 1 sesi = 1 cabang; scope bisa seluruh cabang,
  1 rak, beberapa rak, atau 1 level saja — dan scope itu TERKUNCI (rak/level
  di luar scope tidak bisa dipilih di dalam sesi). Snapshot dibekukan saat
  sesi dibuat: stok per rak/level + Total Eksternal Terakhir. Sync di tengah
  sesi tidak mengubah snapshot, hanya memberi peringatan.
- **Hitung:** scan barcode/SKU (+1 per scan, scan sekali isi jumlah, input
  manual), Scan Kamera, Scan QR Rak (pindah rak/level aktif; `L2` dikenali
  sebagai `Level 2`, prefix `APNAME` — bukan `ALNAME` — dan hasil pindah
  tertulis jelas di popup). Riwayat Scan default hanya level aktif, ada
  tombol Lihat Semua; Batalkan Scan Terakhir & Hapus per baris (sesi yang
  sudah dikunci tidak bisa dihapus scan-nya).
- **Mutasi selama opname:** dicatat terpisah, tampil di list "Riwayat Mutasi
  Selama Opname", dan dihitung di pratinjau (Disesuaikan = Snapshot +
  Masuk − Keluar) — karena snapshot mengunci angka pembanding, bukan dunia
  nyata: penjualan/pembelian selama opname tetap harus tercatat supaya
  tidak salah dibaca sebagai selisih.
- **Pratinjau & laporan:** pratinjau dikelompokkan per level (bukan satu
  list campur), "Cek Belum Dihitung" juga per level; Laporan: satu tombol
  Aksi ▾ per baris membuka mini popup (Lihat Isi, Excel, CSV, PDF,
  Ke Sesi, Setujui Adjustment, Adjustment iNOX, Hapus Sesi untuk Super).
  Isi Laporan juga dikelompokkan per level. Kolom **Dibuat Oleh** ada di
  Daftar Sesi, list Laporan, popup sesi, Isi Laporan, Excel (Ringkasan),
  dan PDF — formatnya "Nama (email)" untuk sesi baru.
- **Cari Barang:** menu baru — ketik nama/SKU/varian/barcode atau scan
  barcode, langsung tampil rak/level + stok per lokasi, termasuk baris
  "Belum Ditempatkan" dan baris eksplisit "Tidak ada stok di rak". Dari
  Stok & Master, tiap baris ada tombol "Lokasi →" ke menu ini.
- **Kelola Akun:** Super Admin membuat akun Super / Admin Cabang /
  Karyawan Cabang. Setiap akun punya **email + username** — login bisa
  pakai salah satunya (tidak peka huruf besar/kecil). Akun bawaan:
  `super@opname` → `super`, `admin@kwsn` → `admin_kwsn`,
  `karyawan@kwsn` → `karyawan_kwsn`. Password bebas di mode demo lokal.
- **Excel & PDF rapi:** satu nama kolom = satu lebar di semua sheet
  Excel (lihat `src/lib/reportWidths.ts`), header tebal + freeze +
  autofilter; PDF pakai lebar kolom tetap + landscape, jadi tidak
  mengembang mengikuti isi baris terpanjang.
- **Mobile:** dialog ramping, header/main rapat, select header full-width,
  tabel 13px + padding rapat (geser horizontal, bukan teks terpotong),
  input 16px (mencegah iOS auto-zoom), tombol Scan/Tambah & Buat Sesi
  full-width di HP.
- **Pindah Produk:** antar level/rak (termasuk RAK RETUR), stok asal/tujuan
  jelas, total cabang tidak berubah, foto bukti opsional (dikompres di
  browser).
- **Kunci sesi & adjustment:** kunci sesi memperbarui stok per rak/level
  dari hasil hitung; adjustment yang disetujui bisa diekspor sebagai CSV
  untuk diterapkan di aplikasi lain. Menghapus sesi yang sudah dikunci
  TIDAK mengembalikan stok dan tidak membatalkan adjustment yang sudah
  diterapkan di iNOX.

## Sync iNOX (nyata, lokal)

- Server lokal `server/inox-sync-server.mjs` (`npm run inox-server`,
  http://localhost:4001, hanya menerima localhost) login ke
  https://inox.my.id lalu menarik feed Laporan Stok (DataTables
  server-side, paging sampai terkumpul == recordsTotal, angka dari
  `data-orig-value`). Password hanya di memori satu request, tidak pernah
  ditulis ke disk/localStorage/repo.
- **Varian lengkap, massal lewat API:** feed memberi template
  (`product_variation`) + nilai (`variation_name`) — digabung di server
  menjadi `LCD-JK`, `LCD-BPE Black`, `BG/HS2-GOLD`, `BATT-BTA PP`, dst.
  Tidak ada field "grade" terpisah di iNOX; grade adalah nilai variasi itu
  sendiri. Import bersifat aditif: produk baru ke Belum Ditempatkan, produk
  lama hanya diperbarui field master + total eksternal, stok rak tidak
  pernah ditimpa sync.
- Kunci produk = `product_id + variation_id + location_id`. Baris tanpa
  SKU/lokasi dilewati (di sync terakhir: 2544 baris, 494 dilewati —
  terpisah dari masalah varian, karena baris LCD punya SKU + lokasi).

## Akun demo & barcode demo

- `super@opname` (Super, semua cabang), `admin@kwsn`, `karyawan@kwsn` —
  password bebas (demo lokal saja, jangan pakai password asli).
- Barcode demo: `8990124000135` (Battery 14 Pro), `8990124000296`
  (Battery XR), `00002085` (LCD 6 Plus), `8990124000401`, `8990124000402`.

## Cara jalan (lokal)

```bash
npm install
npm run dev        # CMD 1 — buka URL Local: yang dicetak, mis. http://localhost:5173
npm run inox-server # CMD 2 — http://localhost:4001 (untuk Sync Nyata)
npm run build      # verifikasi build produksi, hasil di dist/
```

Perangkap yang sering terjadi: server lama dari folder lama masih jalan,
sehingga tab lama menampilkan versi lama. Matikan server lama dulu,
`git pull origin main`, `npm install` bila ada dependensi baru, jalankan
lagi dari folder klon (`D:\Paman\Apname` di PC Ucok — bukan folder ZIP),
lalu buka alamat `Local:` yang dicetak CMD baru itu (Vite bisa pindah ke
5174 kalau 5173 masih dipakai server lama, dan data localStorage beda
per port).

## Deploy produksi (branch `production`)

Lihat `DEPLOYMENT.md` — langkah lengkap Supabase (proyek, `schema.sql`,
Auth + klaim role/cabang, secrets Edge Function, deploy + uji
`inox-sync`) dan Netlify (import repo, branch `production`, env
`VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`).

Status jujur: sampai langkah itu dijalankan di akun Ucok sendiri, belum ada
situs Netlify live dan belum ada proyek Supabase live — branch ini berisi
semua kode + konfigurasinya, bukan klaim sudah live. Migrasi data penuh ke
Supabase sudah selesai di kode (build 2026-10-26-hapus-item): login
cloud via Supabase Auth, data opname tersimpan ke Supabase, sync iNOX via
Edge Function; tanpa login Supabase, aplikasi tetap mode lokal persis
seperti sebelumnya. Detail + batasnya ada di DEPLOYMENT.md §4.
