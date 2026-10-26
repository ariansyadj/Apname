-- Apname / Opname Per Rak — skema PostgreSQL untuk backend VPS.
-- Sama dengan skema Supabase, TANPA RLS (otorisasi ditegakkan di server
-- Node, bukan di database). Tidak ada kredensial di file ini.
-- Jalankan sekali: psql "$DATABASE_URL" -f schema.sql

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
  location_name text,
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
  id text primary key,
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
  id text primary key,
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
  id text primary key,
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

create table if not exists unplaced_stock (
  product_id text primary key references products(id) on delete cascade,
  branch_id text not null,
  qty integer not null default 0,
  updated_at timestamptz not null default now()
);

-- Akun login aplikasi (menggantikan Supabase Auth + klaim JWT-nya).
-- password_hash format: scrypt$<salt hex>$<hash hex> (lihat auth.js).
-- branch_id sengaja TANPA FK: akun boleh dibuat sebelum cabang di-seed.
create table if not exists users (
  id text primary key,
  email text not null unique,
  username text unique,
  name text not null,
  role text not null default 'karyawan' check (role in ('super', 'admin', 'karyawan')),
  branch_id text,
  menus jsonb,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_racks_branch on racks(branch_id);
create index if not exists idx_stock_rack on stock_by_rack(rack_id);
create index if not exists idx_scans_session on scans(session_id);
create index if not exists idx_mutations_session on session_mutations(session_id);
create index if not exists idx_audit_branch on audit_log(branch_id, created_at desc);
create index if not exists idx_users_branch on users(branch_id);
create index if not exists idx_sessions_branch on sessions(branch_id);
