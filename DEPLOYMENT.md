# Deployment Produksi — Apname ke Netlify + Supabase (branch `production`)

Branch ini (`production`) adalah branch deploy: isinya sama dengan `main`
ditambah setup produksi yang sudah jadi — `netlify.toml`, skema Supabase
lengkap (termasuk tabel `external_totals` + `sync_runs`), dan Edge Function
`inox-sync` yang sudah lengkap (bukan skeleton lagi).

> Jujur dulu, bro, supaya tidak ada klaim palsu: **sampai langkah di bawah
> dijalankan di akun Ucok sendiri, belum ada situs Netlify live dan belum
> ada proyek Supabase live.** Muse tidak bisa membuat akun Netlify/Supabase
> atas nama Ucok, dan tidak boleh mengarang URL live. Yang sudah siap di
> branch ini adalah semua kode + konfigurasinya, sehingga begitu akun
> dibuat, deploy-nya tinggal sambung, bukan bangun ulang.

## 1. Supabase — buat proyek (sekali saja)

1. Buka https://supabase.com/dashboard, buat proyek baru, catat:
   - Project URL: `https://<ref>.supabase.co`
   - Anon key (Settings → API → Project API keys → `anon public`)
   - Service role key (tempat yang sama, `service_role` — **rahasia**,
     jangan ditempel di frontend/chat/repo).
2. Buka SQL Editor proyek itu, tempel seluruh isi `supabase/schema.sql`,
   lalu Run. Ini membuat tabel branches, racks, products, stock_by_rack,
   sessions, scans, session_mutations, moves, audit_log, external_totals,
   sync_runs + RLS-nya.
   - RLS memakai klaim JWT `role` (`super` | `admin` | `karyawan`) dan
     `branch_id` (null untuk super). Sampai klaim itu diset, user yang
     login melihat data kosong — itu sengaja, default aman.
3. Buat user di Authentication → Users (satu per akun), lalu set klaimnya.
   Cara paling gampang: lewat SQL Editor, update `auth.users` →
   `raw_app_meta_data` (atau pakai Auth Hook sesuai docs Supabase),
   contoh untuk super admin: `{"role": "super", "branch_id": null}`,
   untuk admin KWSN: `{"role": "admin", "branch_id": "KWSN"}`.
   Nama/username akun di aplikasi (Kelola Akun) tetap dipakai sebagai
   `createdBy` di sesi, tapi otorisasi produksi memakai klaim ini.
   CARA KEDUA (lebih gampang, setelah fungsi di §2a di-deploy): login
   sebagai Super Admin di aplikasi, buka Kelola Akun → isi email, nama,
   password, hak akses, cabang → "Buat Akun Supabase". Akun langsung
   aktif + klaimnya langsung terpasang, tanpa SQL manual.

## 2. Supabase — Edge Function inox-sync (sekali saja)

Fungsi ini (`supabase/functions/inox-sync/index.ts`) adalah cerminan server
lokal `server/inox-sync-server.mjs` yang sudah terbukti sync 2544 baris di
PC Ucok — login Laravel (CSRF + cookie, tanpa follow redirect POST login),
feed DataTables sampai terkumpul == recordsTotal, angka dari
`data-orig-value`, varian lengkap template + nilai (`LCD` + `JK` = `LCD-JK`).
Ia hanya membaca iNOX, tidak pernah menulis balik, dan tidak pernah
menyentuh `stock_by_rack`.

1. Install Supabase CLI di PC, lalu dari folder repo:
   ```bash
   supabase link --project-ref <ref-proyek-anda>
   supabase functions deploy inox-sync
   ```
