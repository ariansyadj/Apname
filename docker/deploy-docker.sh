#!/bin/bash
# Deploy / update Apname Docker (jalankan di folder root repo).
# 1. Pastikan file .env sudah dibuat dari .env.docker.example dan terisi.
# 2. Jalankan: bash docker/deploy-docker.sh
# Skrip ini: build ulang image web + backend, jalankan container,
# lalu cek status dan log singkat. Skema database awal dijalankan
# otomatis Postgres hanya saat volume masih kosong.
set -e
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "ERROR: file .env belum ada. Salin .env.docker.example ke .env lalu isi dulu."
  exit 1
fi

echo "==> Build dan jalankan container..."
docker compose up -d --build

echo "==> Status container:"
docker compose ps

echo "==> Log backend (20 baris terakhir):"
docker compose logs --tail=20 backend || true

echo "==> Cek web lokal (harus mengembalikan HTML login, bukan error koneksi):"
curl -fsS http://127.0.0.1:8080/ | head -c 200 || echo "PERINGATAN: web lokal belum merespons, cek log web: docker compose logs -f web"
echo
