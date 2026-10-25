export type Branch = { id: string; name: string; location_id: number; location_name: string };
export type Rack = { id: string; branchId: string; name: string; type: 'normal' | 'retur'; levels: string[]; x: number; y: number; w: number; h: number; rot: number };
export type Product = { id: string; sku: string; name: string; variant: string; category: string; price: number; product_id: number; variation_id: number; location_id: number; barcode: string; location_name?: string };
export const BRANCHES: Branch[] = [
  { id: 'KWSN', name: 'KWSN (MEGA MAS)', location_id: 6, location_name: 'KWSN' },
  { id: 'MDC', name: 'MDC', location_id: 1, location_name: 'MDC' },
  { id: 'LLF', name: 'LLF', location_id: 8, location_name: 'LLF' },
  { id: 'SDNKG', name: 'SDNKG', location_id: 7, location_name: 'SDNKG' },
];
export const SEED_PRODUCTS: Product[] = [
  { id: 'p1', sku: '8990124000135', name: 'Battery iPhone 14 Pro', variant: 'HX P', category: 'SPAREPART', price: 783000, product_id: 1040, variation_id: 1756, location_id: 6, barcode: '8990124000135' },
  { id: 'p1b', sku: '8990124000135', name: 'Battery iPhone 14 Pro', variant: 'HX P', category: 'SPAREPART', price: 783000, product_id: 1040, variation_id: 1756, location_id: 8, barcode: '8990124000135' },
  { id: 'p2', sku: '8990124000296', name: 'Battery iPhone XR', variant: 'BTA PP', category: 'SPAREPART', price: 450000, product_id: 1039, variation_id: 1726, location_id: 6, barcode: '8990124000296' },
  { id: 'p2b', sku: '8990124000296', name: 'Battery iPhone XR', variant: 'LF PP', category: 'SPAREPART', price: 465000, product_id: 1039, variation_id: 1727, location_id: 8, barcode: '8990124000296' },
  { id: 'p3', sku: '00002085', name: 'LCD iPhone 6 Plus', variant: 'OR', category: 'SPAREPART', price: 890000, product_id: 1021, variation_id: 1601, location_id: 6, barcode: '00002085' },
  { id: 'p4', sku: '8990124000401', name: 'Adapter Charger 20W', variant: '20W', category: 'ACCESORIS', price: 185000, product_id: 1050, variation_id: 1801, location_id: 6, barcode: '8990124000401' },
  { id: 'p5', sku: '8990124000402', name: 'Kabel Lightning 1m', variant: 'LGT', category: 'ACCESORIS', price: 95000, product_id: 1051, variation_id: 1802, location_id: 6, barcode: '8990124000402' },
];
export function seedRacks(): Rack[] {
  const racks: Rack[] = [];
  for (const b of BRANCHES) {
    racks.push({ id: `${b.id}-A`, branchId: b.id, name: 'Rak A', type: 'normal', levels: ['Level 1', 'Level 2', 'Level 3'], x: 20, y: 20, w: 160, h: 90, rot: 0 });
    racks.push({ id: `${b.id}-B`, branchId: b.id, name: 'Rak B', type: 'normal', levels: ['Level 1', 'Level 2'], x: 200, y: 20, w: 160, h: 90, rot: 0 });
    racks.push({ id: `${b.id}-RETUR`, branchId: b.id, name: 'RAK RETUR', type: 'retur', levels: ['Retur Customer', 'Retur Supplier', 'Rusak / QC'], x: 20, y: 140, w: 160, h: 90, rot: 0 });
  }
  return racks;
}
export function seedStock(): Record<string, number> {
  // key: productId|rackId|level  ; Belum Ditempatkan: productId|branchId|BELUM
  const s: Record<string, number> = {};
  const put = (pid: string, rack: string, lvl: string, q: number) => { s[`${pid}|${rack}|${lvl}`] = q; };
  put('p1', 'KWSN-A', 'Level 1', 2); put('p1', 'KWSN-A', 'Level 2', 1);
  put('p1b', 'LLF-A', 'Level 1', 6);
  put('p2', 'KWSN-B', 'Level 1', 4);
  put('p2b', 'LLF-B', 'Level 1', 4);
  put('p3', 'KWSN-A', 'Level 3', 8);
  put('p4', 'KWSN-B', 'Level 2', 12);
  put('p5', 'KWSN-A', 'Level 1', 20);
  s['p1|KWSN|BELUM'] = 0; s['p3|KWSN|BELUM'] = 0;
  return s;
}
export const fmtWita = (d: Date | string | number) => {
  const dt = new Date(d);
  return new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Makassar' }).format(dt) + ' WITA';
};
export const fmtShort = (d: Date | string | number) => {
  const dt = new Date(d);
  return new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Makassar' }).format(dt) + ' WITA';
};
export const rupiah = (n: number) => 'Rp' + n.toLocaleString('id-ID');
export function elapsedSince(t: number | null, now: number) {
  if (!t) return 'Belum pernah sync';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d} hari ${h} jam ${m} menit ${sec} detik yang lalu`;
  if (h > 0) return `${h} jam ${m} menit ${sec} detik yang lalu`;
  if (m > 0) return `${m} menit ${sec} detik yang lalu`;
  return `${sec} detik yang lalu`;
}