2. Set secrets (dashboard → Edge Functions → Secrets, atau CLI) — HANYA
   2 ini (terbukti 2026-10-26: dashboard MENOLAK nama berawalan
   `SUPABASE_` dengan error "Name must not start with the SUPABASE_
   prefix"):
   ```bash
   supabase secrets set INOX_USERNAME=<username-inox>
   supabase secrets set INOX_PASSWORD=<password-inox>
   ```
   `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` TIDAK perlu diisi
   manual — Supabase sudah menyediakannya otomatis sebagai variabel
   bawaan di dalam Edge Function, dan kode membacanya dari situ. Kalau
   dua baris itu sempat terisi di form Secrets, hapus saja (ikon tempat
   sampah), sisakan 2 secret iNOX, lalu Save.
   Password iNOX hanya di sini. Jangan pernah menaruhnya di chat, di
   `.env`, di Netlify, atau di repo.
3. Uji dulu tanpa menulis data (mode test — login + 5 baris pertama saja):
   ```bash
   curl -X POST https://<ref>.supabase.co/functions/v1/inox-sync \
     -H "Authorization: Bearer <anon-key>" \
     -H "Content-Type: application/json" \
     -d '{"action":"test"}'
   ```
   Harus kembali `{"ok":true,"action":"test","recordsTotal":2544,...}`.
   Kalau `ok:false` dan pesannya soal login, cek secrets, bukan kodenya.
4. Sync beneran (menulis products + external_totals, bukan stock rak):
   ```bash
   curl -X POST https://<ref>.supabase.co/functions/v1/inox-sync \
     -H "Authorization: Bearer <anon-key>" \
     -H "Content-Type: application/json" \
     -d '{"action":"sync"}'
   ```
   Harus kembali `recordsTotal`, `fetched`, `added`, `updated`,
   `skipped`, `branchSummary`, `lcdVariants` (varian lengkap, mis. `LCD-JK`).
   Riwayatnya tersimpan di tabel `sync_runs`.

## 2a. Supabase — Edge Function admin-create-user (sekali saja, untuk fitur Buat Akun dari aplikasi)

Fungsi ini (`supabase/functions/admin-create-user/index.ts`) memungkinkan
Super Admin membuat akun dari dalam aplikasi (Kelola Akun, mode cloud)
tanpa membuka dashboard Supabase dan tanpa SQL manual.

Cara kerjanya (aman): aplikasi mengirim JWT user yang login → fungsi
memverifikasi token itu ke Supabase Auth dan memeriksa klaimnya
(`app_metadata.role` harus `super`) → kalau ya, fungsi membuat user baru
lewat Admin API dengan `email_confirm: true` (langsung aktif) dan klaim
role/cabang langsung terpasang. Fungsi TIDAK PERNAH percaya role yang
dikirim dari body request — satu-satunya sumber kebenaran adalah token
yang sudah diverifikasi. Service role key tidak pernah dikirim ke
aplikasi; ia hanya dibaca fungsi dari variabel bawaan Supabase.

Deploy-nya sama seperti inox-sync (paste di dashboard Edge Functions
dengan nama persis `admin-create-user`, atau `supabase functions deploy
admin-create-user` dari CLI). TIDAK ADA SECRET BARU yang perlu diisi:
fungsi ini hanya memakai variabel bawaan `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, dan `SUPABASE_SERVICE_ROLE_KEY` (otomatis tersedia,
tidak bisa diisi manual karena berawalan SUPABASE_).

Catatan: fungsi ini TIDAK menggantikan inox-sync — keduanya fungsi
berbeda, keduanya harus ada. Kalau fungsi ini belum di-deploy, form
Buat Akun di aplikasi akan gagal dengan pesan error yang menyebutnya.

## 3. Netlify — sambungkan repo (sekali saja)

1. Buka https://app.netlify.com, Add new site → Import an existing project
   → GitHub → repo `ariansyadj/Apname` → **branch: `production`**
   (bukan `main` — supaya kerja harian di `main` tidak langsung menimpa
   situs live sebelum diuji).
2. Build settings (sudah di `netlify.toml`, tapi pastikan di dashboard
   sama): Build command `npm run build`, Publish directory `dist`,
   Node 20. Redirect SPA `/* → /index.html` sudah di `netlify.toml`.
3. Environment variables (Site settings → Environment variables):
   - `VITE_SUPABASE_URL` = Project URL Supabase
   - `VITE_SUPABASE_ANON_KEY` = anon key (bukan service role key)
   Jangan isi `INOX_PASSWORD` atau service role key di Netlify — tempatnya
   hanya di secrets Edge Function Supabase.
4. Deploy. Begitu selesai, buka URL Netlify-nya dan cek:
   - Footer menampilkan `Build 2026-10-26-buat-akun`.
   - Badge `Supabase terkonfigurasi (belum login cloud)` muncul di header
     (tanda env terbaca); setelah login Supabase, badge menjadi
     `Supabase • Cloud`.
   - Login dengan akun Supabase Auth yang sudah dibuat di langkah 1
     (tombol "Masuk dengan Supabase", bukan akun demo).
   - PENTING: env VITE_* dibaca Vite saat build. Kalau env baru diisi
     setelah deploy pertama, wajib Trigger deploy ulang, kalau tidak
     aplikasi tetap mengira Supabase belum terkonfigurasi.

## 4. Migrasi data penuh ke Supabase (SELESAI di kode, build 2026-10-26-buat-akun)

- Kalau env Supabase terisi, layar login menampilkan tombol
  **"Masuk dengan Supabase (data cloud)"** (butuh email + password
  Supabase Auth). Setelah login cloud, badge header menjadi
  **"Supabase • Cloud"** dan seluruh data (produk, rak, stok, sesi +
  scan + mutasi, pindah, total eksternal) dimuat dari Supabase.
- **Tanpa login Supabase, aplikasi persis seperti versi lokal**
  (localStorage) — mode lokal tidak berubah sama sekali.
- Migrasi data lokal yang sudah ada: di Settings → kartu
  "Supabase — Mode Cloud" (hanya muncul kalau env terisi dan sudah login
  cloud), tekan **"Migrasi Data Lokal → Supabase"**, lalu
  **"Muat Ulang dari Supabase"** untuk memastikan yang tampil adalah data
  cloud. Sync iNOX di mode cloud memanggil Edge Function (tombol
  "Sync via Edge Function" di kartu yang sama), bukan localhost:4001.
- **Proyek Supabase lama:** jalankan bagian "Tambahan migrasi penuh
  (2026-10-26)" di `supabase/schema.sql` (tabel `unplaced_stock`,
  kebijakan tulis, kolom id scan/mutasi/pindah jadi text). Proyek baru
  cukup menjalankan seluruh file sekali.
- **Batas yang masih berlaku (baca sebelum go-live):**
  - Tidak ada realtime: perubahan dari HP lain baru terlihat setelah
    "Muat Ulang dari Supabase".
  - Dua orang mengedit sesi yang sama bersamaan = last-write-wins di
    level sesi (scan ditulis ulang per sesi saat simpan).
  - Akun di mode cloud dikelola di Supabase Auth, bukan menu Kelola Akun
    (menu itu menampilkan penjelasan ini saat mode cloud aktif).
  - Server lokal (`npm run dev` + `npm run inox-server`) tetap cara yang
    terbukti untuk sync nyata dari PC, dan branch `main` tetap branch
    kerja harian.

## 5. Keep-alive Supabase gratis (supaya tidak auto-pause)

- File: `scripts/supabase-keepalive.mjs` + `.github/workflows/supabase-keepalive.yml`.
- Cara kerja: GitHub Actions ping baca kecil (1 baris tabel branches)
  tiap tanggal 1, 7, 13, 19, 25, 31 jam 10:00 WITA — jeda maks 6 hari,
  di bawah batas pause 7 hari. Tidak menulis data, tidak memanggil Edge
  Function, tidak menyentuh iNOX.
- Pemakaian: ~5 request/bulan, < 1 KB per request, 0 panggilan Edge
  Function. Praktis tidak mengurangi limit gratis sama sekali.
- Yang harus diisi Ucok (sekali saja, setelah proyek Supabase dibuat):
  GitHub repo -> Settings -> Secrets and variables -> Actions ->
  New repository secret: `SUPABASE_URL` (mis. https://xxx.supabase.co)
  dan `SUPABASE_ANON_KEY` (kunci anon/publishable dari dashboard
  Supabase, BUKAN service role key). Sampai dua secret ini diisi,
  workflow akan gagal — itu normal, bukan kerusakan.
- Uji manual: GitHub repo -> Actions -> "Supabase keep-alive" ->
  Run workflow. Harus tampil "keep-alive OK".
- Catatan: workflow terjadwal hanya jalan dari branch default (main).
  GitHub juga bisa menonaktifkan jadwal kalau repo tidak disentuh 60
  hari — mengaktifkannya lagi cukup dengan Run workflow manual sekali
  atau push apa pun ke main.

## Rollback

- Netlify bermasalah → di dashboard Netlify, kembalikan deploy ke deploy
  sebelumnya (Deploys → Publish deploy), atau ganti branch deploy kembali
  ke `main`. Data lokal di browser tidak terpengaruh.
- Edge Function bermasalah → sync lokal tetap jalan (server localhost:4001),
  dan data Supabase yang sudah ditulis tidak mengubah stok rak sama sekali.
