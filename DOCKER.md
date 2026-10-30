# Apname — Versi Docker (untuk VPS / provider mana pun)

Versi Docker ini membungkus setup VPS yang sebelumnya native
(systemd + Nginx + Postgres apt) menjadi 3 container, supaya Apname
bisa dipindah ke VPS lain hanya dengan menyalin repo + `.env` +
volume database, tanpa mengulang instalasi native dari nol.

**Yang TIDAK berubah:** kode aplikasi, skema database
(`server/schema.sql`), dan aturan tulis sync iNOX (produk baru hanya
jadi master, stok rak tidak pernah ditimpa sync, tidak ada tulis balik
ke iNOX).

---

## Arsitektur

| Service | Isi | Port |
|---|---|---|
| `db` | Postgres 16 Alpine, data di volume `apname-postgres` | internal saja |
| `backend` | Node 20, `server/src/server.js` (API + WebSocket + sync iNOX) | `127.0.0.1:4000` (localhost, debugging) |
| `web` | Nginx, frontend Vite mode VPS (`VITE_VPS_MODE=1`) + proxy `/api` dan `/ws` ke backend | `127.0.0.1:8080` (localhost, di depan Nginx host + HTTPS) |

Akses publik diatur di Nginx host (`docker/nginx-host.conf`), bukan
di container, supaya Certbot di host tetap bisa dipakai seperti biasa.

Skema awal `server/schema.sql` dijalankan otomatis Postgres hanya
saat volume `apname-postgres` masih kosong. Untuk database yang sudah
ada, skema tidak dijalankan ulang — jadi restore database lama aman.

---

## File Docker baru di repo ini

- `Dockerfile` — frontend: build Vite mode VPS → Nginx.
- `server/Dockerfile` — backend: Node 20, `npm ci`, `node src/server.js`.
- `docker-compose.yml` — `db` + `backend` + `web`, batas memori
  (db 300M, backend 256M, web 128M).
- `docker/nginx-web.conf` — Nginx di dalam container web.
- `docker/nginx-host.conf` — template Nginx host + HTTPS (ganti `DOMAIN_ANDA`).
- `docker/deploy-docker.sh` — build + up + cek status/log.
- `.dockerignore` — node_modules, dist, `.git`, `.env`, dll. tidak ikut image.
- `.env.docker.example` — contoh env, placeholder saja, tanpa secret.

---

## Cara jalan di VPS / server baru (ringkas)

```bash
# 1. Pasang Docker di Ubuntu (sekali saja, sebagai root)
apt update && apt install -y docker.io docker-compose-v2 nginx certbot python3-certbot-nginx curl git
systemctl enable --now docker nginx

# 2. Salin repo + file Docker ini
git clone https://github.com/ariansyadj/Apname.git
cd Apname

# 3. Buat env sungguhan (jangan commit, jangan kirim lewat chat)
cp .env.docker.example .env
nano .env
# Isi: POSTGRES_PASSWORD, DATABASE_URL (internal ke db),
# APNAME_JWT_SECRET (acak panjang), INOX_USERNAME/PASSWORD bila
# sync terjadwal dipakai, SYNC_INTERVAL_MIN (default 30).

# 4. Jalankan
bash docker/deploy-docker.sh
docker compose ps
curl http://127.0.0.1:8080/   # harus mengembalikan HTML login
```

### Nginx host + HTTPS

```bash
cp docker/nginx-host.conf /etc/nginx/sites-available/apname-docker
# Ganti DOMAIN_ANDA dengan domain publikmu, misal absensi / apname domain
nano /etc/nginx/sites-available/apname-docker
ln -s /etc/nginx/sites-available/apname-docker /etc/nginx/sites-enabled/apname-docker
nginx -t && systemctl reload nginx
# Pastikan DNS domain sudah mengarah ke IP VPS, baru:
certbot --nginx -d DOMAIN_ANDA
```

---

## Pindahkan data dari VPS lama / database lama

**Jangan** mengandalkan volume Docker baru kalau data lama masih
dibutuhkan. Lakukan di jam sepi, dan biarkan sumber lama hidup sampai
verifikasi lolos.

```bash
# 1. Di sumber lama (VPS native / database lama), buat dump:
pg_dump "$DATABASE_URL_LAMA" --no-owner --no-privileges -f dump-apname.sql

# 2. Di server Docker baru, jalankan db dulu saja, lalu restore:
docker compose up -d db
# Tunggu healthcheck db hijau: docker compose ps
docker compose exec -T db psql -U apname -d apname < dump-apname.sql

# 3. Jalankan semua service dan verifikasi:
bash docker/deploy-docker.sh
# Login super admin, cek cabang, rak, stok, sesi, dan laporan.
# Bandingkan jumlah baris penting dengan sumber lama sebelum
# menyatakan migrasi selesai.
```

**Batasan jujur backup dari mesin ini:** backup yang dibuat di
sesi ini adalah backup **kode** (repo + file Docker ini, di GitHub
dan di arsip lokal). Database VPS dan database Supabase **tidak bisa**
di-backup dari mesin ini karena SSH ke VPS sebelumnya diblokir
jaringan dan kredensial database produksi tidak ada di sini. Sebelum
menghapus VPS lama, dump database-nya dulu dari VPS itu sendiri
(langkah di atas), dan simpan file dump di luar VPS. Jangan hapus
sumber lama sebelum dump terverifikasi bisa di-restore.

---

## Update kode

```bash
git pull origin main
bash docker/deploy-docker.sh
```

Volume `apname-postgres` tidak ikut terhapus saat rebuild, jadi data
tetap ada. Jangan jalankan `docker compose down -v` di produksi —
flag `-v` menghapus volume database.

---

## Backup rutin setelah jalan di Docker

```bash
# Dump database Docker (simpan file di luar server juga)
docker compose exec -T db pg_dump -U apname -d apname > backup-apname-$(date +%F).sql

# Backup kode sudah di GitHub; backup env (.env) simpan terpisah
# di tempat aman, jangan di GitHub dan jangan di chat.
```

---

## Troubleshooting ringkas

| Gejala | Cek dulu |
|---|---|
| Web 502 / tidak merespons | `docker compose logs -f web` dan `docker compose logs -f backend`, pastikan backend jalan di 4000 |
| Login gagal / kembali ke login | `APNAME_JWT_SECRET` berubah atau belum diisi; sesi lama terputus itu normal setelah ganti secret |
| Database kosong padahal restore sudah | Pastikan restore dijalankan ke database/volume yang sama, dan `docker compose ps` menunjukkan db yang sama |
| Build kehabisan RAM di VPS 1 GB | Pasang swap 2 GB dulu (`fallocate`, `mkswap`, `swapon`), atau build di mesin lain |
| Sync iNOX tidak jalan | Cek `INOX_USERNAME`/`INOX_PASSWORD` di `.env` backend dan log backend saat jadwal sync |

---

## Catatan keamanan

- `.env` tidak pernah di-commit. File contoh di repo hanya placeholder.
- Kunci Supabase (`VITE_SUPABASE_URL`, anon key, service role) **tidak
  dipakai** di mode VPS Docker ini dan tidak boleh dimasukkan ke
  build/frontend Docker.
- Akun demo lokal (`super@opname`, dll.) hanya untuk demo lokal,
  jangan dipakai di produksi dengan password bebas.
