-- Apname / Opname Per Rak — Supabase schema (code only, not a live deployment).
-- Apply in the Supabase SQL editor, then set VITE_SUPABASE_URL /
-- VITE_SUPABASE_ANON_KEY in .env. No credential belongs in this file.
--
-- Role model: the app sets two JWT claims on the user's app metadata
-- (via Supabase Auth hooks / custom claims): role ('super' | 'admin' |
-- 'karyawan') and branch_id (e.g. 'KWSN', or null for super admin).
-- Policies below read those claims. A super admin sees every branch;
-- other roles see only their own branch_id. Until claims are set,
-- authenticated users see nothing, which is the safe default.

create extension if not exists pgcrypto;

create table if not exists branches (
  id text primary key,
  name text not null,
  location_id integer not null unique,
  location_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists racks (
  id text primary key,
  branch_id text not null references branches(id) on delete cascade,
  name text not null,
  type text not null default 'normal' check (type in ('normal', 'retur')),
  levels jsonb not null default '[]'::jsonb,
  x integer not null default 20,
  y integer not null default 20,
  w integer not null default 160,
  h integer not null default 90,
  rot integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists products (
  id text primary key,
  sku text not null,
  name text not null,
  variant text not null,
  category text,
  price numeric not null default 0,
  product_id integer not null,
  variation_id integer not null,
  location_id integer not null,
  barcode text,
  unique (product_id, variation_id, location_id)
);

create table if not exists stock_by_rack (
  product_id text not null references products(id) on delete cascade,
  rack_id text not null references racks(id) on delete cascade,
  level text not null,
  qty integer not null default 0,
  primary key (product_id, rack_id, level)
);

create table if not exists sessions (
  id text primary key,
  title text not null,
  branch_id text not null references branches(id) on delete cascade,
  racks jsonb not null default '[]'::jsonb,
  scope_levels jsonb,
  status text not null default 'Berjalan' check (status in ('Berjalan', 'Selesai')),
  created_by text not null,
  created_at timestamptz not null default now(),
  locked_at timestamptz,
  snapshot jsonb not null default '{}'::jsonb,
  external_at timestamptz,
  adjustment_status text not null default 'Menunggu' check (adjustment_status in ('Menunggu', 'Disetujui'))
);

create table if not exists scans (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references sessions(id) on delete cascade,
  scanned_at timestamptz not null default now(),
  scanned_by text not null,
  product_id text not null references products(id),
  rack_id text not null,
  level text not null,
  qty integer not null,
  mode text not null,
  barcode text
);

create table if not exists session_mutations (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references sessions(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by text not null,
  product_id text not null references products(id),
  kind text not null,
  direction text not null check (direction in ('Masuk', 'Keluar')),
  qty integer not null,
  rack_id text,
  reference text,
  note text
);

create table if not exists moves (
  id uuid primary key default gen_random_uuid(),
  moved_at timestamptz not null default now(),
  moved_by text not null,
  product_id text not null references products(id),
  from_rack_id text not null,
  from_level text not null,
  to_rack_id text not null,
  to_level text not null,
  qty integer not null,
  reason text not null,
  photo_data_url text
);

create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor text not null,
  action text not null,
  branch_id text,
  detail jsonb not null default '{}'::jsonb
);

create index if not exists idx_racks_branch on racks(branch_id);
create index if not exists idx_stock_rack on stock_by_rack(rack_id);
create index if not exists idx_scans_session on scans(session_id);
create index if not exists idx_mutations_session on session_mutations(session_id);
create index if not exists idx_audit_branch on audit_log(branch_id, created_at desc);

alter table branches enable row level security;
alter table racks enable row level security;
alter table products enable row level security;
alter table stock_by_rack enable row level security;
alter table sessions enable row level security;
alter table scans enable row level security;
alter table session_mutations enable row level security;
alter table moves enable row level security;
alter table audit_log enable row level security;

-- Helper: true when the caller is super admin, or when the row's branch
-- matches the caller's branch claim. Products carry location_id, not
-- branch_id, so their policy uses the branch lookup instead.
create or replace function public.is_super() returns boolean
  language sql stable as $$
    select coalesce(auth.jwt() ->> 'role', '') = 'super'
  $$;

create or replace function public.my_branch() returns text
  language sql stable as $$
    select nullif(auth.jwt() ->> 'branch_id', '')
  $$;

create policy "branches: super or own branch" on branches
  for all using (public.is_super() or id = public.my_branch());
create policy "racks: super or own branch" on racks
  for all using (public.is_super() or branch_id = public.my_branch());
create policy "sessions: super or own branch" on sessions
  for all using (public.is_super() or branch_id = public.my_branch());
create policy "scans: via session branch" on scans
  for all using (exists (
    select 1 from sessions s where s.id = scans.session_id
      and (public.is_super() or s.branch_id = public.my_branch())));
create policy "mutations: via session branch" on session_mutations
  for all using (exists (
    select 1 from sessions s where s.id = session_mutations.session_id
      and (public.is_super() or s.branch_id = public.my_branch())));
create policy "audit: super or own branch" on audit_log
  for all using (public.is_super() or branch_id = public.my_branch() or branch_id is null);
-- Products and stock are shared reference data; restrict writes to
-- super admin in the app layer and allow reads to authenticated users.
create policy "products: read for authenticated" on products
  for select using (auth.role() = 'authenticated');
create policy "stock: read for authenticated" on stock_by_rack
  for select using (auth.role() = 'authenticated');
create policy "moves: super or any branch staff (app enforces branch)" on moves
  for all using (auth.role() = 'authenticated');

-- === Tambahan produksi (branch production, 2026-10-26) ===
-- Tabel total eksternal iNOX (dipakai Edge Function inox-sync) dan
-- riwayat sync. Keduanya TIDAK menggantikan stock_by_rack: stok rak/level
-- hanya berubah lewat opname yang dikunci, bukan lewat sync.
create table if not exists external_totals (
  product_id text primary key references products(id) on delete cascade,
  stock integer not null default 0,
  stock_value numeric not null default 0,
  total_sold integer not null default 0,
  total_transfered integer not null default 0,
  total_adjusted integer not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists sync_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  records_total integer not null default 0,
  fetched integer not null default 0,
  added integer not null default 0,
  updated integer not null default 0,
  skipped integer not null default 0,
  branch_summary text not null default '',
  status text not null default 'ok'
);
alter table products add column if not exists location_name text;
alter table external_totals enable row level security;
alter table sync_runs enable row level security;
create policy "external_totals: read for authenticated" on external_totals
  for select using (auth.role() = 'authenticated');
create policy "sync_runs: super read" on sync_runs
  for select using (public.is_super());

-- === Tambahan migrasi penuh (2026-10-26) ===
-- Aplikasi memakai id teks (bukan UUID) untuk scan/mutasi/pindah, karena
-- id itu dibuat di browser (Date.now + random) dan dipakai untuk hapus
-- per baris. Di proyek yang sudah dibuat dari skema lama, alter di bawah
-- mengubah kolomnya tanpa menghapus data (id UUID lama jadi teks).
alter table scans alter column id type text using id::text;
alter table scans alter column id set default gen_random_uuid()::text;
alter table session_mutations alter column id type text using id::text;
alter table session_mutations alter column id set default gen_random_uuid()::text;
alter table moves alter column id type text using id::text;
alter table moves alter column id set default gen_random_uuid()::text;
-- Belum Ditempatkan: bukan rak, jadi tidak bisa masuk stock_by_rack
-- (rack_id ber-FK ke racks). Tabel khusus ini menyimpan qty yang belum
-- ditempatkan per produk (produk sudah membawa location_id/cabangnya).
create table if not exists unplaced_stock (
  product_id text primary key references products(id) on delete cascade,
  branch_id text not null,
  qty integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table unplaced_stock enable row level security;
-- Kebijakan tulis frontend (sebelumnya products/stock hanya SELECT, jadi
-- migrasi & kunci sesi dari frontend akan ditolak RLS):
-- products & external_totals: hanya super yang boleh tulis (sync harian
-- lewat Edge Function memakai service role, bukan kebijakan ini).
create policy "products: super write" on products
  for all using (public.is_super()) with check (public.is_super());
create policy "external_totals: super write" on external_totals
  for all using (public.is_super()) with check (public.is_super());
-- stock_by_rack: super atau staf cabang pemilik rak itu.
create policy "stock: super or rack branch write" on stock_by_rack
  for all using (public.is_super() or exists (
    select 1 from racks r where r.id = stock_by_rack.rack_id and r.branch_id = public.my_branch()
  )) with check (public.is_super() or exists (
    select 1 from racks r where r.id = stock_by_rack.rack_id and r.branch_id = public.my_branch()
  ));
create policy "unplaced: super or product branch" on unplaced_stock
  for all using (public.is_super() or branch_id = public.my_branch());
create policy "unplaced: read for authenticated" on unplaced_stock
  for select using (auth.role() = 'authenticated');
-- Catatan: "for all" pada sessions/scans/mutations/moves di skema utama
-- sudah mencakup tulis untuk super / cabang sendiri, jadi tidak perlu
-- kebijakan tambahan untuk tabel-tabel itu.

-- Realtime antar device (2026-10-26): tabel-tabel ini harus masuk publikasi
-- supabase_realtime supaya perubahan dari device lain mengalir lewat
-- Realtime ke aplikasi. Proyek baru yang menjalankan file ini dari awal
-- langsung mendapatkannya. Proyek lama: jalankan baris-baris di bawah
-- sekali di SQL Editor. Kalau satu baris error "already member", abaikan
-- baris itu (sudah ditambahkan sebelumnya) dan lanjutkan baris lain.
alter publication supabase_realtime add table branches;
alter publication supabase_realtime add table racks;
alter publication supabase_realtime add table products;
alter publication supabase_realtime add table stock_by_rack;
alter publication supabase_realtime add table sessions;
alter publication supabase_realtime add table scans;
alter publication supabase_realtime add table session_mutations;
alter publication supabase_realtime add table moves;
alter publication supabase_realtime add table external_totals;
alter publication supabase_realtime add table unplaced_stock;
