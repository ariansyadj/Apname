# Opname Per Rak — MVP

Aplikasi web opname stok per rak dan per level, dibangun dari `~/workspace/your_files/Prompt-Aplikasi-Opname-Per-Rak.md`.

## Yang sudah jadi di MVP ini
- Login demo + role: Super Admin (semua cabang), Admin Cabang (hanya cabangnya), Karyawan (lihat saja untuk visual, hitung di sesi)
- 4 tema: white, dark, pink, blue (CSS Variables ala shadcn/ui, tersimpan per perangkat)
- Master: cabang KWSN (location_id 6), MDC (1), LLF (8), SDNKG (7); rak per cabang dengan level customizable; rak khusus RAK RETUR per cabang
- Produk seed dari contoh iNOX: Battery iPhone 14 Pro, Battery iPhone XR, LCD iPhone 6 Plus, Adapter, Kabel — kunci product_id + variation_id + location_id, bukan SKU saja
- Visual Gudang 2D (SVG, ringan): geser balok rak (drag, snap grid), rotate 90°, klik rak → level → Opname Rak Ini. Menggeser visual tidak mengubah stok.
- Sesi opname fleksibel: 1 sesi = 1 cabang, scope bisa seluruh cabang, 1 rak, beberapa rak, atau 1 level (hitung hanya level itu)
- Snapshot beku saat sesi dibuat: stok per rak/level + Total Eksternal Terakhir
- Hitung: scan barcode/SKU dengan mode +1 per scan, scan sekali isi jumlah, dan input manual. Tiap scan tercatat tanggal, bulan, tahun, jam, menit, detik WITA + petugas + rak/level
- Pratinjau Mini Laporan sebelum kunci: ringkasan cocok/lebih/kurang/belum dihitung, akurasi, filter selisih/belum, tanda DRAFT — BELUM DIKUNCI. Kunci sesi memperbarui stok per rak/level dari hasil hitung
- Laporan: menu daftar semua sesi, tiap baris bisa diekspor lagi (Excel via CSV yang bisa dibuka di Excel, PDF via Cetak browser, dan file Adjustment iNOX CSV). Export ulang memakai snapshot yang dikunci, bukan stok live
- Pindah produk: antar level di rak yang sama maupun antar rak dengan level tujuan spesifik, termasuk ke/dari RAK RETUR. Total cabang tidak berubah oleh pindah ini
- Sync iNOX: kartu Status Sync selalu terlihat dengan waktu absolut + selang waktu yang berjalan tiap detik (jam/menit/detik), warna hijau/kuning/merah, tombol Sync Sekarang, Settings → Integrasi iNOX (isi sekali, Uji Koneksi, Simpan, Putuskan/Logout dan Ganti Akun)

## Akun demo
- `super@opname` — Super Admin, semua cabang
- `admin@kwsn` — Admin Cabang KWSN
- `karyawan@kwsn` — Karyawan KWSN
- Password: bebas (demo lokal saja)

Barcode demo untuk scan: `8990124000135` (Battery 14 Pro), `8990124000296` (Battery XR), `00002085` (LCD 6 Plus), `8990124000401`, `8990124000402`.

## Cara jalan
```bash
cd opname-app
npm install
npm run dev
# lalu buka URL yang ditampilkan Vite, biasanya http://localhost:5173
npm run build   # verifikasi build produksi, hasil di dist/
```

## Deploy ke Netlify (frontend statis)
- Build command: `npm run build`, Publish directory: `dist`
- File `netlify.toml` sudah disertakan. Data demo di MVP ini memakai localStorage agar langsung jalan tanpa backend.
- Untuk produksi, ganti layer data ke Supabase sesuai §16 prompt: Postgres + Auth + RLS + Edge Functions untuk sync iNOX dan export. Struktur data, kunci, dan logika di kode ini sudah disiapkan untuk pemindahan itu (branch, rack, level, product_id/variation_id/location_id, snapshot, scan log, mutasi).

## Batasan jujur MVP ini (bukan klaim palsu)
- Sync iNOX di MVP ini masih simulasi dari data seed + Settings integrasi demo. Sync nyata ke `https://inox.my.id/reports/stock-report` (feed DataTables, cookie session, paging draw/start/length, parse data-orig-value) harus diimplementasikan di Supabase Edge Function dengan kredensial iNOX terenkripsi di server, bukan di browser — jangan tempel password iNOX asli ke kode frontend.
- Export Excel di MVP ini berupa CSV (bisa dibuka dan disimpan sebagai .xlsx di Excel). Export ExcelJS asli dan PDF A4 bertanda tangan penuh adalah langkah berikutnya di backend.
- Scan kamera HP (ZXing/html5-qrcode), PWA offline penuh, dan label barcode belum di MVP ini — halaman hitung sudah siap untuk ditambahkan library itu hanya di halaman hitung (lazy load).
- Foto bukti, mutasi selama sesi yang terpisah dari pindah produk, dan approval adjustment multi-level ada di prompt sebagai Fase 2 — di MVP ini pindah produk dan kunci sesi sudah mencatat log dasarnya.
