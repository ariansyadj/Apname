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
2. Set secrets (dashboard → Edge Functions → Secrets, atau CLI):
   ```bash
   supabase secrets set INOX_USERNAME=<username-inox>
   supabase secrets set INOX_PASSWORD=<password-inox>
   supabase secrets set SUPABASE_URL=https://<ref>.supabase.co
   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
   ```
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
   - Footer menampilkan `Build 2026-10-26-dibuat-oleh-cari-username`
     (build yang sama dengan yang jalan lokal sekarang).
   - Badge `Supabase aktif` muncul di header (tanda env terbaca).
   - Login dengan akun Supabase Auth yang sudah dibuat di langkah 1.

## 4. Yang BELUM berubah di versi ini (baca sebelum go-live)

- Frontend di Netlify masih memakai localStorage sebagai sumber utama
  data opname (sesi, scan, stok rak) — persis seperti versi lokal — dengan
  satu pengecualian: kalau Supabase terkonfigurasi, daftar rak dimuat dari
  tabel `racks` Supabase (best-effort, gagal = fallback lokal). Badge
  "Supabase aktif" berarti env terbaca, **bukan** berarti semua data sudah
  pindah ke Supabase.
- Jadi go-live yang benar urutannya: (a) Netlify + Supabase + Edge Function
  jalan dulu dengan data lokal seperti sekarang, (b) **fase berikutnya**
  adalah migrasi layer data penuh: sesi/scan/mutasi/stok/akun pindah dari
  localStorage ke tabel Supabase + Supabase Auth, dan tombol Sync di
  aplikasi memanggil Edge Function, bukan server localhost:4001. Fase itu
  sengaja tidak dicampur ke branch ini, karena menyentuh semua state
  aplikasi dan harus diuji terpisah — kalau dicampur sekarang, risiko
  merusak aplikasi lokal yang sudah jalan lebih besar daripada manfaatnya.
- Selama fase migrasi belum jalan, server lokal (`npm run dev` +
  `npm run inox-server`) tetap cara yang terbukti untuk sync nyata dari PC,
  dan branch `main` tetap branch kerja harian.

## Rollback

- Netlify bermasalah → di dashboard Netlify, kembalikan deploy ke deploy
  sebelumnya (Deploys → Publish deploy), atau ganti branch deploy kembali
  ke `main`. Data lokal di browser tidak terpengaruh.
- Edge Function bermasalah → sync lokal tetap jalan (server localhost:4001),
  dan data Supabase yang sudah ditulis tidak mengubah stok rak sama sekali.
