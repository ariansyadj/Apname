import { useEffect, useMemo, useRef, useState } from 'react';
import { BRANCHES, SEED_PRODUCTS, seedRacks, seedStock, fmtWita, fmtShort, rupiah, elapsedSince, type Rack, type Product } from './data';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { AppSidebar, type NavItem } from '@/components/layout/app-sidebar';
import { MasterRacks } from '@/components/MasterRacks';
import { printLabels, type LabelItem } from '@/lib/labels';
import { printReport, type ReportRow } from '@/lib/reportPrint';
import { isSupabaseConfigured, loadRacksFromSupabase } from '@/lib/supabase';
import {
  LayoutDashboard, Package, Map, ClipboardList, FileText, ArrowLeftRight, Settings as SettingsIcon,
  Menu, RefreshCw, Camera, Eye, Plus, Trash2, RotateCw, ScanLine, Layers, ZoomIn, ZoomOut, Maximize2, Printer, Users,
} from 'lucide-react';

type Role = 'super' | 'admin' | 'karyawan';
type User = { email?: string; name: string; role: Role; branchId: string | null };
type ScanRow = { id: string; time: number; user: string; productId: string; rackId: string; level: string; qty: number; mode: string; barcode: string };
type SessionMutation = { id: string; time: number; user: string; productId: string; kind: string; direction: 'Masuk' | 'Keluar'; qty: number; rackId: string; reference: string; note: string };
type MoveRow = { id: string; time: number; user: string; productId: string; fromRack: string; fromLevel: string; toRack: string; toLevel: string; qty: number; reason: string; photo: string };
type Session = { id: string; title: string; branchId: string; racks: string[]; scopeLevels?: Record<string, string[]>; status: 'Berjalan' | 'Selesai'; createdAt: number; createdBy: string; lockedAt: number | null; snapshot: Record<string, number>; scans: ScanRow[]; mutations: SessionMutation[]; adjustmentStatus: 'Menunggu' | 'Disetujui'; externalAt: number | null };
type View = 'dashboard' | 'stok' | 'master' | 'visual' | 'opname' | 'laporan' | 'pindah' | 'settings' | 'akun';
function branchLabelFor(location_id: number, location_name?: string): string {
  const known = BRANCHES.find(b => b.location_id === location_id);
  if (known) return known.id;
  if (location_name) { const clean = location_name.toUpperCase().replace(/[^A-Z0-9]+/g, ''); if (clean) return clean; }
  return `LOC-${location_id}`;
}
function branchIdOfProduct(pr: Product): string { return branchLabelFor(pr.location_id, pr.location_name); }
function matchesQuery(pr: Product, q: string): boolean {
  // Cocok per kata, bukan substring utuh: "lcd iphone 13 bpt" harus cocok walau
  // SKU ada di tengah (nama + SKU + varian). Tanda "-" diperlakukan sebagai
  // spasi, supaya pencarian dengan kode lama ("LCD-JK", "BATT-BR P") tetap
  // menemukan produk yang variannya kini "JK" / "BR P".
  const norm = (x: string) => x.toLowerCase().replace(/-/g, ' ');
  const tokens = norm(q).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = norm(pr.name + ' ' + pr.sku + ' ' + pr.variant + ' ' + pr.barcode + ' ' + branchIdOfProduct(pr) + ' ' + pr.category);
  return tokens.every(t => hay.includes(t));
}
function variantAfterDash(text: string): string | null {
  if (!text) return null;
  const str = String(text).trim();
  const idx = str.indexOf('-');
  if (idx < 0) return null;
  const after = str.slice(idx + 1).trim();
  return after ? after : null;
}
function paginate<T>(list: T[], page: number, pageSize: number | 'Semua'): T[] {
  if (pageSize === 'Semua') return list;
  const ps = Number(pageSize);
  return list.slice((page - 1) * ps, page * ps);
}
function totalPagesFor(total: number, pageSize: number | 'Semua'): number {
  if (pageSize === 'Semua') return 1;
  return Math.max(1, Math.ceil(total / Number(pageSize)));
}
function Pager({ page, pageSize, total, onPage, onPageSize }: { page: number; pageSize: number | 'Semua'; total: number; onPage: (n: number) => void; onPageSize: (n: number | 'Semua') => void }) {
  const tp = totalPagesFor(total, pageSize);
  const start = total === 0 ? 0 : pageSize === 'Semua' ? 1 : (page - 1) * Number(pageSize) + 1;
  const end = pageSize === 'Semua' ? total : Math.min(total, page * Number(pageSize));
  return (<div className="mt-2 flex flex-wrap items-center gap-2 text-sm"><span>Tampilkan:</span><div className="w-[110px]"><Select value={String(pageSize)} onValueChange={(v) => onPageSize(v === 'Semua' ? 'Semua' : Number(v))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{[25, 50, 100].map(n => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}<SelectItem value="Semua">Semua</SelectItem></SelectContent></Select></div><span>Menampilkan {start}–{end} dari {total}</span><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Sebelumnya</Button><span>Halaman {page} / {tp}</span><Button variant="outline" size="sm" disabled={page >= tp} onClick={() => onPage(page + 1)}>Berikutnya</Button></div>);
}
const THEMES = ['white', 'dark', 'pink', 'blue'] as const;
const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'stok', label: 'Stok & Master', icon: Package },
  { id: 'master', label: 'Master Rak', icon: Layers },
  { id: 'visual', label: 'Visual Gudang', icon: Map },
  { id: 'opname', label: 'Sesi Opname', icon: ClipboardList },
  { id: 'laporan', label: 'Laporan', icon: FileText },
  { id: 'pindah', label: 'Pindah Produk', icon: ArrowLeftRight },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
  { id: 'akun', label: 'Kelola Akun', icon: Users },
];
function load<T>(k: string, f: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : f; } catch { return f; } }
function save(k: string, v: unknown) { localStorage.setItem(k, JSON.stringify(v)); }
function downloadBlob(blob: Blob, name: string) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); }
function scopeLabel(s: Session): string {
  if (!s.scopeLevels) return s.racks.join(', ');
  return Object.entries(s.scopeLevels).map(([rid, lvs]) => `${rid}: ${lvs.join(', ')}`).join(' • ');
}
function inSessionScope(sess: Session, rid: string, lv: string): boolean {
  if (!sess.racks.includes(rid)) return false;
  const scoped = sess.scopeLevels?.[rid];
  if (scoped) return scoped.includes(lv);
  return true;
}
function levelsFor(sess: Session, rackId: string, allRacks: Rack[]): string[] {
  const scoped = sess.scopeLevels?.[rackId];
  if (scoped) return scoped;
  return allRacks.find(r => r.id === rackId)?.levels || [];
}
/** Parse QR label rak: APNAME|{branchId}|{rackId}|{level} (lihat labels.ts).
 *  Bukan barcode produk — QR ini mengidentifikasi lokasi, bukan barang. */
function parseRackQr(code: string): { branchId: string; rackId: string; level: string } | null {
  const parts = code.trim().split('|');
  if (parts.length !== 4 || parts[0] !== 'APNAME' || !parts[1] || !parts[2] || !parts[3]) return null;
  return { branchId: parts[1], rackId: parts[2], level: parts[3] };
}
function compressImage(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          const max = 1024; const scale = Math.min(1, max / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas'); canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
          const ctx = canvas.getContext('2d'); if (!ctx) { resolve(String(reader.result)); return; }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        } catch { resolve(String(reader.result)); }
      };
      img.onerror = () => resolve(String(reader.result));
      img.src = String(reader.result);
    };
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}
function FieldSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (<div><label className="text-sm font-medium">{label}</label><Select value={value} onValueChange={onChange}><SelectTrigger className="mt-1"><SelectValue /></SelectTrigger><SelectContent>{options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent></Select></div>);
}

export default function App() {
  const [user, setUser] = useState<User | null>(() => load('opname-user', null));
  const [loginEmail, setLoginEmail] = useState('super@opname');
  const [theme, setTheme] = useState<string>(() => load('opname-theme', 'white'));
  const [view, setView] = useState<View>('dashboard');
  const [branchFilter, setBranchFilter] = useState<string>('Semua');
  const [products, setProducts] = useState<Product[]>(() => load('opname-products', SEED_PRODUCTS));
  const [accounts, setAccounts] = useState<{ email: string; name: string; role: Role; branchId: string | null }[]>(() => load('opname-accounts', [{ email: 'super@opname', name: 'Super Admin', role: 'super' as Role, branchId: null }, { email: 'admin@kwsn', name: 'Admin KWSN', role: 'admin' as Role, branchId: 'KWSN' }, { email: 'karyawan@kwsn', name: 'Karyawan KWSN', role: 'karyawan' as Role, branchId: 'KWSN' }]));
  const [newAccEmail, setNewAccEmail] = useState('');
  const allBranches = useMemo(() => {
    const list = [...BRANCHES];
    for (const pr of products) {
      if (!list.some(b => b.location_id === pr.location_id)) {
        const id = branchIdOfProduct(pr);
        list.push({ id, name: pr.location_name ? pr.location_name.toUpperCase() : id, location_id: pr.location_id, location_name: pr.location_name || id });
      }
    }
    return list;
  }, [products]); const [newAccName, setNewAccName] = useState(''); const [newAccRole, setNewAccRole] = useState<Role>('karyawan'); const [newAccBranch, setNewAccBranch] = useState('KWSN');
  const [externalTotals, setExternalTotals] = useState<Record<string, { stock: number; at: number }>>(() => load('opname-external-totals', {}));
  const [inoxMode, setInoxMode] = useState<string>(() => load('opname-inox-mode', 'demo'));
  const [syncBusy, setSyncBusy] = useState(false);
  const [racks, setRacks] = useState<Rack[]>(() => load('opname-racks', seedRacks()));
  const [stock, setStock] = useState<Record<string, number>>(() => load('opname-stock', seedStock()));
  const [sessions, setSessions] = useState<Session[]>(() => load('opname-sessions', []));
  const [moves, setMoves] = useState<MoveRow[]>(() => load('opname-moves', []));
  const [lastSync, setLastSync] = useState<number | null>(() => load('opname-lastSync-real', null));
  const [now, setNow] = useState(Date.now());
  const [inoxUser, setInoxUser] = useState<string>(() => load('opname-inox-user', ''));
  const [inoxConnected, setInoxConnected] = useState<boolean>(() => (inoxMode === 'local' ? false : load('opname-inox-connected-real', false)));
  const [lcdSample, setLcdSample] = useState<{ total: number | null; rows: any[] } | null>(null);
  const [inoxPass, setInoxPass] = useState('');
  const [search, setSearch] = useState(''); const [stokBranch, setStokBranch] = useState('Semua'); const [stokCategory, setStokCategory] = useState('Semua'); const [stokStock, setStokStock] = useState('semua'); const [stokPage, setStokPage] = useState(1); const [stokPageSize, setStokPageSize] = useState<number | 'Semua'>(25); const [lapPage, setLapPage] = useState(1); const [lapPageSize, setLapPageSize] = useState<number | 'Semua'>(25); const [reportPage, setReportPage] = useState(1); const [reportPageSize, setReportPageSize] = useState<number | 'Semua'>(25); const [reportLevelFilter, setReportLevelFilter] = useState('semua'); const [reportRawPage, setReportRawPage] = useState(1); const [reportFull, setReportFull] = useState(false); const [lastSyncReport, setLastSyncReport] = useState<any>(() => load('opname-last-sync-report', null));
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewFilter, setPreviewFilter] = useState('semua'); const [reportSessionId, setReportSessionId] = useState<string | null>(null); const [aksiSessionId, setAksiSessionId] = useState<string | null>(null); const [opnameSessionId, setOpnameSessionId] = useState<string | null>(null); const [showRawScans, setShowRawScans] = useState(false);
  const [sessTitle, setSessTitle] = useState('Opname Bulanan Oktober 2026');
  const [sessBranch, setSessBranch] = useState('KWSN');
  const [sessRacks, setSessRacks] = useState<string[]>(['KWSN-A']);
  const [sessQr, setSessQr] = useState('');
  const [sessLevelScope, setSessLevelScope] = useState<Record<string, string[]> | null>(null);
  const [requestedVisualBranch, setRequestedVisualBranch] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => load('opname-sidebar-collapsed', false));
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mvProd, setMvProd] = useState('p1'); const [mvFromRack, setMvFromRack] = useState('KWSN-A'); const [mvFromLevel, setMvFromLevel] = useState('Level 1'); const mvOriginBranch = racks.find(r => r.id === mvFromRack)?.branchId || ''; const [mvSearch, setMvSearch] = useState(() => { const pr = products.find(x => x.id === 'p1'); return pr ? `${pr.name} — ${pr.variant} (${pr.sku}) • ${branchIdOfProduct(pr)}` : ''; }); const [mvSuggestOpen, setMvSuggestOpen] = useState(false); const mvSuggestions = mvSearch.trim() === '' ? [] : products.filter(pr => (mvOriginBranch === '' || branchIdOfProduct(pr) === mvOriginBranch) && matchesQuery(pr, mvSearch)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 8);
  const [mvToRack, setMvToRack] = useState('KWSN-B'); const [mvToLevel, setMvToLevel] = useState('Level 1'); const [mvQty, setMvQty] = useState(1); const [mvReason, setMvReason] = useState('Penataan Ulang');
  const [mvPhoto, setMvPhoto] = useState('');
  useEffect(() => { save('opname-user', user); }, [user]);
  useEffect(() => { save('opname-theme', theme); }, [theme]);
  useEffect(() => { save('opname-products', products); }, [products]);
  useEffect(() => { save('opname-external-totals', externalTotals); }, [externalTotals]);
  useEffect(() => { save('opname-inox-mode', inoxMode); }, [inoxMode]);
  useEffect(() => { save('opname-racks', racks); }, [racks]);
  useEffect(() => { save('opname-stock', stock); }, [stock]);
  useEffect(() => { save('opname-sessions', sessions); }, [sessions]);
  useEffect(() => { save('opname-moves', moves); }, [moves]);
  useEffect(() => { save('opname-lastSync-real', lastSync); }, [lastSync]);
  useEffect(() => { save('opname-last-sync-report', lastSyncReport); }, [lastSyncReport]);
  useEffect(() => { save('opname-accounts', accounts); }, [accounts]);
  useEffect(() => { save('opname-sidebar-collapsed', sidebarCollapsed); }, [sidebarCollapsed]);
  useEffect(() => { save('opname-inox-user', inoxUser); if (inoxMode !== 'local') save('opname-inox-connected-real', inoxConnected); }, [inoxUser, inoxConnected, inoxMode]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { // Cabang auto-aktif: cabang baru dari data sync langsung dibuatkan rak defaultnya.
    const missing = allBranches.filter(b => !racks.some(r => r.branchId === b.id));
    if (missing.length === 0) return;
    setRacks(prev => {
      const out = [...prev];
      for (const b of missing) {
        if (out.some(r => r.branchId === b.id)) continue;
        out.push({ id: `${b.id}-A`, branchId: b.id, name: 'Rak A', type: 'normal', levels: ['Level 1', 'Level 2', 'Level 3'], x: 20, y: 20, w: 160, h: 90, rot: 0 });
        out.push({ id: `${b.id}-B`, branchId: b.id, name: 'Rak B', type: 'normal', levels: ['Level 1', 'Level 2'], x: 200, y: 20, w: 160, h: 90, rot: 0 });
        out.push({ id: `${b.id}-RETUR`, branchId: b.id, name: 'RAK RETUR', type: 'retur', levels: ['Retur Customer', 'Retur Supplier', 'Rusak / QC'], x: 20, y: 140, w: 160, h: 90, rot: 0 });
      }
      return out;
    });
  }, [allBranches]);
  useEffect(() => { // Supabase data layer: load racks when configured; otherwise demo fallback stays.
    if (!isSupabaseConfigured) return;
    loadRacksFromSupabase().then(rows => { if (rows && rows.length > 0) setRacks(rows); }).catch(() => {});
  }, []);
  const visibleBranches = useMemo(() => {
    if (user?.role === 'super') return allBranches;
    const mine = allBranches.filter(b => b.id === user?.branchId);
    if (mine.length > 0) return mine;
    if (user?.branchId) return [{ id: user.branchId, name: user.branchId, location_id: 0, location_name: user.branchId }];
    return [];
  }, [user, allBranches]);
  const branchIds = branchFilter === 'Semua' ? visibleBranches.map(b => b.id) : [branchFilter];
  const visibleRacks = racks.filter(r => branchIds.includes(r.branchId));
  const visibleProducts = products.filter(p => { const bid = branchIdOfProduct(p); const allowed = user?.role === 'super' ? allBranches.map(b => b.id) : user?.branchId ? [user.branchId] : []; if (!allowed.includes(bid)) return false; if (branchFilter !== 'Semua' && bid !== branchFilter) return false; return true; });
  const filteredProducts = visibleProducts.filter(p => matchesQuery(p, search));
  const activeSession = sessions.find(s => s.id === activeSessionId) || null;
  const stockAt = (pid: string, rid: string, lv: string) => stock[`${pid}|${rid}|${lv}`] || 0;
  const stokInRacks = (p: Product) => { const bid = branchIdOfProduct(p); return racks.filter(r => r.branchId === bid).reduce((a, r) => a + r.levels.reduce((b, lv) => b + stockAt(p.id, r.id, lv), 0), 0); };
  const stokCategories = [...new Set(products.map(p => p.category))].sort();
  const stokBranchCounts: Record<string, number> = {}; filteredProducts.forEach(p => { const bid = branchIdOfProduct(p); stokBranchCounts[bid] = (stokBranchCounts[bid] || 0) + 1; });
  const stokFiltered = filteredProducts.filter(p => {
    if (stokBranch !== 'Semua' && branchIdOfProduct(p) !== stokBranch) return false;
    if (stokCategory !== 'Semua' && p.category !== stokCategory) return false;
    if (stokStock === 'diRak' && stokInRacks(p) <= 0) return false;
    if (stokStock === 'belum' && !(stock[`${p.id}|${branchIdOfProduct(p)}|BELUM`] || 0)) return false;
    if (stokStock === 'nolRak' && stokInRacks(p) !== 0) return false;
    return true;
  });
  const stokPageClamped = Math.min(stokPage, totalPagesFor(stokFiltered.length, stokPageSize));
  const stokPageItems = paginate(stokFiltered, stokPageClamped, stokPageSize);
  const lapPageClamped = Math.min(lapPage, totalPagesFor(sessions.length, lapPageSize));
  const lapPageItems = paginate(sessions, lapPageClamped, lapPageSize);
  const rackStockTotal = (rid: string) => products.reduce((a, p) => a + (racks.find(r => r.id === rid)?.levels || []).reduce((b, lv) => b + stockAt(p.id, rid, lv), 0), 0);
  function goView(v: View) { setView(v); setMobileSidebarOpen(false); }
  function doLogin() { const acc = accounts.find(a => a.email.toLowerCase() === loginEmail.trim().toLowerCase()); if (acc) { setUser({ email: acc.email, name: acc.name, role: acc.role, branchId: acc.branchId }); setBranchFilter(acc.branchId || 'Semua'); if (acc.branchId) { setSessBranch(acc.branchId); const firstRack = racks.find(r => r.branchId === acc.branchId); setSessRacks(firstRack ? [firstRack.id] : []); } } else alert('Akun tidak ditemukan. Minta Super Admin membuatnya di menu Kelola Akun, atau pakai super@opname (password bebas, demo lokal).'); }
  function importInoxRows(rows: any[]): { added: number; updated: number; skipped: number; cleaned: number } {
    const TEMPLATE_ONLY = ['LCD', 'BATT', 'BG/HS1', 'BG/HS2', 'CAM', 'S/B', 'FLX', 'CNC', 'TMP', 'FCID', 'TS', 'ADP', 'KBL'];
    const isTemplateOnly = (v: string) => v === '-' || TEMPLATE_ONLY.includes(v.toUpperCase());
    let added = 0, updated = 0, skipped = 0;
    const newProducts = [...products];
    const newStock = { ...stock };
    const newExternal: Record<string, { stock: number; at: number }> = { ...externalTotals };
    const now = Date.now();
    for (const r of rows) {
      if (!r) { skipped++; continue; }
      // Lokasi: pakai location_id bila ada, kalau tidak turunkan dari nama lokasi.
      let locId = typeof r.location_id === 'number' ? r.location_id : null;
      if (locId === null && typeof r.location === 'string') {
        const up = r.location.toUpperCase();
        const found = BRANCHES.find(b => up.includes(b.location_name.toUpperCase()) || up.includes(b.id));
        if (found) locId = found.location_id;
      }
      if (locId === null || !r.sku) { skipped++; continue; }
      const varStr = String(r.variation || '-');
      const hasIds = typeof r.product_id === 'number' && typeof r.variation_id === 'number';
      // Kunci cadangan bila feed tidak membawa ID (baris array DataTables):
      // SKU + varian + lokasi sudah unik per cabang dalam praktik iNOX.
      const branch = BRANCHES.find(b => b.location_id === locId);
      const idx = hasIds
        ? newProducts.findIndex(pr => pr.product_id === r.product_id && pr.variation_id === r.variation_id && pr.location_id === locId)
        : (() => { const bySkuLoc = (pred: (pr: Product) => boolean) => newProducts.findIndex(pr => pr.sku === String(r.sku) && pr.location_id === locId && pred(pr)); const direct = bySkuLoc(pr => pr.variant === varStr); if (direct !== -1) return direct; const byAfter = bySkuLoc(pr => { const i = pr.variant.indexOf('-'); return i >= 0 && pr.variant.slice(i + 1).trim() === varStr; }); if (byAfter !== -1) return byAfter; const afterNew = variantAfterDash(varStr); if (afterNew) { const byShort = bySkuLoc(pr => pr.variant === afterNew); if (byShort !== -1) return byShort; const byShortToken = bySkuLoc(pr => pr.variant === afterNew.split(/\s+/)[0]); if (byShortToken !== -1) return byShortToken; } const firstToken = varStr.split(/\s+/)[0]; if (firstToken && firstToken !== varStr) { const byToken = bySkuLoc(pr => pr.variant === firstToken || (pr.variant.indexOf('-') >= 0 && pr.variant.slice(pr.variant.indexOf('-') + 1).trim() === firstToken)); if (byToken !== -1) return byToken; } const byTemplate = bySkuLoc(pr => isTemplateOnly(pr.variant)); if (byTemplate !== -1) return byTemplate; return -1; })();
      let internalId: string;
      if (idx === -1) {
        const safe = (x: string) => String(x).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'X';
        internalId = hasIds ? `inox-${r.product_id}-${r.variation_id}-${locId}` : `inox-${safe(r.sku)}-${safe(varStr)}-${locId}`;
        newProducts.push({ id: internalId, sku: String(r.sku || ''), name: String(r.product || ''), variant: varStr, category: String(r.category || ''), price: Number(r.unit_price) || 0, product_id: hasIds ? r.product_id : 0, variation_id: hasIds ? r.variation_id : 0, location_id: locId, barcode: String(r.sku || ''), location_name: String(r.location || '') });
        if (branch) newStock[`${internalId}|${branch.id}|BELUM`] = Number(r.stock) || 0;
        added++;
      } else {
        internalId = newProducts[idx].id;
        const old = newProducts[idx];
        if (old.name !== String(r.product || '') || old.variant !== varStr || old.category !== String(r.category || '') || old.price !== (Number(r.unit_price) || 0) || old.sku !== String(r.sku || '') || (old.location_name || '') !== String(r.location || '')) {
          newProducts[idx] = { ...old, name: String(r.product || old.name), variant: varStr, category: String(r.category || old.category), price: Number(r.unit_price) || old.price, sku: String(r.sku || old.sku), barcode: String(r.sku || old.barcode), location_name: String(r.location || old.location_name || '') };
          updated++;
        }
      }
      // Total eksternal dicatat per produk internal DAN per kunci ID lama
      // (kompatibilitas dengan data sync lama) — keduanya menunjuk stok yang sama.
      newExternal[internalId] = { stock: Number(r.stock) || 0, at: now };
      if (hasIds) newExternal[`${r.product_id}|${r.variation_id}|${locId}`] = { stock: Number(r.stock) || 0, at: now };
    }
    let cleaned = 0;
    {
      const groups: Record<string, Product[]> = {};
      for (const pr of newProducts) { const k = `${pr.sku}|${pr.location_id}`; (groups[k] = groups[k] || []).push(pr); }
      const dropIds = new Set<string>();
      for (const arr of Object.values(groups)) {
        if (arr.length < 2) continue;
        const hasFull = arr.some(pr => pr.variant.includes('-'));
        if (!hasFull) continue;
        for (const pr of arr) if (!pr.variant.includes('-')) dropIds.add(pr.id);
      }
      if (dropIds.size > 0) {
        cleaned = dropIds.size;
        const kept = newProducts.filter(pr => !dropIds.has(pr.id));
        newProducts.length = 0; newProducts.push(...kept);
        for (const id of dropIds) {
          for (const k of Object.keys(newStock)) if (k.startsWith(`${id}|`)) delete newStock[k];
          delete newExternal[id];
        }
      }
    }
    setProducts(newProducts); setStock(newStock); setExternalTotals(newExternal);
    return { added, updated, skipped, cleaned };
  }
  async function testInoxLocal() {
    if (!inoxUser || !inoxPass) { alert('Mode Lokal Nyata: isi Username dan Password iNOX di Settings dulu (password hanya di memori sesi ini).'); return; }
    try {
      const res = await fetch('http://localhost:4001/api/inox/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: inoxUser, password: inoxPass }) });
      const data = await res.json().catch(() => ({ ok: false, error: 'Respons server lokal bukan JSON' }));
      if (!data.ok) { alert(`Uji koneksi nyata GAGAL: ${data.error || 'tidak diketahui'}${data.step ? ` (tahap: ${data.step})` : ''} — tidak ada status Terhubung yang dibuat.`); return; }
      setInoxConnected(true);
      setLcdSample({ total: data.sample_lcd_total ?? null, rows: Array.isArray(data.sample_lcd_raw) ? data.sample_lcd_raw : [] });
      const first = data.sample && data.sample[0] ? `${data.sample[0].product} — ${data.sample[0].variation} (${data.sample[0].sku}) stok ${data.sample[0].stock}` : '-';
      const rawLines = Array.isArray(data.sample_raw) ? data.sample_raw.map((r: any, i: number) => {
        if (Array.isArray(r)) return `Baris ${i + 1}: SKU=${r[0]} | Produk=${r[1]} | Varian mentah=${r[2]} | Kategori=${r[3]} | Lokasi=${r[4]}`;
        return `Baris ${i + 1}: ${JSON.stringify(r)}`;
      }).join('\n') : 'tidak tersedia (server lama — git pull dulu)';
      const lcdLines = Array.isArray(data.sample_lcd_raw) ? data.sample_lcd_raw.map((r: any, i: number) => {
        if (Array.isArray(r)) return `Baris LCD ${i + 1}: SKU=${r[0]} | Produk=${r[1]} | Varian mentah=${r[2]} | Kategori=${r[3]} | Lokasi=${r[4]}`;
        const keys = ['sku', 'product', 'product_variation', 'variation_name', 'variation', 'type', 'product_id', 'variation_id', 'location_name', 'location_id', 'product_custom_field1', 'product_custom_field2', 'product_custom_field3', 'product_custom_field4'];
        const sub: any = {}; for (const k of keys) if (r[k] !== undefined) sub[k] = r[k];
        return `Baris LCD ${i + 1}: ${JSON.stringify(sub)}`;
      }).join('\n') : 'tidak tersedia (server lama — git pull dulu)';
      alert(`Uji koneksi nyata BERHASIL: login ke iNOX diterima, feed Laporan Stok terbaca, recordsTotal = ${data.recordsTotal}. Contoh baris pertama: ${first}. Ini BUKAN demo — data ini benar-benar dari inox.my.id via server lokal.\n\nVarian MENTAH dari feed (belum diproses, untuk diagnosa):\n${rawLines}\n\nSampel LCD MENTAH dari feed (pencarian 'Lcd', total ${data.sample_lcd_total ?? '?'} baris, belum diproses):\n${lcdLines}\n\nYang menentukan adalah bagian Sampel LCD di atas: lihat product_variation DAN variation_name di tiap baris. Kalau keduanya hanya "LCD" (atau kosong), berarti feed sendiri tidak memberi grade — screenshot-kan pesan ini dan kirim ke pengembang.`);
    } catch (e) { alert('Server lokal tidak bisa dihubungi. Jalankan dulu di CMD kedua: npm run inox-server di folder Apname, tunggu sampai muncul "listening on http://localhost:4001", lalu coba lagi.'); }
  }
  async function doSync() {
    if (inoxMode === 'local') {
      if (!inoxUser || !inoxPass) { alert('Mode Lokal Nyata: isi Username dan Password iNOX di Settings dulu (password hanya di memori sesi ini).'); setView('settings'); return; }
      setSyncBusy(true);
      try {
        const res = await fetch('http://localhost:4001/api/inox/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: inoxUser, password: inoxPass }) });
        const data = await res.json().catch(() => ({ ok: false, error: 'Respons server lokal bukan JSON' }));
        if (!data.ok) { alert(`Sync nyata GAGAL: ${data.error || 'tidak diketahui'}${data.step ? ` (tahap: ${data.step})` : ''} — data lama tidak diubah.`); return; }
        const result = importInoxRows(data.rows || []);
        setLastSync(Date.now()); setInoxConnected(true);
        const lcdSet = new Set<string>(); for (const r of (data.rows || [])) { if (String(r.product || '').toUpperCase().includes('LCD') || String(r.variation || '').toUpperCase().includes('LCD')) { const g = String(r.variation || ''); if (g) lcdSet.add(g); } }
        const branchCountsSync: Record<string, number> = {}; for (const r of (data.rows || [])) { const loc = typeof r.location_id === 'number' ? r.location_id : null; const label = loc !== null ? branchLabelFor(loc, String(r.location || '')) : (typeof r.location === 'string' && r.location ? String(r.location).toUpperCase().replace(/[^A-Z0-9]+/g, '') || 'Lokasi tidak dikenali' : 'Lokasi tidak dikenali'); branchCountsSync[label] = (branchCountsSync[label] || 0) + 1; }
        setLastSyncReport({ at: Date.now(), recordsTotal: data.recordsTotal, fetched: (data.rows || []).length, added: result.added, updated: result.updated, skipped: result.skipped, branchSummary: Object.entries(branchCountsSync).map(([k, v]) => `${k}: ${v}`).join(', ') || '—', lcdVariants: [...lcdSet].sort() });
        const branchSummary = (() => { const counts: Record<string, number> = {}; for (const r of (data.rows || [])) { const loc = typeof r.location_id === 'number' ? r.location_id : null; const label = loc !== null ? branchLabelFor(loc, String(r.location || '')) : (typeof r.location === 'string' && r.location ? String(r.location).toUpperCase().replace(/[^A-Z0-9]+/g, '') || 'Lokasi tidak dikenali' : 'Lokasi tidak dikenali'); counts[label] = (counts[label] || 0) + 1; } return Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ') || '—'; })(); alert(`Sync nyata BERHASIL: ${data.recordsTotal} baris dari iNOX, terkumpul ${(data.rows || []).length}. Per cabang di feed: ${branchSummary}. Produk baru: ${result.added}, master diperbarui: ${result.updated}, dilewati (tanpa SKU/varian/lokasi): ${result.skipped}. Stok per rak TIDAK diubah — produk baru masuk Belum Ditempatkan, produk lama hanya master-nya diperbarui. Total eksternal per produk bisa dilihat di Stok & Master.${result.added === 0 && result.updated === 0 ? ' PERINGATAN: tidak ada produk yang masuk sama sekali — kemungkinan format feed berubah; kirim pesan ini + jumlah dilewati ke pengembang.' : ''} Kalau di Stok & Master masih hanya KWSN, cek filter cabang di atas tabel (tombol cabang) dan filter cabang di header — akun Admin/Karyawan hanya bisa melihat cabangnya sendiri, login Super Admin untuk semua cabang.`);
      } catch (e) { alert('Server lokal tidak bisa dihubungi. Jalankan dulu di CMD kedua: npm run inox-server di folder Apname, tunggu sampai muncul "listening on http://localhost:4001", lalu coba lagi.'); }
      finally { setSyncBusy(false); }
      return;
    }
    alert('Mode Demo: sync nyata ke inox.my.id tidak aktif di mode ini. Versi demo tidak memanggil inox.my.id sama sekali, jadi tidak ada data iNOX yang ditarik dan tidak ada validasi akun. Untuk sync nyata, ubah Mode di Settings menjadi Lokal Nyata dan jalankan server lokal. Data yang tampil saat ini masih data contoh lokal.');
    setView('settings');
  }
  function toggleSessLevel(rid: string, lv: string) { setSessLevelScope(prev => { if (!prev) return { [rid]: [lv] }; const cur = prev[rid] || []; const next = cur.includes(lv) ? cur.filter(x => x !== lv) : [...cur, lv]; const nextScope = { ...prev }; if (next.length === 0) delete nextScope[rid]; else nextScope[rid] = next; if (Object.keys(nextScope).length === 0) return prev; return nextScope; }); }
  function createSession() {
    if (!inoxConnected && !confirm('Belum ada sync nyata ke iNOX (versi demo). Lanjutkan dengan data contoh lokal? Data ini BUKAN data iNOX nyata.')) return;
    const snap: Record<string, number> = {};
    for (const pid of products.filter(pr => branchIdOfProduct(pr) === sessBranch).map(pr => pr.id)) for (const rid of sessRacks) {
      const rk = racks.find(r => r.id === rid); if (!rk) continue;
      const lvs = sessLevelScope?.[rid] || rk.levels;
      for (const lv of lvs) snap[`${pid}|${rid}|${lv}`] = stockAt(pid, rid, lv);
    }
    const s: Session = { id: 'OP-' + String(sessions.length + 101), title: sessTitle, branchId: sessBranch, racks: sessRacks, scopeLevels: sessLevelScope || undefined, status: 'Berjalan', createdAt: Date.now(), createdBy: user?.name || '-', lockedAt: null, snapshot: snap, scans: [], mutations: [], adjustmentStatus: 'Menunggu', externalAt: lastSync };
    setSessions(prev => [s, ...prev]); setActiveSessionId(s.id); setView('opname'); setSessLevelScope(null);
    alert(`Sesi ${s.id} dibuat. Snapshot dibekukan${s.scopeLevels ? ' hanya untuk level dalam scope.' : '.'}`);
  }
  function addScan(sess: Session, barcode: string, qty: number, mode: string, rackId: string, level: string) { const prod = products.find(p => (p.barcode === barcode || p.sku === barcode) && branchIdOfProduct(p) === sess.branchId) || products.find(p => p.barcode === barcode || p.sku === barcode); if (!prod) { alert('Barcode/SKU tidak ditemukan di master.'); return; } const row: ScanRow = { id: String(Date.now()) + Math.random().toString(36).slice(2), time: Date.now(), user: user?.name || '-', productId: prod.id, rackId, level, qty, mode, barcode }; setSessions(prev => prev.map(s => s.id === sess.id ? { ...s, scans: [row, ...s.scans] } : s)); }
  function deleteScan(sess: Session, scanId: string) { setSessions(prev => prev.map(x => x.id === sess.id ? { ...x, scans: x.scans.filter(sc => sc.id !== scanId) } : x)); }
  function deleteSession(sess: Session) {
    // Hanya Super Admin. Scan, mutasi, dan snapshot hidup DI DALAM objek sesi
    // (localStorage opname-sessions), jadi menghapus sesi = menghapus ketiganya
    // sekaligus. Pindah Produk terpisah (opname-moves, tanpa sessionId) tidak ikut terhapus.
    // Sesi yang sudah dikunci TIDAK mengembalikan stok: lockSession sudah menimpa
    // stok per rak/level, dan mengembalikannya ke snapshot akan merusak perubahan
    // sesi/pindah sesudahnya — jadi di sini hanya dihapus sesinya, dengan peringatan eksplisit.
    if (user?.role !== 'super') { alert('Hanya Super Admin yang boleh menghapus sesi opname.'); return; }
    const lockedNote = sess.status === 'Selesai' ? ' PERHATIAN: sesi ini sudah dikunci — stok per rak/level yang sudah diperbarui TIDAK otomatis kembali, dan adjustment yang sudah disetujui/diterapkan di iNOX tidak dibatalkan.' : ' Sesi ini belum dikunci, jadi belum mengubah stok.';
    if (!confirm(`Hapus sesi ${sess.id} — ${sess.title} (${sess.branchId}, ${sess.scans.length} scan, ${(sess.mutations || []).length} mutasi)? Scan, mutasi, dan snapshot sesi ini hilang permanen dan tidak bisa dikembalikan.${lockedNote}`)) return;
    setSessions(prev => prev.filter(x => x.id !== sess.id));
    if (activeSessionId === sess.id) { setActiveSessionId(null); setShowPreview(false); }
    if (opnameSessionId === sess.id) setOpnameSessionId(null);
    if (reportSessionId === sess.id) setReportSessionId(null);
    if (aksiSessionId === sess.id) setAksiSessionId(null);
  }
  function addMutation(sess: Session, m: Omit<SessionMutation, 'id' | 'time' | 'user'>) { const row: SessionMutation = { ...m, id: String(Date.now()) + Math.random().toString(36).slice(2), time: Date.now(), user: user?.name || '-' }; setSessions(prev => prev.map(s => s.id === sess.id ? { ...s, mutations: [row, ...s.mutations] } : s)); }
  function lockSession(sess: Session) { const next = { ...stock }; const grouped: Record<string, number> = {}; for (const sc of sess.scans.filter(x => inSessionScope(sess, x.rackId, x.level))) grouped[`${sc.productId}|${sc.rackId}|${sc.level}`] = (grouped[`${sc.productId}|${sc.rackId}|${sc.level}`] || 0) + sc.qty; for (const [k, v] of Object.entries(grouped)) next[k] = v; setStock(next); setSessions(prev => prev.map(s => s.id === sess.id ? { ...s, status: 'Selesai', lockedAt: Date.now() } : s)); setShowPreview(false); alert(`Sesi ${sess.id} dikunci. Stok per rak/level diperbarui. Adjustment untuk iNOX bisa diunduh dari Laporan setelah disetujui.`); }
  function approveAdjustment(sess: Session) { setSessions(prev => prev.map(s => s.id === sess.id ? { ...s, adjustmentStatus: 'Disetujui' } : s)); }
  function doMove() {
    if (!mvProd) { alert('Pilih produk dari saran dulu — ketik nama/SKU/varian lalu klik saran yang muncul. Ketik bebas saja tidak akan tersimpan.'); return; }
    const fk = `${mvProd}|${mvFromRack}|${mvFromLevel}`; const tk = `${mvProd}|${mvToRack}|${mvToLevel}`;
    if (fk === tk) { alert('Rak dan level tujuan sama dengan asal.'); return; }
    if ((stock[fk] || 0) < mvQty) { alert(`Stok di level asal tidak cukup. Tersedia: ${stock[fk] || 0}`); return; }
    setStock(prev => ({ ...prev, [fk]: (prev[fk] || 0) - mvQty, [tk]: (prev[tk] || 0) + mvQty }));
    setMoves(prev => [{ id: String(Date.now()), time: Date.now(), user: user?.name || '-', productId: mvProd, fromRack: mvFromRack, fromLevel: mvFromLevel, toRack: mvToRack, toLevel: mvToLevel, qty: mvQty, reason: mvReason, photo: mvPhoto }, ...prev]);
    setMvPhoto('');
    alert(`Pindah berhasil: ${mvQty} unit dari ${mvFromRack} ${mvFromLevel} → ${mvToRack} ${mvToLevel}. Total cabang tidak berubah.`);
  }
  // --- Rack CRUD (per-id, never replacing the full rack list with a filtered subset) ---
  function updateRack(id: string, patch: Partial<Rack>) { setRacks(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r)); }
  function addRack(branchId: string, name: string, type: 'normal' | 'retur', levels: string[], w: number, h: number) {
    const cleanLevels = levels.map(l => l.trim()).filter(Boolean);
    if (!name.trim() || cleanLevels.length === 0) { alert('Nama rak dan minimal 1 level wajib diisi.'); return; }
    const existing = racks.filter(r => r.branchId === branchId);
    let pos = { x: 20, y: 20 }; let found = false;
    for (let row = 0; row < 10 && !found; row++) for (let col = 0; col < 3 && !found; col++) {
      const cand = { x: 20 + col * 180, y: 20 + row * 120 };
      if (!existing.some(r => r.x === cand.x && r.y === cand.y)) { pos = cand; found = true; }
    }
    const base = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'RAK';
    let rid = `${branchId}-${base}`; let n = 2; while (racks.some(r => r.id === rid)) rid = `${branchId}-${base}-${n++}`;
    setRacks(prev => [...prev, { id: rid, branchId, name: name.trim(), type, levels: cleanLevels, x: pos.x, y: pos.y, w, h, rot: 0 }]);
    alert(`Rak ${name.trim()} dibuat (${rid}) di posisi ${pos.x}, ${pos.y}.`);
  }
  function renameLevel(rackId: string, oldLevel: string, newLevel: string): string {
    const trimmed = newLevel.trim(); if (!trimmed) return 'Nama level tidak boleh kosong.';
    const rk = racks.find(r => r.id === rackId); if (!rk) return 'Rak tidak ditemukan.';
    if (trimmed !== oldLevel && rk.levels.includes(trimmed)) return 'Nama level itu sudah ada di rak ini.';
    if (trimmed === oldLevel) return 'OK';
    setRacks(prev => prev.map(r => r.id === rackId ? { ...r, levels: r.levels.map(l => l === oldLevel ? trimmed : l) } : r));
    setStock(prev => { const next = { ...prev }; for (const k of Object.keys(next)) { const parts = k.split('|'); if (parts.length === 3 && parts[1] === rackId && parts[2] === oldLevel) { const nk = `${parts[0]}|${rackId}|${trimmed}`; next[nk] = (next[nk] || 0) + next[k]; delete next[k]; } } return next; });
    return 'OK';
  }
  function deleteLevel(rackId: string, level: string): string {
    const total = products.reduce((a, p) => a + stockAt(p.id, rackId, level), 0);
    if (total > 0) return `Level ${level} tidak bisa dihapus: stok masih ${total} unit. Pindahkan dulu lewat Pindah Produk.`;
    const rk = racks.find(r => r.id === rackId); if (!rk) return 'Rak tidak ditemukan.';
    if (rk.levels.length <= 1) return 'Rak harus punya minimal 1 level.';
    setRacks(prev => prev.map(r => r.id === rackId ? { ...r, levels: r.levels.filter(l => l !== level) } : r));
    return 'OK';
  }
  function deleteRack(rackId: string): string {
    const total = rackStockTotal(rackId);
    if (total > 0) return `Rak tidak bisa dihapus: stok masih ${total} unit. Pindahkan dulu lewat Pindah Produk.`;
    setRacks(prev => prev.filter(r => r.id !== rackId));
    return 'OK';
  }
  function exportCSV(sess: Session | null) { const rows = sess ? sess.scans : []; const head = 'Waktu Scan,Petugas,SKU,Produk,Varian,Rak,Level,Jumlah,Mode,Barcode\n'; const body = rows.map(r => { const p = products.find(x => x.id === r.productId); return [fmtShort(r.time), r.user, p?.sku || '', p?.name || '', p?.variant || '', r.rackId, r.level, r.qty, r.mode, r.barcode].join(','); }).join('\n'); downloadBlob(new Blob([head + body], { type: 'text/csv' }), `Opname-${sess?.id || 'daftar'}.csv`); }
  function previewRows(sess: Session) {
    // SCAN-DRIVEN: satu baris hanya bila produk itu BENAR-BENAR discan di sesi ini (dalam scope).
    // Snapshot TIDAK lagi membuat baris — snapshot hanya dipakai untuk angka sys pada baris hasil scan.
    // Akibatnya: pratinjau, Excel Detail, PDF isi laporan, dan Adjustment HANYA berisi hasil scan.
    // Produk yang belum discan tidak tampil di tabel utama, karena fisiknya belum diketahui (bukan 0).
    const rows: { pid: string; rid: string; lv: string; sys: number; mutIn: number; mutOut: number; adjusted: number; fis: number; diff: number; scanned: boolean; last?: ScanRow; p?: Product }[] = [];
    const scanGroups: Record<string, { pid: string; rid: string; lv: string; scans: ScanRow[] }> = {};
    for (const sc of sess.scans) {
      if (!inSessionScope(sess, sc.rackId, sc.level)) continue;
      const key = `${sc.productId}|${sc.rackId}|${sc.level}`;
      if (!scanGroups[key]) scanGroups[key] = { pid: sc.productId, rid: sc.rackId, lv: sc.level, scans: [] };
      scanGroups[key].scans.push(sc);
    }
    for (const g of Object.values(scanGroups)) {
      const sys = sess.snapshot[`${g.pid}|${g.rid}|${g.lv}`] || 0;
      const fis = g.scans.reduce((a, sc) => a + sc.qty, 0);
      const mutIn = (sess.mutations || []).filter(m => m.productId === g.pid && m.direction === 'Masuk' && (!m.rackId || m.rackId === g.rid)).reduce((a, m) => a + m.qty, 0);
      const mutOut = (sess.mutations || []).filter(m => m.productId === g.pid && m.direction === 'Keluar' && (!m.rackId || m.rackId === g.rid)).reduce((a, m) => a + m.qty, 0);
      const adjusted = sys + mutIn - mutOut;
      const last = [...g.scans].sort((a, b) => b.time - a.time)[0];
      rows.push({ pid: g.pid, rid: g.rid, lv: g.lv, sys, mutIn, mutOut, adjusted, fis, diff: fis - adjusted, scanned: true, last, p: products.find(x => x.id === g.pid) });
    }
    return rows;
  }
  function unscannedExpected(sess: Session) {
    // Daftar CEK TERPISAH, bukan bagian pratinjau: produk yang diharapkan ada
    // (snapshot + mutasi != 0) tapi belum discan di sesi ini. Sengaja TIDAK masuk
    // total baris, akurasi, Excel Detail, PDF, maupun Adjustment — karena fisiknya
    // belum diketahui, bukan 0. Kalau daftar ini ikut adjustment, barang yang cuma
    // belum discan akan salah ter-adjust jadi 0.
    const scannedKeys = new Set(sess.scans.filter(sc => inSessionScope(sess, sc.rackId, sc.level)).map(sc => `${sc.productId}|${sc.rackId}|${sc.level}`));
    const out: { pid: string; rid: string; lv: string; sys: number; mutIn: number; mutOut: number; adjusted: number; p?: Product }[] = [];
    for (const [k, sys] of Object.entries(sess.snapshot)) {
      const [pid, rid, lv] = k.split('|');
      if (!inSessionScope(sess, rid, lv)) continue;
      if (scannedKeys.has(k)) continue;
      const mutIn = (sess.mutations || []).filter(m => m.productId === pid && m.direction === 'Masuk' && (!m.rackId || m.rackId === rid)).reduce((a, m) => a + m.qty, 0);
      const mutOut = (sess.mutations || []).filter(m => m.productId === pid && m.direction === 'Keluar' && (!m.rackId || m.rackId === rid)).reduce((a, m) => a + m.qty, 0);
      const adjusted = sys + mutIn - mutOut;
      if (adjusted === 0) continue;
      out.push({ pid, rid, lv, sys, mutIn, mutOut, adjusted, p: products.find(x => x.id === pid) });
    }
    return out;
  }
  async function exportExcel(sess: Session) {
    // Lazy-loaded so ExcelJS does not inflate the initial bundle.
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook(); wb.creator = 'Apname';
    const rows = previewRows(sess);
    const sum = wb.addWorksheet('Ringkasan');
    sum.addRow(['Laporan Opname', sess.id]); sum.addRow(['Judul', sess.title]); sum.addRow(['Cabang', sess.branchId]); sum.addRow(['Scope', scopeLabel(sess)]);
    sum.addRow(['Dibuat', new Date(sess.createdAt)]); sum.getCell('B5').numFmt = 'dd mmm yyyy hh:mm:ss';
    sum.addRow(['Dikunci', sess.lockedAt ? new Date(sess.lockedAt) : 'Belum dikunci']); if (sess.lockedAt) sum.getCell('B6').numFmt = 'dd mmm yyyy hh:mm:ss';
    sum.addRow(['Sync saat sesi dibuat', sess.externalAt ? new Date(sess.externalAt) : '—']); if (sess.externalAt) sum.getCell('B7').numFmt = 'dd mmm yyyy hh:mm:ss';
    sum.addRow(['Total baris hasil scan', rows.length]); sum.addRow(['Cocok', rows.filter(r => r.scanned && r.diff === 0).length]); sum.addRow(['Lebih', rows.filter(r => r.scanned && r.diff > 0).length]); sum.addRow(['Kurang', rows.filter(r => r.scanned && r.diff < 0).length]); sum.addRow(['Belum dihitung (tidak discan — tidak masuk Detail)', unscannedExpected(sess).length]);
    const det = wb.addWorksheet('Detail Opname');
    det.addRow(['Produk', 'Varian', 'SKU', 'Rak', 'Level', 'Stok Snapshot', 'Mutasi Masuk', 'Mutasi Keluar', 'Stok Sistem Disesuaikan', 'Fisik', 'Selisih Akhir', 'Waktu Scan Pertama', 'Waktu Scan Terakhir', 'Waktu Verifikasi']);
    rows.forEach(r => {
      const scans = sess.scans.filter(s => s.productId === r.pid && s.rackId === r.rid && s.level === r.lv).sort((a, b) => a.time - b.time);
      const row = det.addRow([r.p?.name || '', r.p?.variant || '', r.p?.sku || '', r.rid, r.lv, r.sys, r.mutIn, r.mutOut, r.adjusted, r.fis, r.diff, scans[0] ? new Date(scans[0].time) : '', scans[scans.length - 1] ? new Date(scans[scans.length - 1].time) : '', '']);
      [12, 13].forEach(c => { row.getCell(c).numFmt = 'dd mmm yyyy hh:mm:ss'; });
    });
    const sel = wb.addWorksheet('Selisih Saja');
    sel.addRow(['Produk', 'Varian', 'SKU', 'Rak', 'Level', 'Stok Sistem Disesuaikan', 'Fisik', 'Selisih Akhir', 'Waktu Scan Terakhir']);
    rows.filter(r => r.scanned && r.diff !== 0).forEach(r => {
      const last = r.last ? new Date(r.last.time) : '';
      const row = sel.addRow([r.p?.name || '', r.p?.variant || '', r.p?.sku || '', r.rid, r.lv, r.adjusted, r.fis, r.diff, last]);
      row.getCell(9).numFmt = 'dd mmm yyyy hh:mm:ss';
    });
    const unc = wb.addWorksheet('Belum Dihitung (Cek)');
    unc.addRow(['Produk', 'Varian', 'SKU', 'Rak', 'Level', 'Stok Snapshot', 'Mutasi Masuk', 'Mutasi Keluar', 'Stok Disesuaikan']);
    unscannedExpected(sess).forEach(u => { unc.addRow([u.p?.name || '', u.p?.variant || '', u.p?.sku || '', u.rid, u.lv, u.sys, u.mutIn, u.mutOut, u.adjusted]); });
    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `Opname-${sess.id}.xlsx`);
  }
  function exportAdjustment(sess: Session) {
    if (sess.adjustmentStatus !== 'Disetujui') { alert('Adjustment belum disetujui. Tekan "Setujui Adjustment" dulu sebelum export.'); return; }
    const head = 'SKU,Varian,Selisih Qty,Alasan,Nomor Sesi,Tanggal\n';
    const body = previewRows(sess).map(r => `${r.p?.sku || ''},${r.p?.variant || ''},${r.diff},Opname,${sess.id},${fmtShort(sess.lockedAt || Date.now())}`).join('\n');
    downloadBlob(new Blob([head + body], { type: 'text/csv' }), `Adjustment-iNOX-${sess.id}.csv`);
  }
  function printReportFor(sess: Session) {
    const rows: ReportRow[] = previewRows(sess).map(r => ({ name: r.p?.name || '', variant: r.p?.variant || '', sku: r.p?.sku || '', rackId: r.rid, level: r.lv, sys: r.sys, mutIn: r.mutIn, mutOut: r.mutOut, adjusted: r.adjusted, fis: r.fis, diff: r.diff, scanned: r.scanned, lastScan: r.last ? fmtShort(r.last.time) : '—' }));
    const pr = previewRows(sess);
    printReport({ id: sess.id, title: sess.title, branchId: sess.branchId, scope: scopeLabel(sess), created: fmtShort(sess.createdAt), locked: sess.lockedAt ? fmtShort(sess.lockedAt) : 'Belum dikunci', totalRows: pr.length, cocok: pr.filter(r => r.scanned && r.diff === 0).length, lebih: pr.filter(r => r.scanned && r.diff > 0).length, kurang: pr.filter(r => r.scanned && r.diff < 0).length, belum: unscannedExpected(sess).length, scanCount: sess.scans.length }, rows);
  }
  if (!user) return (<div data-theme={theme} className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground"><Card className="w-full max-w-md"><CardHeader><CardTitle className="text-2xl">Opname Per Rak</CardTitle><CardDescription>Login demo lokal — pilih akun yang sudah dibuat di Kelola Akun (oleh Super Admin), password bebas di mode demo. Akun baru untuk cabang lain dibuat setelah login sebagai Super Admin.</CardDescription></CardHeader><CardContent className="space-y-4"><div><label className="text-sm font-medium">Email akun</label><Input className="mt-1" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} /></div><div className="flex flex-wrap gap-2">{accounts.map(a => <Button key={a.email} variant="outline" size="sm" onClick={() => setLoginEmail(a.email)}>{a.email} ({a.role === 'super' ? 'Super' : a.role === 'admin' ? `Admin ${a.branchId}` : `Karyawan ${a.branchId}`})</Button>)}</div><Button className="w-full" onClick={doLogin}>Masuk</Button></CardContent></Card></div>);
  const syncAgeMin = lastSync ? (now - lastSync) / 60000 : 9999;
  const syncVariant = !inoxConnected ? 'destructive' : syncAgeMin < 15 ? 'default' : syncAgeMin < 60 ? 'secondary' : 'destructive';
  return (<div data-theme={theme} className="min-h-screen bg-background text-foreground">
    <div className="flex">
      {/* Desktop sidebar: shadcn-admin pattern (header / content / footer) */}
      <div className="sticky top-0 hidden h-screen shrink-0 md:block" style={{ width: sidebarCollapsed ? 64 : 240 }}>
        <AppSidebar items={NAV_ITEMS.filter(it => it.id !== 'akun' || user.role === 'super')} view={view} onSelect={(id) => goView(id as View)} collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed(v => !v)} userName={user.name} userRole={user.role} className="w-full" />
      </div>
      {/* Mobile drawer */}
      {mobileSidebarOpen && (<div className="fixed inset-0 z-50 md:hidden"><button aria-label="Tutup menu" className="absolute inset-0 bg-black/50" onClick={() => setMobileSidebarOpen(false)} /><div className="absolute inset-y-0 left-0 w-72"><AppSidebar items={NAV_ITEMS.filter(it => it.id !== 'akun' || user.role === 'super')} view={view} onSelect={(id) => goView(id as View)} collapsed={false} onToggleCollapse={() => setSidebarCollapsed(v => !v)} onCloseMobile={() => setMobileSidebarOpen(false)} userName={user.name} userRole={user.role} className="w-full" /></div></div>)}
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b bg-card px-4 py-3">
          <Button variant="ghost" size="icon" aria-label="Buka menu" className="md:hidden" onClick={() => setMobileSidebarOpen(true)}><Menu className="size-4" /></Button>
          <div><b>📦 Opname Per Rak</b> <Badge variant="secondary">{user.name} • {user.role}</Badge>{isSupabaseConfigured && <Badge className="ml-1">Supabase aktif</Badge>}</div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="w-[140px]"><Select value={theme} onValueChange={setTheme}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{THEMES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select></div>
            <div className="w-[160px]"><Select value={branchFilter} onValueChange={setBranchFilter}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="Semua">Semua Cabang</SelectItem>{visibleBranches.map(b => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent></Select></div>
            <Button variant="outline" onClick={() => setUser(null)}>Logout</Button>
          </div>
        </header>
        <main className="mx-auto max-w-7xl p-4">
          <Card className="mb-4"><CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6"><div><Badge variant={syncVariant}>● Status Sync iNOX</Badge> <span className="text-sm">{inoxConnected && lastSync ? <>Terakhir sync nyata: {fmtWita(lastSync)} — sudah {elapsedSince(lastSync, now)}</> : 'Belum pernah sync nyata ke iNOX (versi demo)'} {inoxConnected ? <Badge className="ml-1">Terhubung nyata: {inoxUser}</Badge> : <Badge variant="outline" className="ml-1">Mode demo — belum terhubung nyata</Badge>}</span></div><Button variant="default" onClick={doSync} disabled={syncBusy}><RefreshCw className="size-4" /> {syncBusy ? "Sync Nyata Berjalan…" : inoxMode === 'local' ? "Sync Sekarang (dari inox.my.id)" : "Sync Sekarang (aktifkan Mode Lokal Nyata dulu)"}</Button></CardContent></Card>
          {view === 'dashboard' && (<><div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card><CardContent className="pt-6"><p className="text-sm text-muted-foreground">Produk (variasi-lokasi)</p><b className="text-2xl">{filteredProducts.length}</b></CardContent></Card>
            <Card><CardContent className="pt-6"><p className="text-sm text-muted-foreground">Total Rak</p><b className="text-2xl">{visibleRacks.length}</b></CardContent></Card>
            <Card><CardContent className="pt-6"><p className="text-sm text-muted-foreground">Sesi Berjalan</p><b className="text-2xl">{sessions.filter(s => s.status === 'Berjalan').length}</b></CardContent></Card>
            <Card><CardContent className="pt-6"><p className="text-sm text-muted-foreground">Sesi Selesai</p><b className="text-2xl">{sessions.filter(s => s.status === 'Selesai').length}</b></CardContent></Card>
          </div><Card className="mt-4"><CardHeader><CardTitle>Cara pakai cepat</CardTitle></CardHeader><CardContent><p className="text-sm">1) Pilih mode di Settings: Demo = data contoh lokal saja; Lokal Nyata = jalankan server lokal (npm run inox-server di CMD kedua) lalu Sync Nyata untuk data benar-benar dari inox.my.id. 2) Sesi Opname → pilih cabang, rak (atau 1 level) → Buat Sesi. 3) Di sesi, scan barcode (+1 atau isi jumlah) atau pakai Scan Kamera per rak/level. 4) Catat mutasi selama opname bila ada transaksi. 5) Pratinjau Mini Laporan → periksa → Kunci Sesi. 6) Laporan → export Excel (.xlsx) / CSV / Cetak PDF / Adjustment iNOX (setelah disetujui).</p><p className="mt-2 text-xs text-muted-foreground">Batasan demo: data masih localStorage bila Supabase belum dikonfigurasi, antrean scan offline belum ada — PWA di sini hanya cache shell aplikasi, dan sync/validasi iNOX di Settings adalah demo jujur (tidak ada panggilan nyata ke inox.my.id; login asal-asalan tidak lagi ditampilkan sebagai Terhubung).</p></CardContent></Card></>)}
          {view === 'stok' && (<><div className="mb-3 flex flex-wrap gap-2"><Input style={{ maxWidth: 320 }} placeholder="Cari nama / SKU / varian… (boleh multi-kata, mis. lcd iphone 13 bpt)" value={search} onChange={e => setSearch(e.target.value)} /></div><div className="mb-3 flex flex-wrap items-center gap-2 text-sm"><span className="font-medium">Cabang:</span><Button variant={stokBranch === 'Semua' ? 'default' : 'outline'} size="sm" onClick={() => { setStokBranch('Semua'); setStokPage(1); }}>Semua ({filteredProducts.length})</Button>{visibleBranches.map(b => <Button key={b.id} variant={stokBranch === b.id ? 'default' : 'outline'} size="sm" onClick={() => { setStokBranch(b.id); setStokPage(1); }}>{b.id} ({stokBranchCounts[b.id] || 0})</Button>)}</div><div className="mb-3 flex flex-wrap items-center gap-2 text-sm"><span className="font-medium">Kategori:</span><div className="w-[180px]"><Select value={stokCategory} onValueChange={(v) => { setStokCategory(v); setStokPage(1); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="Semua">Semua Kategori</SelectItem>{stokCategories.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select></div><span className="font-medium">Stok:</span>{([['semua', 'Semua'], ['diRak', 'Ada di rak'], ['belum', 'Ada Belum Ditempatkan'], ['nolRak', 'Nol di rak']] as const).map(([v, label]) => <Button key={v} variant={stokStock === v ? 'default' : 'outline'} size="sm" onClick={() => { setStokStock(v); setStokPage(1); }}>{label}</Button>)}</div>{user?.role !== 'super' && <p className="mb-2 text-sm">Akun {user?.role} hanya bisa melihat cabang {user?.branchId} — login Super Admin untuk melihat semua cabang.</p>}{branchFilter !== 'Semua' && <p className="mb-2 text-sm">Filter cabang di header atas aktif: {branchFilter}. Ubah header itu ke Semua Cabang, atau pakai tombol cabang di atas, untuk melihat cabang lain.</p>}{lastSyncReport && <p className="mb-2 text-sm">Hasil sync terakhir: {fmtShort(lastSyncReport.at)} • Feed {lastSyncReport.recordsTotal} baris, terkumpul {lastSyncReport.fetched} • Per cabang: {lastSyncReport.branchSummary} • Varian LCD di feed ({lastSyncReport.lcdVariants.length}): {lastSyncReport.lcdVariants.join(', ') || '—'}. Kalau varian yang kamu cari tidak ada di daftar ini, berarti feed iNOX sendiri tidak mengembalikannya.</p>}<Card><CardContent className="pt-6"><div className="max-h-[480px] overflow-auto"><Table><TableHeader><TableRow><TableHead>SKU</TableHead><TableHead>Produk</TableHead><TableHead>Varian</TableHead><TableHead>Kategori</TableHead><TableHead>Cabang (location_id)</TableHead><TableHead>Harga Jual</TableHead><TableHead>Stok di Rak</TableHead><TableHead>Belum Ditempatkan</TableHead><TableHead>Total Eksternal iNOX</TableHead></TableRow></TableHeader><TableBody>{stokPageItems.map(p => { const bid = branchIdOfProduct(p); const inRacks = stokInRacks(p); return (<TableRow key={p.id}><TableCell>{p.sku}</TableCell><TableCell>{p.name}</TableCell><TableCell>{p.variant}</TableCell><TableCell>{p.category}</TableCell><TableCell>{bid} ({p.location_id})</TableCell><TableCell>{rupiah(p.price)}</TableCell><TableCell>{inRacks}</TableCell><TableCell>{stock[`${p.id}|${bid}|BELUM`] || 0}</TableCell><TableCell>{(externalTotals[p.id] || externalTotals[`${p.product_id}|${p.variation_id}|${p.location_id}`]) ? `${(externalTotals[p.id] || externalTotals[`${p.product_id}|${p.variation_id}|${p.location_id}`]).stock} unit` : '—'}</TableCell></TableRow>); })}</TableBody></Table></div><Pager page={stokPageClamped} pageSize={stokPageSize} total={stokFiltered.length} onPage={setStokPage} onPageSize={(n) => { setStokPageSize(n); setStokPage(1); }} /></CardContent></Card><p className="mt-2 text-xs text-muted-foreground">Bidang dari iNOX (SKU, nama, varian, kategori, harga) adalah acuan keras — edit di iNOX lalu sync. Bidang lokal (rak/level) diatur lewat Visual Gudang dan Pindah Produk.</p></>)}
          {view === 'master' && <MasterRacks allRacks={racks} branches={visibleBranches} stock={stock} products={products} canEdit={user.role !== 'karyawan'} onAddRack={addRack} onUpdateRack={updateRack} onRenameLevel={renameLevel} onDeleteLevel={deleteLevel} onDeleteRack={deleteRack} onGoVisual={(bid) => { setRequestedVisualBranch(bid); setView('visual'); }} onOpenRack={(rid) => { setSessRacks([rid]); setSessLevelScope(null); setSessBranch(rid.split('-')[0]); setView('opname'); }} onOpenLevel={(rid, lv) => { setSessBranch(rid.split('-')[0]); setSessRacks([rid]); setSessLevelScope({ [rid]: [lv] }); setSessTitle(`Opname ${rid} — ${lv}`); setView('opname'); }} />}
          {view === 'visual' && <VisualMap initialBranch={requestedVisualBranch} allRacks={racks} branches={visibleBranches} stock={stock} products={products} canEdit={user.role !== 'karyawan'} onUpdateRack={updateRack} onAddRack={addRack} onRenameLevel={renameLevel} onDeleteLevel={deleteLevel} onDeleteRack={deleteRack} onOpenRack={(rid) => { setSessRacks([rid]); setSessLevelScope(null); setSessBranch(rid.split('-')[0]); setView('opname'); }} onOpenLevel={(rid, lv) => { setSessBranch(rid.split('-')[0]); setSessRacks([rid]); setSessLevelScope({ [rid]: [lv] }); setSessTitle(`Opname ${rid} — ${lv}`); setView('opname'); }} />}
          {view === 'opname' && (<><Card className="mb-4"><CardHeader><CardTitle>Buat Sesi Opname — Fleksibel</CardTitle><CardDescription>1 sesi = 1 cabang. Scope bisa seluruh cabang, 1 rak saja, 1 level saja, atau kombinasi rak.</CardDescription></CardHeader><CardContent className="space-y-4"><div><label className="text-sm font-medium">Scan QR Rak — otomatis isi Cabang / Rak / Level sesi</label><div className="mt-1 flex gap-2"><Input value={sessQr} onChange={e => setSessQr(e.target.value)} placeholder="APNAME|KWSN|KWSN-A|L1 — scan QR rak, lalu Enter" onKeyDown={e => { if (e.key === 'Enter' && sessQr) { const q = parseRackQr(sessQr); if (!q) alert('QR ini bukan QR rak Apname (format APNAME|cabang|rak|level).'); else if (!racks.find(r => r.id === q.rackId && r.branchId === q.branchId)) alert(`Rak ${q.rackId} cabang ${q.branchId} tidak ditemukan di Master Rak.`); else { setSessBranch(q.branchId); setSessRacks([q.rackId]); setSessLevelScope({ [q.rackId]: [q.level] }); setSessTitle(`Opname ${q.rackId} — ${q.level}`); setSessQr(''); } } }} /><Button variant="outline" onClick={() => { if (!sessQr) return; const q = parseRackQr(sessQr); if (!q) alert('QR ini bukan QR rak Apname (format APNAME|cabang|rak|level).'); else if (!racks.find(r => r.id === q.rackId && r.branchId === q.branchId)) alert(`Rak ${q.rackId} cabang ${q.branchId} tidak ditemukan di Master Rak.`); else { setSessBranch(q.branchId); setSessRacks([q.rackId]); setSessLevelScope({ [q.rackId]: [q.level] }); setSessTitle(`Opname ${q.rackId} — ${q.level}`); setSessQr(''); } }}>Isi Scope dari QR</Button></div><p className="mt-1 text-xs text-muted-foreground">Opsional. Scan QR yang ditempel di rak sebelum Buat Sesi — Cabang, Rak, dan Level sesi langsung terisi dari QR itu, jadi tidak perlu pilih manual. Snapshot nanti dibekukan hanya untuk rak/level itu.</p></div><div className="grid gap-3 md:grid-cols-3"><div><label className="text-sm font-medium">Judul</label><Input className="mt-1" value={sessTitle} onChange={e => setSessTitle(e.target.value)} /></div><FieldSelect label="Cabang (1 sesi = 1 cabang)" value={sessBranch} onChange={(v) => { setSessBranch(v); setSessRacks([]); setSessLevelScope(null); }} options={visibleBranches.map(b => ({ value: b.id, label: b.name }))} /><div><label className="text-sm font-medium">Rak dalam scope</label><div className="mt-1 flex flex-wrap gap-2">{racks.filter(r => r.branchId === sessBranch).map(r => <Button key={r.id} variant={sessRacks.includes(r.id) ? 'default' : 'outline'} size="sm" onClick={() => setSessRacks(prev => prev.includes(r.id) ? prev.filter(x => x !== r.id) : [...prev, r.id])}>{r.name}{r.type === 'retur' ? ' (RETUR)' : ''}</Button>)}</div></div></div><div><label className="text-sm font-medium">Level saja dalam rak (opsional — langsung di menu ini)</label><p className="text-xs text-muted-foreground">Kosong = semua level di rak yang dipilih. Klik satu level untuk mulai memilih hanya level itu. Level terakhir yang terpilih tidak bisa dibatalkan dengan klik lagi — pakai tombol Kembali ke semua level di bawah.</p><div className="mt-1 flex flex-wrap gap-2">{sessRacks.map(rid => { const rk = racks.find(r => r.id === rid); if (!rk) return null; return rk.levels.map(lv => { const selected = sessLevelScope ? (sessLevelScope[rid] || []).includes(lv) : false; return <Button key={rid + lv} variant={sessLevelScope && selected ? 'default' : 'outline'} size="sm" onClick={() => toggleSessLevel(rid, lv)}>{rid} — {lv}</Button>; }); })}</div>{sessLevelScope && <Button variant="link" size="sm" onClick={() => setSessLevelScope(null)}>Kembali ke semua level</Button>}</div>{sessLevelScope && <p className="text-sm">Scope level yang akan dikunci: <b>{Object.entries(sessLevelScope).map(([rid, lvs]) => `${rid}: ${lvs.join(', ')}`).join(' • ')}</b> — pratinjau dan penguncian nanti HANYA menampilkan scope ini. Tekan Buat Sesi untuk mengunci scope ini, atau Batalkan scope level untuk kembali ke semua level. <Button variant="link" size="sm" onClick={() => setSessLevelScope(null)}>Batalkan scope level</Button></p>}<Button onClick={createSession} disabled={sessRacks.length === 0}>Buat Sesi &amp; Bekukan Snapshot</Button></CardContent></Card>
            {sessions.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada sesi. Buat sesi di atas, lalu buka sesinya dari list di bawah.</p> : <Card><CardHeader><CardTitle>Daftar Sesi</CardTitle><CardDescription>List ringkas saja — klik Buka Sesi untuk mengopname di popup khusus. Semua isi opname (scan, kamera, mutasi, riwayat scan) hanya ada di dalam popup itu, jadi menu ini tidak makan tempat lagi.</CardDescription></CardHeader><CardContent><div className="max-h-[480px] overflow-auto"><Table><TableHeader><TableRow><TableHead>Nomor</TableHead><TableHead>Judul</TableHead><TableHead>Cabang</TableHead><TableHead>Scope</TableHead><TableHead>Dibuat</TableHead><TableHead>Status</TableHead><TableHead>Scan</TableHead><TableHead>Mutasi</TableHead><TableHead>Aksi</TableHead></TableRow></TableHeader><TableBody>{sessions.map(s => <TableRow key={s.id}><TableCell>{s.id}</TableCell><TableCell>{s.title}</TableCell><TableCell>{s.branchId}</TableCell><TableCell>{scopeLabel(s)}</TableCell><TableCell>{fmtShort(s.createdAt)}</TableCell><TableCell><Badge variant={s.status === 'Selesai' ? 'secondary' : 'default'}>{s.status}</Badge></TableCell><TableCell>{s.scans.length}</TableCell><TableCell>{(s.mutations || []).length}</TableCell><TableCell><div className="flex gap-1"><Button size="sm" onClick={() => { setActiveSessionId(s.id); setOpnameSessionId(s.id); }}>Buka Sesi</Button>{user?.role === 'super' && <Button size="sm" variant="destructive" onClick={() => deleteSession(s)}>Hapus</Button>}</div></TableCell></TableRow>)}</TableBody></Table></div></CardContent></Card>}
            {(() => { const os = sessions.find(x => x.id === opnameSessionId); if (!os) return null; return (<Dialog open={!!os} onOpenChange={(o) => { if (!o) setOpnameSessionId(null); }}><DialogContent className="sm:max-w-5xl max-h-[90vh] overflow-auto"><DialogHeader><DialogTitle>Sedang Mengopname — {os.id}</DialogTitle><DialogDescription>{os.title} • {os.branchId} • {scopeLabel(os)} • {os.status} • {os.scans.length} scan</DialogDescription></DialogHeader><SessionCard sess={os} products={products} racks={racks} active={true} onSelect={() => setActiveSessionId(os.id)} onScan={(barcode, qty, mode, rackId, level) => addScan(os, barcode, qty, mode, rackId, level)} onDeleteScan={(scanId) => deleteScan(os, scanId)} onMutation={(m) => addMutation(os, m)} onPreview={() => { setActiveSessionId(os.id); setShowPreview(true); }} onDeleteSession={() => deleteSession(os)} canDeleteSession={user?.role === 'super'} /><DialogFooter><Button variant="outline" onClick={() => setOpnameSessionId(null)}>Tutup Popup Opname</Button></DialogFooter></DialogContent></Dialog>); })()}
            {activeSession && (<Dialog open={showPreview} onOpenChange={(o) => setShowPreview(o)}><DialogContent><DialogHeader><DialogTitle>Pratinjau Mini Laporan — {activeSession.id} {activeSession.status !== 'Selesai' && <Badge variant="secondary">DRAFT — BELUM DIKUNCI</Badge>}</DialogTitle><DialogDescription>{activeSession.title} • {activeSession.branchId} • Scope: {scopeLabel(activeSession)} • Dibuat {fmtShort(activeSession.createdAt)} • Scan terakhir {activeSession.scans[0] ? fmtShort(activeSession.scans[0].time) : '—'}</DialogDescription></DialogHeader><PreviewBody previewRows={previewRows(activeSession)} unscannedRows={unscannedExpected(activeSession)} filter={previewFilter} setFilter={setPreviewFilter} /><DialogFooter><Button variant="outline" onClick={() => setShowPreview(false)}>Kembali ke Hitung</Button><Button variant="outline" onClick={() => setShowPreview(false)}>Tutup</Button>{activeSession.status === 'Berjalan' && <Button onClick={() => { if (confirm(`Kunci sesi ${activeSession.id}?`)) lockSession(activeSession); }}>Kunci Sesi</Button>}</DialogFooter></DialogContent></Dialog>)}</>)}
          {view === 'laporan' && (<><Card className="mb-3"><CardHeader><CardTitle>Menu Laporan — Daftar Semua Sesi</CardTitle><CardDescription>Isi laporan = hasil scan di dalam sesi itu (Fisik = total qty scan per produk/rak/level), ditampilkan sebagai tabel bentuk Excel yang sama dengan file .xlsx. Bukan hanya daftar sesi dari luar. Tekan Lihat Isi untuk membuka tabelnya, lalu Excel untuk file .xlsx atau PDF Isi Laporan untuk mencetak tabel itu sebagai PDF. Kolom Aksi kini hanya satu tombol Aksi per baris yang membuka mini popup berisi semua aksi di atas, supaya list tidak makan tempat. Tombol Hapus Sesi hanya muncul untuk Super Admin; menghapus sesi menghilangkan scan, mutasi, dan snapshot-nya secara permanen, dan tidak mengembalikan stok sesi yang sudah dikunci.</CardDescription></CardHeader></Card><Card><CardContent className="pt-6"><div className="max-h-[480px] overflow-auto"><Table><TableHeader><TableRow><TableHead>Nomor</TableHead><TableHead>Judul</TableHead><TableHead>Cabang</TableHead><TableHead>Scope</TableHead><TableHead>Dibuat</TableHead><TableHead>Status</TableHead><TableHead>Scan</TableHead><TableHead>Adjustment</TableHead><TableHead>Aksi</TableHead></TableRow></TableHeader><TableBody>{lapPageItems.map(s => <TableRow key={s.id}><TableCell>{s.id}</TableCell><TableCell>{s.title}</TableCell><TableCell>{s.branchId}</TableCell><TableCell>{scopeLabel(s)}</TableCell><TableCell>{fmtShort(s.createdAt)}</TableCell><TableCell>{s.status}</TableCell><TableCell>{s.scans.length}</TableCell><TableCell><Badge variant={s.adjustmentStatus === 'Disetujui' ? 'default' : 'secondary'}>{s.adjustmentStatus || 'Menunggu'}</Badge></TableCell><TableCell><Button size="sm" onClick={() => setAksiSessionId(s.id)}>Aksi ▾</Button></TableCell></TableRow>)}</TableBody></Table></div><Pager page={lapPageClamped} pageSize={lapPageSize} total={sessions.length} onPage={setLapPage} onPageSize={(n) => { setLapPageSize(n); setLapPage(1); }} /></CardContent></Card>{sessions.length === 0 && <p className="mt-2 text-sm">Belum ada laporan. Buat dan kunci satu sesi dulu.</p>}{(() => { const rs = sessions.find(x => x.id === reportSessionId); if (!rs) return null; const rows = previewRows(rs); const cocok = rows.filter(r => r.scanned && r.diff === 0).length; const lebih = rows.filter(r => r.scanned && r.diff > 0).length; const kurang = rows.filter(r => r.scanned && r.diff < 0).length; const belum = unscannedExpected(rs).length; const reportLevelOptions = Array.from(new Set(rows.map(r => `${r.rid} / ${r.lv}`))).sort(); const reportFilteredRows = (reportLevelFilter === 'semua' ? rows : rows.filter(r => `${r.rid} / ${r.lv}` === reportLevelFilter)).sort((a, b) => (a.rid.localeCompare(b.rid) || a.lv.localeCompare(b.lv) || Math.abs(b.diff) - Math.abs(a.diff))); const reportGrouped: { label: string; rows: typeof reportFilteredRows }[] = []; for (const r of reportFilteredRows) { const label = `${r.rid} / ${r.lv}`; const g = reportGrouped.find(x => x.label === label); if (g) g.rows.push(r); else reportGrouped.push({ label, rows: [r] }); } const reportPageClamped = Math.min(reportPage, totalPagesFor(reportFilteredRows.length, reportPageSize)); const reportPageItems = paginate(reportFilteredRows, reportPageClamped, reportPageSize); const reportRawPageClamped = Math.min(reportRawPage, totalPagesFor(rs.scans.length, reportPageSize)); const reportRawPageItems = paginate(rs.scans, reportRawPageClamped, reportPageSize); return (<Dialog open={!!rs} onOpenChange={(o) => { if (!o) setReportSessionId(null); }}><DialogContent className={reportFull ? "max-w-5xl max-h-[90vh] overflow-auto" : "max-w-3xl max-h-[90vh] overflow-auto"}><DialogHeader><DialogTitle>Isi Laporan — {rs.id} {rs.status !== 'Selesai' && <Badge variant="secondary">DRAFT — BELUM DIKUNCI</Badge>}</DialogTitle><DialogDescription>{rs.title} • {rs.branchId} • Scope: {scopeLabel(rs)} • Dibuat {fmtShort(rs.createdAt)} • Dikunci {rs.lockedAt ? fmtShort(rs.lockedAt) : 'belum'} • Jumlah scan: {rs.scans.length}</DialogDescription></DialogHeader><p className="text-sm">Isi di bawah ini dihitung dari <b>hasil scan di dalam sesi ini</b>, bukan dari stok di luar sesi. Kolom <b>Fisik</b> = total jumlah scan per produk/rak/level. Tabel ini sama persis dengan sheet Detail Opname di file .xlsx — tombol Excel mengunduh file itu, tombol PDF Isi Laporan mencetak tabel ini sebagai PDF.</p><p className="text-sm">Total baris hasil scan: <b>{rows.length}</b> • Cocok: <b>{cocok}</b> • Lebih: <b>{lebih}</b> • Kurang: <b>{kurang}</b> • Belum dihitung (tidak masuk tabel ini): <b>{belum}</b></p>{belum > 0 && <p className="text-sm">Produk yang belum discan itu tidak ada di tabel di atas dan tidak masuk adjustment — cek di Pratinjau sesi (tombol Cek Belum Dihitung) sebelum mengunci.</p>}<div className="mt-2 flex flex-wrap items-center gap-2"><Button variant="outline" size="sm" onClick={() => { setReportFull(v => !v); setReportPage(1); }}>{reportFull ? 'Kembali ke Tampilan Minimal' : 'Detail Lengkap (semua kolom)'}</Button><span className="text-xs text-muted-foreground">{reportFull ? 'Tampilan lengkap: semua kolom seperti di Excel.' : 'Tampilan minimal (default): hanya Produk, SKU, Rak/Level, Fisik, Selisih, Status.'}</span></div><div className="mt-2 flex flex-wrap gap-2"><Button variant={reportLevelFilter === 'semua' ? 'default' : 'outline'} size="sm" onClick={() => { setReportLevelFilter('semua'); setReportPage(1); }}>Semua level (tetap per kelompok)</Button>{reportLevelOptions.map(lv => <Button key={lv} variant={reportLevelFilter === lv ? 'default' : 'outline'} size="sm" onClick={() => { setReportLevelFilter(lv); setReportPage(1); }}>{lv}</Button>)}</div><p className="mt-1 text-xs text-muted-foreground">Isi laporan ini juga dikelompokkan per level, sama seperti pratinjau — bukan satu list campur. Excel (.xlsx) dan PDF tetap berisi semua baris, tidak berubah isinya.</p>{reportLevelFilter === 'semua' ? (<div className="max-h-[420px] overflow-auto">{reportGrouped.map(g => (<div key={g.label} className="mt-3"><p className="text-sm font-medium">📦 {g.label} — {g.rows.length} baris • Cocok {g.rows.filter(r => r.diff === 0).length} • Lebih {g.rows.filter(r => r.diff > 0).length} • Kurang {g.rows.filter(r => r.diff < 0).length}</p>{reportFull ? (<Table><TableHeader><TableRow><TableHead>Produk</TableHead><TableHead>SKU</TableHead><TableHead>Varian</TableHead><TableHead>Rak</TableHead><TableHead>Level</TableHead><TableHead>Snapshot</TableHead><TableHead>Mut. Masuk</TableHead><TableHead>Mut. Keluar</TableHead><TableHead>Stok Disesuaikan</TableHead><TableHead>Fisik (Hasil Scan)</TableHead><TableHead>Selisih</TableHead><TableHead>Status</TableHead><TableHead>Scan Terakhir</TableHead></TableRow></TableHeader><TableBody>{g.rows.map((r, i) => (<TableRow key={i}><TableCell>{r.p?.name || '—'}</TableCell><TableCell>{r.p?.sku || '—'}</TableCell><TableCell>{r.p?.variant || '—'}</TableCell><TableCell>{r.rid}</TableCell><TableCell>{r.lv}</TableCell><TableCell>{r.sys}</TableCell><TableCell>{r.mutIn}</TableCell><TableCell>{r.mutOut}</TableCell><TableCell>{r.adjusted}</TableCell><TableCell><b>{r.fis}</b></TableCell><TableCell>{r.diff}</TableCell><TableCell>{r.diff === 0 ? 'Cocok' : r.diff > 0 ? 'Lebih' : 'Kurang'}</TableCell><TableCell>{r.last ? fmtShort(r.last.time) : '—'}</TableCell></TableRow>))}</TableBody></Table>) : (<Table><TableHeader><TableRow><TableHead>Produk</TableHead><TableHead>SKU</TableHead><TableHead>Rak / Level</TableHead><TableHead>Fisik</TableHead><TableHead>Selisih</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>{g.rows.map((r, i) => (<TableRow key={i}><TableCell>{r.p?.name} — {r.p?.variant}</TableCell><TableCell>{r.p?.sku}</TableCell><TableCell>{r.rid} / {r.lv}</TableCell><TableCell><b>{r.fis}</b></TableCell><TableCell>{r.diff}</TableCell><TableCell>{r.diff === 0 ? 'Cocok' : r.diff > 0 ? 'Lebih' : 'Kurang'}</TableCell></TableRow>))}</TableBody></Table>)}</div>))}</div>) : (<><div className="max-h-[420px] overflow-auto">{reportFull ? (<Table><TableHeader><TableRow><TableHead>Produk</TableHead><TableHead>SKU</TableHead><TableHead>Varian</TableHead><TableHead>Rak</TableHead><TableHead>Level</TableHead><TableHead>Snapshot</TableHead><TableHead>Mut. Masuk</TableHead><TableHead>Mut. Keluar</TableHead><TableHead>Stok Disesuaikan</TableHead><TableHead>Fisik (Hasil Scan)</TableHead><TableHead>Selisih</TableHead><TableHead>Status</TableHead><TableHead>Scan Terakhir</TableHead></TableRow></TableHeader><TableBody>{reportPageItems.map((r, i) => (<TableRow key={i}><TableCell>{r.p?.name || '—'}</TableCell><TableCell>{r.p?.sku || '—'}</TableCell><TableCell>{r.p?.variant || '—'}</TableCell><TableCell>{r.rid}</TableCell><TableCell>{r.lv}</TableCell><TableCell>{r.sys}</TableCell><TableCell>{r.mutIn}</TableCell><TableCell>{r.mutOut}</TableCell><TableCell>{r.adjusted}</TableCell><TableCell><b>{r.fis}</b></TableCell><TableCell>{r.diff}</TableCell><TableCell>{r.diff === 0 ? 'Cocok' : r.diff > 0 ? 'Lebih' : 'Kurang'}</TableCell><TableCell>{r.last ? fmtShort(r.last.time) : '—'}</TableCell></TableRow>))}</TableBody></Table>) : (<Table><TableHeader><TableRow><TableHead>Produk</TableHead><TableHead>SKU</TableHead><TableHead>Rak / Level</TableHead><TableHead>Fisik</TableHead><TableHead>Selisih</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>{reportPageItems.map((r, i) => (<TableRow key={i}><TableCell>{r.p?.name} — {r.p?.variant}</TableCell><TableCell>{r.p?.sku}</TableCell><TableCell>{r.rid} / {r.lv}</TableCell><TableCell><b>{r.fis}</b></TableCell><TableCell>{r.diff}</TableCell><TableCell>{r.diff === 0 ? 'Cocok' : r.diff > 0 ? 'Lebih' : 'Kurang'}</TableCell></TableRow>))}</TableBody></Table>)}</div><Pager page={reportPageClamped} pageSize={reportPageSize} total={reportFilteredRows.length} onPage={setReportPage} onPageSize={(n) => { setReportPageSize(n); setReportPage(1); }} /></>)}{rows.length === 0 && <p className="text-sm text-muted-foreground">Belum ada baris di laporan ini.</p>}<div className="mt-3"><Button variant="outline" size="sm" onClick={() => setShowRawScans(v => !v)}>{showRawScans ? 'Sembunyikan Daftar Scan Mentah' : `Lihat Daftar Scan Mentah (${rs.scans.length})`}</Button>{showRawScans && (<><div className="max-h-[420px] overflow-auto"><Table><TableHeader><TableRow><TableHead>Waktu Scan</TableHead><TableHead>Petugas</TableHead><TableHead>Produk</TableHead><TableHead>SKU</TableHead><TableHead>Varian</TableHead><TableHead>Rak / Level</TableHead><TableHead>Jumlah</TableHead><TableHead>Mode</TableHead></TableRow></TableHeader><TableBody>{reportRawPageItems.map(sc => { const pr = products.find(x => x.id === sc.productId); return (<TableRow key={sc.id}><TableCell>{fmtShort(sc.time)}</TableCell><TableCell>{sc.user}</TableCell><TableCell>{pr?.name}</TableCell><TableCell>{pr?.sku}</TableCell><TableCell>{pr?.variant}</TableCell><TableCell>{sc.rackId} / {sc.level}</TableCell><TableCell>{sc.qty}</TableCell><TableCell>{sc.mode}</TableCell></TableRow>); })}</TableBody></Table></div><Pager page={reportRawPageClamped} pageSize={reportPageSize} total={rs.scans.length} onPage={setReportRawPage} onPageSize={(n) => { setReportPageSize(n); setReportRawPage(1); }} /></>)}</div><DialogFooter><Button variant="outline" onClick={() => exportExcel(rs)}>Excel (.xlsx)</Button><Button variant="outline" onClick={() => exportCSV(rs)}>CSV</Button><Button onClick={() => printReportFor(rs)}>PDF Isi Laporan</Button><Button variant="outline" onClick={() => setReportSessionId(null)}>Tutup</Button></DialogFooter></DialogContent></Dialog>); })()}{(() => { const as = sessions.find(x => x.id === aksiSessionId); if (!as) return null; return (<Dialog open={!!as} onOpenChange={(o) => { if (!o) setAksiSessionId(null); }}><DialogContent className="sm:max-w-sm"><DialogHeader><DialogTitle>Aksi — {as.id}</DialogTitle><DialogDescription>{as.title} • {as.branchId} • {scopeLabel(as)} • {as.status} • {as.scans.length} scan</DialogDescription></DialogHeader><div className="flex flex-col gap-2"><Button onClick={() => { setReportSessionId(as.id); setShowRawScans(false); setReportPage(1); setReportRawPage(1); setReportFull(false); setReportLevelFilter('semua'); setAksiSessionId(null); }}>Lihat Isi Laporan</Button><Button variant="outline" onClick={() => { exportExcel(as); setAksiSessionId(null); }}>Excel (.xlsx)</Button><Button variant="outline" onClick={() => { exportCSV(as); setAksiSessionId(null); }}>CSV</Button><Button variant="outline" onClick={() => { printReportFor(as); setAksiSessionId(null); }}>PDF Isi Laporan</Button><Button variant="outline" onClick={() => { setActiveSessionId(as.id); setOpnameSessionId(as.id); setView('opname'); setAksiSessionId(null); }}>Ke Sesi</Button><Button variant="outline" onClick={() => approveAdjustment(as)} disabled={as.adjustmentStatus === 'Disetujui'}>Setujui Adjustment</Button><Button onClick={() => { exportAdjustment(as); setAksiSessionId(null); }} disabled={as.adjustmentStatus !== 'Disetujui'}>Adjustment iNOX</Button>{user?.role === 'super' && <Button variant="destructive" onClick={() => deleteSession(as)}>Hapus Sesi</Button>}</div><DialogFooter><Button variant="outline" onClick={() => setAksiSessionId(null)}>Tutup</Button></DialogFooter></DialogContent></Dialog>); })()}</>)}
          {view === 'pindah' && (<Card className="max-w-2xl"><CardHeader><CardTitle>Pindah Produk Antar Level / Antar Rak</CardTitle></CardHeader><CardContent className="space-y-4"><div className="grid gap-3 md:grid-cols-2"><div className="relative"><label className="text-sm font-medium">Produk (ketik nama / SKU / varian)</label><Input className="mt-1" value={mvSearch} placeholder="Ketik Battery, 8990124000135, BATT-HX…" onFocus={() => setMvSuggestOpen(true)} onBlur={() => setTimeout(() => setMvSuggestOpen(false), 150)} onChange={e => { const v = e.target.value; setMvSearch(v); setMvSuggestOpen(true); const originProds = mvOriginBranch ? products.filter(pr => branchIdOfProduct(pr) === mvOriginBranch) : products; const exact = originProds.find(pr => `${pr.name} — ${pr.variant} (${pr.sku}) • ${branchIdOfProduct(pr)}`.toLowerCase() === v.toLowerCase() || `${pr.name} — ${pr.variant} (${pr.sku})`.toLowerCase() === v.toLowerCase() || pr.sku === v || pr.barcode === v); setMvProd(exact ? exact.id : ''); }} />{mvSuggestOpen && mvSearch.trim() !== '' && (<div className="absolute left-0 right-0 z-30 mt-1 max-h-56 overflow-auto rounded-md border bg-card shadow-md">{mvSuggestions.map(pr => (<button key={pr.id} type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-muted" onMouseDown={() => { setMvProd(pr.id); setMvSearch(`${pr.name} — ${pr.variant} (${pr.sku}) • ${branchIdOfProduct(pr)}`); setMvSuggestOpen(false); }}>{pr.name} — {pr.variant} ({pr.sku}) • {branchIdOfProduct(pr)}</button>))}{mvSuggestions.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">Tidak ada produk yang cocok di cabang Rak Asal ({mvOriginBranch || '—'}).</p>}</div>)}{mvProd ? <p className="mt-1 text-xs text-muted-foreground">Terpilih: {products.find(pr => pr.id === mvProd)?.name} — {products.find(pr => pr.id === mvProd)?.variant} • {products.find(pr => pr.id === mvProd) ? branchIdOfProduct(products.find(pr => pr.id === mvProd)!) : ''}</p> : <p className="mt-1 text-xs text-muted-foreground">Pilih dari saran di bawah — saran hanya produk cabang Rak Asal ({mvOriginBranch || '—'}), jadi tidak ada lagi 2 list yang sama persis. Ganti Rak Asal dulu kalau mau cabang lain.</p>}</div><div><label className="text-sm font-medium">Jumlah</label><Input className="mt-1" type="number" min={1} value={mvQty} onChange={e => setMvQty(Number(e.target.value))} /></div><FieldSelect label="Rak Asal" value={mvFromRack} onChange={setMvFromRack} options={racks.map(r => ({ value: r.id, label: `${r.branchId} — ${r.name}${r.type === 'retur' ? ' (RETUR)' : ''}` }))} /><FieldSelect label="Level Asal" value={mvFromLevel} onChange={setMvFromLevel} options={(racks.find(r => r.id === mvFromRack)?.levels || []).map(l => ({ value: l, label: l }))} /><FieldSelect label="Rak Tujuan" value={mvToRack} onChange={setMvToRack} options={racks.map(r => ({ value: r.id, label: `${r.branchId} — ${r.name}${r.type === 'retur' ? ' (RETUR)' : ''}` }))} /><FieldSelect label="Level Tujuan (spesifik)" value={mvToLevel} onChange={setMvToLevel} options={(racks.find(r => r.id === mvToRack)?.levels || []).map(l => ({ value: l, label: l }))} /><FieldSelect label="Alasan" value={mvReason} onChange={setMvReason} options={['Penataan Ulang', 'Retur Customer', 'Rusak', 'Kembali ke Rak Jual', 'Dikirim Balik ke Supplier', 'Dimusnahkan', 'Lainnya'].map(x => ({ value: x, label: x }))} /><div><label className="text-sm font-medium">Foto bukti (opsional)</label><Input className="mt-1" type="file" accept="image/*" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setMvPhoto(await compressImage(f)); }} />{mvPhoto && <img src={mvPhoto} alt="Foto bukti pindah" className="mt-2 max-h-32 rounded-md border" />}</div></div><p className="text-sm">Stok di level asal: <b>{stock[`${mvProd}|${mvFromRack}|${mvFromLevel}`] || 0}</b> • Stok di level tujuan: <b>{stock[`${mvProd}|${mvToRack}|${mvToLevel}`] || 0}</b> • Total cabang tidak berubah.</p><Button onClick={doMove}>Simpan Pindah</Button>{moves.length > 0 && <div className="pt-2"><Separator className="my-3" /><h3 className="font-semibold">Riwayat Pindah</h3><Table><TableHeader><TableRow><TableHead>Waktu</TableHead><TableHead>Produk</TableHead><TableHead>Asal → Tujuan</TableHead><TableHead>Qty</TableHead><TableHead>Alasan</TableHead><TableHead>Foto</TableHead></TableRow></TableHeader><TableBody>{moves.slice(0, 20).map(m => { const p = products.find(x => x.id === m.productId); return (<TableRow key={m.id}><TableCell>{fmtShort(m.time)}</TableCell><TableCell>{p?.name} — {p?.variant}</TableCell><TableCell>{m.fromRack} / {m.fromLevel} → {m.toRack} / {m.toLevel}</TableCell><TableCell>{m.qty}</TableCell><TableCell>{m.reason}</TableCell><TableCell>{m.photo ? <img src={m.photo} alt="Bukti" className="max-h-12 rounded border" /> : '—'}</TableCell></TableRow>); })}</TableBody></Table></div>}</CardContent></Card>)}
{view === 'akun' && (user.role !== 'super' ? (<Card><CardContent className="pt-6"><p className="text-sm">Menu Kelola Akun hanya untuk Super Admin. Akun {user.role} hanya bisa memakai cabangnya sendiri ({user.branchId}).</p></CardContent></Card>) : (<><Card className="max-w-2xl"><CardHeader><CardTitle>Kelola Akun — Multi Cabang</CardTitle><CardDescription>Buat akun berdasarkan hak akses. Admin Cabang dan Karyawan Cabang hanya bisa melihat dan bekerja di cabangnya sendiri; Super Admin melihat semua cabang. Cabang yang muncul di sini adalah cabang yang sudah aktif — termasuk cabang yang otomatis aktif dari data sync (lihat daftar di bawah form).</CardDescription></CardHeader><CardContent className="space-y-4"><div><label className="text-sm font-medium">Email akun</label><Input className="mt-1" value={newAccEmail} onChange={e => setNewAccEmail(e.target.value)} placeholder="mis. admin@llf" /></div><div><label className="text-sm font-medium">Nama</label><Input className="mt-1" value={newAccName} onChange={e => setNewAccName(e.target.value)} placeholder="mis. Admin LLF" /></div><FieldSelect label="Hak akses" value={newAccRole} onChange={(v) => setNewAccRole(v as Role)} options={[{ value: 'super', label: 'Super Admin (semua cabang)' }, { value: 'admin', label: 'Admin Cabang (kelola cabangnya)' }, { value: 'karyawan', label: 'Karyawan Cabang (hitung di cabangnya)' }]} /><FieldSelect label="Cabang (wajib untuk Admin/Karyawan Cabang, diabaikan untuk Super Admin)" value={newAccBranch} onChange={setNewAccBranch} options={allBranches.map(b => ({ value: b.id, label: `${b.id} — ${b.name}${BRANCHES.some(x => x.id === b.id) ? '' : ' (dari data sync)'}` }))} /><Button onClick={() => { const email = newAccEmail.trim().toLowerCase(); if (!email || !newAccName.trim()) { alert('Isi email dan nama dulu.'); return; } if (accounts.some(a => a.email.toLowerCase() === email)) { alert('Email ini sudah ada. Pakai email lain.'); return; } if (newAccRole !== 'super' && !newAccBranch) { alert('Pilih cabang untuk Admin/Karyawan Cabang.'); return; } setAccounts(prev => [...prev, { email, name: newAccName.trim(), role: newAccRole, branchId: newAccRole === 'super' ? null : newAccBranch }]); setNewAccEmail(''); setNewAccName(''); alert(`Akun ${email} dibuat sebagai ${newAccRole === 'super' ? 'Super Admin' : newAccRole === 'admin' ? `Admin Cabang ${newAccBranch}` : `Karyawan Cabang ${newAccBranch}`}. Akun ini langsung bisa dipakai login (password bebas, demo lokal).`); }}>Buat Akun</Button><p className="text-xs text-muted-foreground">Mode demo lokal: akun disimpan di browser ini saja (localStorage), password bebas — jangan pakai password asli di sini. Untuk produksi multi-HP, akun harus dipindah ke Supabase Auth + RLS; struktur role dan cabang di menu ini sudah sama dengan yang akan dipakai di sana.</p></CardContent></Card><Card><CardContent className="pt-6"><div className="max-h-[480px] overflow-auto"><Table><TableHeader><TableRow><TableHead>Nama</TableHead><TableHead>Email</TableHead><TableHead>Hak Akses</TableHead><TableHead>Cabang</TableHead><TableHead>Aksi</TableHead></TableRow></TableHeader><TableBody>{accounts.map(a => { const isSelf = user.email ? user.email.toLowerCase() === a.email.toLowerCase() : a.name === user.name; const superCount = accounts.filter(x => x.role === 'super').length; const canDelete = !isSelf && !(a.role === 'super' && superCount <= 1); return (<TableRow key={a.email}><TableCell>{a.name}</TableCell><TableCell>{a.email}</TableCell><TableCell>{a.role === 'super' ? 'Super Admin' : a.role === 'admin' ? 'Admin Cabang' : 'Karyawan Cabang'}</TableCell><TableCell>{a.role === 'super' ? 'Semua Cabang' : a.branchId}</TableCell><TableCell>{canDelete ? <Button variant="destructive" size="sm" onClick={() => { if (confirm(`Hapus akun ${a.email}? Akun ini tidak bisa login lagi.`)) setAccounts(prev => prev.filter(x => x.email.toLowerCase() !== a.email.toLowerCase())); }}>Hapus</Button> : <span className="text-xs text-muted-foreground">{isSelf ? 'Akun sendiri' : 'Super terakhir'}</span>}</TableCell></TableRow>); })}</TableBody></Table></div></CardContent></Card></>))}
          {view === 'settings' && (<Card className="max-w-2xl"><CardHeader><CardTitle>Settings → Integrasi iNOX</CardTitle><CardDescription>{inoxMode === 'local' ? 'MODE LOKAL NYATA: sync di sini BENAR-BENAR memanggil inox.my.id lewat server lokal localhost:4001 (login + feed Laporan Stok). Server lokal harus jalan dulu (CMD kedua: npm run inox-server), kalau tidak, Uji Koneksi Nyata / Sync Nyata akan gagal dengan pesan server tidak bisa dihubungi — itu bukan demo. Password di bawah hanya dipakai di memori satu request, tidak disimpan ke localStorage.' : 'MODE DEMO: aplikasi ini TIDAK memanggil inox.my.id sama sekali di mode ini. Tidak ada validasi username/password dan tidak ada data iNOX nyata yang ditarik. Untuk sync langsung dari inox.my.id, ubah Mode Integrasi iNOX di bawah menjadi Lokal Nyata dan jalankan server lokal (npm run inox-server). Jangan anggap tombol Demo di bawah sebagai validasi akun.'}</CardDescription></CardHeader><CardContent className="space-y-4"><FieldSelect label="Mode Integrasi iNOX" value={inoxMode} onChange={setInoxMode} options={[{ value: 'demo', label: 'Demo (tanpa iNOX nyata)' }, { value: 'local', label: 'Lokal Nyata (server localhost:4001)' }]} />{inoxMode === 'local' && (<Card><CardContent className="space-y-3 pt-6"><p className="text-sm font-medium">Mode Lokal Nyata — sync benar-benar dari inox.my.id, bukan demo.</p><p className="text-sm">Langkah: (1) Buka CMD kedua, cd ke folder Apname, jalankan <b>npm run inox-server</b>, tunggu sampai muncul <b>listening on http://localhost:4001</b>. (2) Isi username + password iNOX di bawah, tekan Uji Koneksi Nyata. (3) Tekan Sync Nyata Sekarang (di sini atau tombol Sync Sekarang di atas). Password hanya dikirim ke localhost:4001, hanya di memori satu request, tidak disimpan ke disk/localStorage, tidak dikirim ke GitHub/Supabase. Server lokal hanya menerima request dari localhost dan hanya membaca iNOX (login + GET feed).</p><div className="flex flex-wrap gap-2"><Button onClick={testInoxLocal}>Uji Koneksi Nyata</Button><Button variant="outline" onClick={doSync} disabled={syncBusy}>{syncBusy ? 'Sync Nyata Berjalan…' : 'Sync Nyata Sekarang'}</Button></div>{lcdSample && (<div className="rounded-md border p-3 text-sm"><p className="font-medium">Sampel LCD MENTAH — hasil Uji Koneksi terakhir (total {lcdSample.total ?? '?'} baris LCD di feed, belum diproses)</p><p className="text-xs text-muted-foreground">Yang menentukan: product_variation DAN variation_name di tiap baris. Screenshot kotak ini saja sudah cukup sebagai bukti.</p><ul className="mt-2 list-disc pl-5">{lcdSample.rows.map((r: any, i: number) => Array.isArray(r) ? <li key={i}>SKU={r[0]} | Produk={r[1]} | Varian mentah={r[2]} | Lokasi={r[4]}</li> : <li key={i}>SKU={r.sku} | {r.product} | product_variation={r.product_variation} | variation_name={r.variation_name} | variation={r.variation} | {r.location_name}</li>)}</ul>{lcdSample.rows.length === 0 && <p>Tidak ada baris LCD yang ditemukan pencarian feed — kabari pengembang.</p>}</div>)}{lastSyncReport && (<div className="rounded-md border p-3 text-sm"><p className="font-medium">Hasil sync terakhir — {fmtShort(lastSyncReport.at)}</p><p>Feed: {lastSyncReport.recordsTotal} baris, terkumpul {lastSyncReport.fetched} • Baru: {lastSyncReport.added} • Diperbarui: {lastSyncReport.updated} • Dilewati: {lastSyncReport.skipped} • Per cabang: {lastSyncReport.branchSummary}</p><p>Varian LCD di feed ({lastSyncReport.lcdVariants.length}): {lastSyncReport.lcdVariants.join(', ') || '—'}</p><p className="text-xs text-muted-foreground">Kalau varian LCD yang kamu cari tidak ada di daftar ini, berarti feed iNOX sendiri tidak mengembalikannya pada sync itu — bukan import yang menghapusnya. Cek filter lokasi/kategori di iNOX, lalu sync ulang.</p></div>)}</CardContent></Card>)}<div><label className="text-sm font-medium">Username iNOX</label><Input className="mt-1" value={inoxUser} onChange={e => setInoxUser(e.target.value)} placeholder="mis. ariansya" /></div><div><label className="text-sm font-medium">Password iNOX (tidak disimpan, hanya memori sesi demo)</label><Input className="mt-1" type="password" value={inoxPass} onChange={e => setInoxPass(e.target.value)} placeholder="••••••••" /></div><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => { if (!inoxUser || !inoxPass) { alert('Isi username dan password dulu.'); return; } alert('Uji Koneksi DEMO: tidak ada panggilan nyata ke inox.my.id, jadi hasil ini BUKAN validasi akun. Akun asal-asalan pun tidak akan ditolak di versi demo — itulah bug versi lama yang sudah diperbaiki dengan tidak lagi mengklaim Terhubung. Validasi nyata hanya lewat Mode Lokal Nyata di atas (server localhost:4001).'); }}>Uji Koneksi (Demo — Bukan Validasi Nyata)</Button><Button variant="outline" onClick={() => { if (!inoxUser) { alert('Isi username dulu.'); return; } alert('Username disimpan untuk tampilan demo saja. Status tetap Mode demo — belum terhubung nyata. Password tidak disimpan.'); }}>Simpan Username (Demo Saja)</Button>{inoxUser && <Button variant="outline" onClick={() => { setInoxUser(''); setInoxPass(''); alert('Username demo dihapus.'); }}>Hapus Username Demo</Button>}{inoxConnected && <Button variant="destructive" onClick={() => { setInoxConnected(false); alert('Integrasi diputuskan. Data hasil sync lama tetap tampil.'); }}>Putuskan Integrasi / Logout iNOX</Button>}</div><p className="text-sm font-medium">Catatan: tombol Simpan di versi lama yang langsung menampilkan Terhubung sudah dihapus — karena itu yang membuat login asal-asalan terlihat sudah sync.</p><div><h3 className="font-semibold">Pemetaan Lokasi iNOX → Cabang Opname</h3><ul className="mt-2 list-disc pl-5 text-sm">{allBranches.map(b => <li key={b.id}>{b.location_id} = {b.location_name} → {b.name}{BRANCHES.some(x => x.id === b.id) ? '' : ' (otomatis dari data sync — rak default sudah dibuatkan)'}</li>)}</ul></div><div><h3 className="font-semibold">Deployment</h3><p className="text-sm">Frontend ini (Vite) siap di-deploy ke Netlify (statis). Data demo ini memakai localStorage agar langsung jalan tanpa Supabase. Untuk produksi, terapkan supabase/schema.sql dan isi .env (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY) — struktur data dan logikanya sama, hanya sumber datanya berpindah dari localStorage ke Supabase.</p></div></CardContent></Card>)}
        </main>
        <footer className="p-4 text-center text-xs text-muted-foreground">Apname — Opname Per Rak • Build 2026-10-26-laporan-per-level • Tema: {theme} • {fmtWita(now)}</footer>
      </div>
    </div>
  </div>);
}

function VisualMap({ allRacks, branches, stock, products, canEdit, onUpdateRack, onAddRack, onRenameLevel, onDeleteLevel, onDeleteRack, onOpenRack, onOpenLevel, initialBranch }: {
  allRacks: Rack[]; branches: { id: string; name: string }[]; stock: Record<string, number>; products: Product[]; canEdit: boolean;
  onUpdateRack: (id: string, patch: Partial<Rack>) => void; onAddRack: (branchId: string, name: string, type: 'normal' | 'retur', levels: string[], w: number, h: number) => void;
  onRenameLevel: (rackId: string, oldLevel: string, newLevel: string) => string; onDeleteLevel: (rackId: string, level: string) => string; onDeleteRack: (rackId: string) => string;
  onOpenRack: (id: string) => void; onOpenLevel: (rackId: string, level: string) => void; initialBranch?: string | null;
}) {
  const [visualBranch, setVisualBranch] = useState(branches[0]?.id || 'KWSN');
  const [selId, setSelId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);
  const dragRef = useRef<{ id: string; offX: number; offY: number; startX: number; startY: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null); const mapWrapRef = useRef<HTMLDivElement | null>(null);
  const suppressClick = useRef(false);
  const [showCreate, setShowCreate] = useState(false);
  // ZOOM ALA GOOGLE MAPS (koreksi 2026-10-25): jendela denah UKURANNYA TETAP
  // (lebar 100% kartu, rasio 700:300) — yang berubah adalah viewBox SVG.
  // Zoom in = viewBox mengecil di sekitar tengah pandangan -> rak tampak membesar,
  // jendela tidak ikut membesar dan tidak memunculkan scrollbar baru.
  // Zoom out = viewBox membesar -> rak tampak mengecil, jendela tetap.
  // Geser area kosong denah = pan (menggeser viewBox), seperti drag di Maps.
  const [view, setView] = useState({ x: 0, y: 0, w: 700, h: 300 });
  const zoom = 700 / view.w;
  const panRef = useRef<{ startX: number; startY: number; startViewX: number; startViewY: number; moved: boolean } | null>(null);
  const setZoomCentered = (newZoom: number) => {
    const z = Math.min(3, Math.max(0.5, Math.round(newZoom * 4) / 4));
    const cx = Math.min(900, Math.max(-200, view.x + view.w / 2));
    const cy = Math.min(400, Math.max(-100, view.y + view.h / 2));
    setView({ x: cx - (700 / z) / 2, y: cy - (300 / z) / 2, w: 700 / z, h: 300 / z });
  };
  const [newName, setNewName] = useState('Rak C'); const [newType, setNewType] = useState<'normal' | 'retur'>('normal');
  const [newLevels, setNewLevels] = useState('Level 1, Level 2, Level 3'); const [newW, setNewW] = useState(160); const [newH, setNewH] = useState(90);
  const [editName, setEditName] = useState(''); const [editW, setEditW] = useState(160); const [editH, setEditH] = useState(90); const [editRot, setEditRot] = useState(0);
  const [editLevels, setEditLevels] = useState<string[]>([]);
  const shown = allRacks.filter(r => r.branchId === visualBranch);
  const sel = allRacks.find(r => r.id === selId) || null;
  const labelFor = (r: Rack, lv: string): LabelItem => ({ branchId: r.branchId, branchName: branches.find(b => b.id === r.branchId)?.name || r.branchId, rackId: r.id, rackName: r.name, rackType: r.type, level: lv });
  useEffect(() => { if (sel) { setEditName(sel.name); setEditW(sel.w); setEditH(sel.h); setEditRot(sel.rot); setEditLevels([...sel.levels]); } }, [sel?.id]);
  useEffect(() => { if (!branches.some(b => b.id === visualBranch)) setVisualBranch(branches[0]?.id || 'KWSN'); }, [branches]);
  useEffect(() => { if (initialBranch && branches.some(b => b.id === initialBranch)) setVisualBranch(initialBranch); }, [initialBranch, branches]);
  const toSvg = (e: React.PointerEvent) => { const rect = svgRef.current?.getBoundingClientRect(); if (!rect) return { x: 0, y: 0 }; return { x: view.x + (e.clientX - rect.left) * (view.w / rect.width), y: view.y + (e.clientY - rect.top) * (view.h / rect.height) }; };
  const onDown = (e: React.PointerEvent, r: Rack) => {
    if (!canEdit) return;
    const p = toSvg(e);
    dragRef.current = { id: r.id, offX: p.x - r.x, offY: p.y - r.y, startX: p.x, startY: p.y };
    setDragId(r.id); setMoved(false);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onSvgDown = (e: React.PointerEvent) => {
    // Klik di dalam <g> rak = drag rak (ditangani onDown rak), bukan pan.
    if ((e.target as Element).closest?.('g')) return;
    panRef.current = { startX: e.clientX, startY: e.clientY, startViewX: view.x, startViewY: view.y, moved: false };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const pn = panRef.current;
    if (pn) {
      const rect = svgRef.current?.getBoundingClientRect(); if (!rect) return;
      const dx = (e.clientX - pn.startX) * (view.w / rect.width);
      const dy = (e.clientY - pn.startY) * (view.h / rect.height);
      if (Math.abs(e.clientX - pn.startX) + Math.abs(e.clientY - pn.startY) > 5) pn.moved = true;
      const cx = Math.min(900, Math.max(-200, pn.startViewX + view.w / 2 - dx));
      const cy = Math.min(400, Math.max(-100, pn.startViewY + view.h / 2 - dy));
      setView(prev => ({ ...prev, x: cx - prev.w / 2, y: cy - prev.h / 2 }));
      return;
    }
    const d = dragRef.current; if (!d) return;
    const p = toSvg(e);
    if (Math.abs(p.x - d.startX) + Math.abs(p.y - d.startY) > 5) setMoved(true);
    const nx = Math.round((p.x - d.offX) / 10) * 10; const ny = Math.round((p.y - d.offY) / 10) * 10;
    onUpdateRack(d.id, { x: Math.max(0, nx), y: Math.max(0, ny) });
  };
  const onUp = () => { if (moved || panRef.current?.moved) { suppressClick.current = true; setTimeout(() => { suppressClick.current = false; }, 50); } dragRef.current = null; setDragId(null); panRef.current = null; };
  const saveEdit = () => {
    if (!sel) return;
    if (!editName.trim()) { alert('Nama rak tidak boleh kosong.'); return; }
    // Rename levels one by one, in order, reporting the first failure.
    for (let i = 0; i < sel.levels.length; i++) {
      const oldL = sel.levels[i]; const newL = editLevels[i] || oldL;
      if (newL !== oldL) { const msg = onRenameLevel(sel.id, oldL, newL); if (msg !== 'OK') { alert(msg); return; } }
    }
    onUpdateRack(sel.id, { name: editName.trim(), w: editW, h: editH, rot: editRot });
    alert('Rak diperbarui. Menggeser/rotate visual tidak mengubah stok.');
  };
  return (<Card><CardHeader><CardTitle>Visual Gudang — Denah Atas (2D, SVG)</CardTitle><CardDescription>{canEdit ? 'Mode edit: denah menampilkan SATU cabang agar rak tidak menumpuk. Geser balok rak (snap 10px), rotate, atau kelola rak di bawah. Menggeser visual tidak mengubah stok.' : 'Mode lihat saja (Karyawan): pilih cabang, klik rak untuk detail, lalu buat sesi opname per rak atau per level.'}</CardDescription></CardHeader><CardContent className="space-y-4">
    <div className="flex flex-wrap items-end gap-3"><FieldSelect label="Cabang yang ditampilkan" value={visualBranch} onChange={setVisualBranch} options={branches.map(b => ({ value: b.id, label: b.name }))} />{canEdit && <Button onClick={() => setShowCreate(v => !v)}><Plus className="size-4" /> {showCreate ? 'Tutup Form Rak Baru' : 'Tambah Rak'}</Button>}</div>
    {canEdit && showCreate && (<Card><CardContent className="grid gap-3 pt-6 md:grid-cols-3"><div><label className="text-sm font-medium">Nama rak</label><Input className="mt-1" value={newName} onChange={e => setNewName(e.target.value)} /></div><FieldSelect label="Tipe" value={newType} onChange={(v) => setNewType(v as 'normal' | 'retur')} options={[{ value: 'normal', label: 'Normal' }, { value: 'retur', label: 'Retur' }]} /><div><label className="text-sm font-medium">Level (pisah koma)</label><Input className="mt-1" value={newLevels} onChange={e => setNewLevels(e.target.value)} /></div><div><label className="text-sm font-medium">Lebar (w)</label><Input className="mt-1" type="number" value={newW} onChange={e => setNewW(Number(e.target.value))} /></div><div><label className="text-sm font-medium">Tinggi (h)</label><Input className="mt-1" type="number" value={newH} onChange={e => setNewH(Number(e.target.value))} /></div><div className="flex items-end"><Button onClick={() => { onAddRack(visualBranch, newName, newType, newLevels.split(','), newW, newH); setShowCreate(false); }}>Simpan Rak Baru</Button></div></CardContent></Card>)}
    <div ref={mapWrapRef} style={{ position: 'relative', width: '100%', aspectRatio: '700 / 300', overflow: 'hidden', borderRadius: 12, background: 'var(--muted)' }}>
    <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 10, display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 'calc(100% - 16px)', alignItems: 'center', gap: 4, background: 'var(--card)', border: '2px solid var(--accent)', borderRadius: 10, padding: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.35)' }}><span className="text-sm font-medium" style={{ paddingLeft: 4 }}>Zoom denah:</span><Button variant="outline" size="sm" title="Perkecil denah" aria-label="Zoom Out denah" disabled={zoom <= 0.5} onClick={() => setZoomCentered(zoom - 0.25)}><ZoomOut className="size-4" /> Zoom Out</Button><span className="text-sm font-medium" style={{ minWidth: 44, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span><Button variant="outline" size="sm" title="Perbesar denah" aria-label="Zoom In denah" disabled={zoom >= 3} onClick={() => setZoomCentered(zoom + 0.25)}><ZoomIn className="size-4" /> Zoom In</Button><Button variant="default" size="sm" title="Fit to Screen: sesuaikan denah selebar area ini" aria-label="Fit to Screen denah" onClick={() => setView({ x: 0, y: 0, w: 700, h: 300 })}><Maximize2 className="size-4" /> Fit to Screen</Button></div>
    <svg ref={svgRef} width="100%" height="100%" viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block', background: 'var(--muted)', touchAction: 'none' }} onPointerDown={onSvgDown} onPointerMove={onMove} onPointerUp={onUp}><rect x={view.x} y={view.y} width={view.w} height={view.h} fill="var(--muted)" />{shown.map(r => { const total = products.reduce((a, p) => a + r.levels.reduce((b, lv) => b + (stock[`${p.id}|${r.id}|${lv}`] || 0), 0), 0); return (<g key={r.id} transform={`translate(${r.x} ${r.y}) rotate(${r.rot} ${r.w / 2} ${r.h / 2})`} onPointerDown={e => onDown(e, r)} onClick={() => { if (suppressClick.current) return; setSelId(r.id); }} style={{ cursor: canEdit ? 'grab' : 'pointer' }}><rect width={r.w} height={r.h} rx="10" fill={r.type === 'retur' ? '#f97316' : 'var(--card)'} stroke={dragId === r.id ? 'var(--accent)' : 'var(--border)'} strokeWidth="2" /><text x={r.w / 2} y="28" textAnchor="middle" fontSize="14" fontWeight="700" fill={r.type === 'retur' ? '#fff' : 'var(--foreground)'}>{r.name}{r.type === 'retur' ? ' — RETUR' : ''}</text><text x={r.w / 2} y="50" textAnchor="middle" fontSize="12" fill={r.type === 'retur' ? '#fff' : 'var(--muted-foreground)'}>{r.levels.length} level • {total} unit</text><text x={r.w / 2} y="70" textAnchor="middle" fontSize="11" fill={r.type === 'retur' ? '#fff' : 'var(--muted-foreground)'}>rot {r.rot}° • {r.branchId}</text></g>); })}</svg></div><p className="text-xs text-muted-foreground">Zoom ala Google Maps: jendela denah ukurannya TETAP (tidak ikut membesar/mengecil, tidak menambah scrollbar) — yang membesar/mengecil adalah ISI denah (balok rak) di dalamnya. Tombol tetap di pojok kanan atas di dalam jendela denah. Zoom Out / Zoom In mengubah pembesaran 50%–300% di sekitar tengah pandangan, Fit menampilkan seluruh denah lagi, dan geser area kosong denah untuk menggeser pandangan (pan) seperti drag di Maps.</p>
    {sel && (<div className="space-y-3"><div className="flex flex-wrap items-center gap-2"><b>{sel.branchId} — {sel.name}{sel.type === 'retur' ? ' (RETUR)' : ''}</b>{canEdit && <Button variant="outline" size="sm" onClick={() => onUpdateRack(sel.id, { rot: (sel.rot + 90) % 360 })}><RotateCw className="size-4" /> Rotate 90°</Button>}<Button onClick={() => onOpenRack(sel.id)}>Opname Rak Ini</Button><Button variant="outline" size="sm" onClick={() => printLabels(sel.levels.map(lv => labelFor(sel, lv)))}><Printer className="size-4" /> Cetak Label Rak</Button>{canEdit && <Button variant="destructive" size="sm" onClick={() => { if (!confirm(`Hapus rak ${sel.name}? Rak dengan stok > 0 ditolak.`)) return; const msg = onDeleteRack(sel.id); if (msg !== 'OK') alert(msg); else setSelId(null); }}><Trash2 className="size-4" /> Hapus Rak</Button>}</div>
      {canEdit && (<Card><CardContent className="grid gap-3 pt-6 md:grid-cols-4"><div><label className="text-sm font-medium">Nama rak</label><Input className="mt-1" value={editName} onChange={e => setEditName(e.target.value)} /></div><div><label className="text-sm font-medium">Lebar (w)</label><Input className="mt-1" type="number" value={editW} onChange={e => setEditW(Number(e.target.value))} /></div><div><label className="text-sm font-medium">Tinggi (h)</label><Input className="mt-1" type="number" value={editH} onChange={e => setEditH(Number(e.target.value))} /></div><FieldSelect label="Rotate" value={String(editRot)} onChange={(v) => setEditRot(Number(v))} options={['0', '90', '180', '270'].map(x => ({ value: x, label: `${x}°` }))} /><div className="md:col-span-4"><label className="text-sm font-medium">Level (ubah nama di sini — stok ikut pindah ke nama baru; hapus level ditolak bila stok &gt; 0)</label>{editLevels.map((lv, i) => (<div key={i} className="mt-2 flex gap-2"><Input value={lv} onChange={e => setEditLevels(prev => prev.map((x, j) => j === i ? e.target.value : x))} /><Button variant="outline" size="sm" onClick={() => { const msg = onDeleteLevel(sel.id, sel.levels[i]); if (msg !== 'OK') alert(msg); else setEditLevels(prev => prev.filter((_, j) => j !== i)); }}>Hapus Level</Button></div>))}<Button variant="outline" size="sm" className="mt-2" onClick={() => setEditLevels(prev => [...prev, `Level ${prev.length + 1}`])}>+ Tambah Level</Button></div><div><Button onClick={saveEdit}>Simpan Perubahan Rak</Button></div></CardContent></Card>)}
      <div>{sel.levels.map(lv => { const tot = products.reduce((a, p) => a + (stock[`${p.id}|${sel.id}|${lv}`] || 0), 0); return (<Card key={lv} className="mt-2"><CardContent className="flex flex-wrap items-center justify-between gap-2 py-3"><span>{lv} — {tot} unit</span><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => printLabels([labelFor(sel, lv)])}><Printer className="size-4" /> Label</Button><Button size="sm" onClick={() => onOpenLevel(sel.id, lv)}>Opname Level Ini</Button></div></CardContent></Card>); })}</div></div>)}
  </CardContent></Card>);
}
function SessionCard({ sess, products, racks, active, onSelect, onScan, onDeleteScan, onMutation, onPreview, onDeleteSession, canDeleteSession }: { sess: Session; products: Product[]; racks: Rack[]; active: boolean; onSelect: () => void; onScan: (barcode: string, qty: number, mode: string, rackId: string, level: string) => void; onDeleteScan: (scanId: string) => void; onMutation: (m: Omit<SessionMutation, 'id' | 'time' | 'user'>) => void; onPreview: () => void; onDeleteSession?: () => void; canDeleteSession?: boolean }) {
  const [barcode, setBarcode] = useState(''); const [qty, setQty] = useState(1); const [mode, setMode] = useState('+1 per scan');
  const [rackId, setRackId] = useState(sess.racks[0] || '');
  const allowedLevels = levelsFor(sess, rackId, racks);
  const [level, setLevel] = useState(allowedLevels[0] || '');
  const [qrRack, setQrRack] = useState('');
  /** Scan QR rak → pindah Rak/Level aktif OTOMATIS, tanpa mengubah scope
   *  sesi (snapshot sudah dibekukan saat sesi dibuat). QR di luar scope
   *  ditolak, bukan diam-diam memperluas scope. */
  const applyRackQr = (code: string): boolean => {
    const q = parseRackQr(code);
    if (!q) { alert('QR ini bukan QR rak Apname. QR rak berformat APNAME|cabang|rak|level (yang ditempel di rak).'); return false; }
    if (q.branchId !== sess.branchId) { alert(`QR ini cabang ${q.branchId}, sedangkan sesi ini cabang ${sess.branchId}. QR rak cabang lain tidak bisa dipakai di sesi ini.`); return false; }
    if (!inSessionScope(sess, q.rackId, q.level)) { alert(`QR ini (${q.rackId} / ${q.level}) di luar scope sesi ini (scope: ${scopeLabel(sess)}). Buat sesi baru untuk rak itu, atau pilih scope yang mencakup rak itu sebelum sesi dibuat.`); return false; }
    setRackId(q.rackId); setLevel(q.level); setQrRack('');
    return true;
  };
  useEffect(() => { if (!allowedLevels.includes(level)) setLevel(allowedLevels[0] || ''); }, [rackId]);
  const [camOn, setCamOn] = useState(false); const videoRef = useRef<HTMLVideoElement | null>(null); const streamRef = useRef<MediaStream | null>(null);
  const [showMut, setShowMut] = useState(false); const [scanPage, setScanPage] = useState(1); const [scanPageSize, setScanPageSize] = useState<number | 'Semua'>(25); const [scanScope, setScanScope] = useState<'aktif' | 'semua'>('aktif');
  const [mutProd, setMutProd] = useState(products[0]?.id || ''); const [mutSearch, setMutSearch] = useState(products[0] ? `${products[0].name} — ${products[0].variant} (${products[0].sku}) • ${branchIdOfProduct(products[0])}` : ''); const [mutSuggestOpen, setMutSuggestOpen] = useState(false); const mutSuggestions = mutSearch.trim() === '' ? [] : products.filter(pr => branchIdOfProduct(pr) === sess.branchId && matchesQuery(pr, mutSearch)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 8); const [mutKind, setMutKind] = useState('Penjualan'); const [mutDir, setMutDir] = useState<'Masuk' | 'Keluar'>('Keluar'); const [mutQty, setMutQty] = useState(1); const [mutRack, setMutRack] = useState(''); const [mutRef, setMutRef] = useState(''); const [mutNote, setMutNote] = useState('');
  const stopCam = () => { streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null; setCamOn(false); };
  useEffect(() => () => { streamRef.current?.getTracks().forEach(t => t.stop()); }, []);
  const startCam = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) { alert('Perangkat ini tidak mendukung kamera di browser. Pakai input manual.'); return; }
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream; setCamOn(true);
      setTimeout(() => { if (videoRef.current) videoRef.current.srcObject = stream; }, 50);
      const Detector = (window as unknown as { BarcodeDetector?: new () => { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
      if (!Detector) { alert('Browser ini tidak mendukung BarcodeDetector. Kamera tetap dibuka, tapi hasil scan harus diketik manual.'); return; }
      const detector = new Detector();
      const timer = setInterval(async () => {
        try {
          if (!videoRef.current || videoRef.current.readyState < 2) return;
          const codes = await detector.detect(videoRef.current);
          if (codes[0]?.rawValue) { if (codes[0].rawValue.startsWith('APNAME|')) { applyRackQr(codes[0].rawValue); } else { onScan(codes[0].rawValue, mode === '+1 per scan' ? 1 : qty, 'Scan Kamera', rackId, level); } clearInterval(timer); stopCam(); }
        } catch { /* keep scanning until stopped */ }
      }, 600);
      stream.getTracks()[0]?.addEventListener('ended', () => clearInterval(timer));
    } catch { alert('Izin kamera ditolak atau kamera tidak tersedia. Pakai input manual.'); }
  };
  return (<Card className="mb-3"><CardContent className="pt-6"><div className="flex flex-wrap items-center justify-between gap-2"><div><b>{sess.id} — {sess.title}</b> <Badge>{sess.status}</Badge> <Badge variant="secondary">{sess.branchId} • {scopeLabel(sess)}</Badge><div className="text-xs text-muted-foreground">Dibuat: {fmtShort(sess.createdAt)} • Sync saat sesi: {sess.externalAt ? fmtShort(sess.externalAt) : '—'} • Scan: {sess.scans.length} • Mutasi: {(sess.mutations || []).length}</div></div><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={onSelect}>{active ? 'Sesi Aktif' : 'Pilih Sesi Ini'}</Button>{canDeleteSession && onDeleteSession && <Button variant="destructive" size="sm" onClick={onDeleteSession}><Trash2 className="size-4" /> Hapus Sesi</Button>}</div></div>
    {sess.status === 'Berjalan' && (<><div className="mt-3 grid gap-2 md:grid-cols-3"><div className="md:col-span-2"><label className="text-sm font-medium">Scan QR Rak — otomatis pindah Rak / Level</label><Input className="mt-1" value={qrRack} onChange={e => setQrRack(e.target.value)} placeholder="APNAME|KWSN|KWSN-A|L1 — scan / tempel QR rak di sini, lalu Enter" onKeyDown={e => { if (e.key === 'Enter' && qrRack) applyRackQr(qrRack); }} /><p className="mt-1 text-xs text-muted-foreground">Scan QR yang ditempel di rak (bukan barcode produk). Rak &amp; Level di bawah langsung pindah ke rak itu — scan produk berikutnya otomatis masuk ke rak/level itu. QR di luar scope sesi ditolak, scope tidak berubah.</p></div><div className="flex items-end"><Button variant="outline" onClick={() => { if (qrRack) applyRackQr(qrRack); }}>Pindah ke QR Ini</Button></div></div><div className="mt-3 grid gap-2 md:grid-cols-4"><div><label className="text-sm font-medium">Barcode / SKU</label><Input className="mt-1" value={barcode} onChange={e => setBarcode(e.target.value)} placeholder="8990124000135" onKeyDown={e => { if (e.key === 'Enter' && barcode) { if (barcode.trim().startsWith('APNAME|')) { applyRackQr(barcode); setBarcode(''); } else { onScan(barcode, mode === '+1 per scan' ? 1 : qty, mode, rackId, level); setBarcode(''); } } }} /></div><FieldSelect label="Mode" value={mode} onChange={setMode} options={['+1 per scan', 'Scan sekali, isi jumlah', 'Input manual'].map(x => ({ value: x, label: x }))} /><div><label className="text-sm font-medium">Jumlah</label><Input className="mt-1" type="number" min={1} value={qty} onChange={e => setQty(Number(e.target.value))} /></div><div className="flex gap-1"><div className="flex-1"><FieldSelect label="Rak" value={rackId} onChange={setRackId} options={sess.racks.map(r => ({ value: r, label: r }))} /></div><div className="flex-1"><FieldSelect label="Level" value={level} onChange={setLevel} options={allowedLevels.map(l => ({ value: l, label: l }))} /></div></div></div>
    <div className="mt-3 flex flex-wrap gap-2"><Button onClick={() => { if (!barcode) return; if (barcode.trim().startsWith('APNAME|')) { applyRackQr(barcode); setBarcode(''); } else { onScan(barcode, mode === '+1 per scan' ? 1 : qty, mode, rackId, level); setBarcode(''); } }}><ScanLine className="size-4" /> Scan / Tambah</Button><Button variant="outline" onClick={camOn ? stopCam : startCam}><Camera className="size-4" /> {camOn ? 'Tutup Kamera' : 'Scan Kamera'}</Button><Button variant="outline" onClick={onPreview}><Eye className="size-4" /> Pratinjau Mini Laporan</Button><Button variant="outline" onClick={() => setShowMut(v => !v)}>Catat Mutasi Selama Opname</Button></div>
    {camOn && <video ref={videoRef} autoPlay playsInline muted className="mt-3 w-full max-w-md rounded-md border" />}
    {showMut && (<Card className="mt-3"><CardContent className="grid gap-3 pt-6 md:grid-cols-3"><div className="relative"><label className="text-sm font-medium">Produk (ketik nama / SKU / varian)</label><Input className="mt-1" value={mutSearch} placeholder="Ketik Battery, 8990124000135, BATT-HX…" onFocus={() => setMutSuggestOpen(true)} onBlur={() => setTimeout(() => setMutSuggestOpen(false), 150)} onChange={e => { const v = e.target.value; setMutSearch(v); setMutSuggestOpen(true); const originProds = products.filter(pr => branchIdOfProduct(pr) === sess.branchId); const exact = originProds.find(pr => `${pr.name} — ${pr.variant} (${pr.sku}) • ${branchIdOfProduct(pr)}`.toLowerCase() === v.toLowerCase() || `${pr.name} — ${pr.variant} (${pr.sku})`.toLowerCase() === v.toLowerCase() || pr.sku === v || pr.barcode === v); setMutProd(exact ? exact.id : ''); }} />{mutSuggestOpen && mutSearch.trim() !== '' && (<div className="absolute left-0 right-0 z-30 mt-1 max-h-56 overflow-auto rounded-md border bg-card shadow-md">{mutSuggestions.map(pr => (<button key={pr.id} type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-muted" onMouseDown={() => { setMutProd(pr.id); setMutSearch(`${pr.name} — ${pr.variant} (${pr.sku}) • ${branchIdOfProduct(pr)}`); setMutSuggestOpen(false); }}>{pr.name} — {pr.variant} ({pr.sku}) • {branchIdOfProduct(pr)}</button>))}{mutSuggestions.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">Tidak ada produk yang cocok di cabang sesi ini ({sess.branchId}).</p>}</div>)}{mutProd ? <p className="mt-1 text-xs text-muted-foreground">Terpilih: {products.find(pr => pr.id === mutProd)?.name} — {products.find(pr => pr.id === mutProd)?.variant} • {products.find(pr => pr.id === mutProd) ? branchIdOfProduct(products.find(pr => pr.id === mutProd)!) : ''}</p> : <p className="mt-1 text-xs text-muted-foreground">Pilih dari saran di bawah — saran hanya produk cabang sesi ini ({sess.branchId}), ketik bebas saja tidak akan tersimpan.</p>}</div><FieldSelect label="Jenis" value={mutKind} onChange={setMutKind} options={['Penjualan', 'Pembelian/Penerimaan', 'Retur', 'Mutasi Antar Rak/Cabang', 'Rusak', 'Hilang', 'Koreksi', 'Lainnya'].map(x => ({ value: x, label: x }))} /><FieldSelect label="Arah" value={mutDir} onChange={(v) => setMutDir(v as 'Masuk' | 'Keluar')} options={[{ value: 'Masuk', label: 'Masuk (+)' }, { value: 'Keluar', label: 'Keluar (−)' }]} /><div><label className="text-sm font-medium">Qty</label><Input className="mt-1" type="number" min={1} value={mutQty} onChange={e => setMutQty(Number(e.target.value))} /></div><FieldSelect label="Rak asal (bila diketahui)" value={mutRack} onChange={setMutRack} options={[{ value: '', label: 'Rak Tidak Diketahui — Total Cabang' }, ...sess.racks.map(r => ({ value: r, label: r }))]} /><div><label className="text-sm font-medium">Referensi</label><Input className="mt-1" value={mutRef} onChange={e => setMutRef(e.target.value)} placeholder="No. nota / referensi" /></div><div className="md:col-span-3"><label className="text-sm font-medium">Keterangan</label><Input className="mt-1" value={mutNote} onChange={e => setMutNote(e.target.value)} /></div><div><Button onClick={() => { if (!mutProd || mutQty < 1) { alert('Pilih produk dan qty minimal 1.'); return; } onMutation({ productId: mutProd, kind: mutKind, direction: mutDir, qty: mutQty, rackId: mutRack, reference: mutRef, note: mutNote }); setShowMut(false); }}>Simpan Mutasi (Snapshot Tidak Diubah)</Button></div></CardContent></Card>)}
    <div className="mt-3"><div className="mb-2 flex flex-wrap items-center gap-2"><b>Riwayat Scan</b><span className="text-xs text-muted-foreground">Default hanya menampilkan scan di Rak/Level yang sedang aktif ({rackId} / {level}), supaya petugas tidak tercampur barang rak lain. Tekan Lihat Semua untuk melihat semua scan sesi ini. Salah scan? Hapus barisnya di bawah, atau batalkan scan terakhir. Hapus hanya bisa sebelum sesi dikunci — setelah dikunci, angka sudah jadi laporan.</span>{sess.scans.length > 0 && <Button variant="outline" size="sm" onClick={() => { const last = sess.scans[0]; const p = products.find(x => x.id === last.productId); if (confirm(`Batalkan scan terakhir: ${p?.name} — ${p?.variant}, ${last.qty} unit di ${last.rackId} / ${last.level}?`)) onDeleteScan(last.id); }}>Batalkan Scan Terakhir</Button>}</div><div className="mb-2 flex flex-wrap gap-2"><Button variant={scanScope === 'aktif' ? 'default' : 'outline'} size="sm" onClick={() => { setScanScope('aktif'); setScanPage(1); }}>Hanya {rackId} / {level} (aktif)</Button><Button variant={scanScope === 'semua' ? 'default' : 'outline'} size="sm" onClick={() => { setScanScope('semua'); setScanPage(1); }}>Lihat Semua ({sess.scans.length})</Button></div>{(() => { const filteredScans = scanScope === 'semua' ? sess.scans : sess.scans.filter(s => s.rackId === rackId && s.level === level); return (<><div className="max-h-[420px] overflow-auto"><Table><TableHeader><TableRow><TableHead>Waktu Scan</TableHead><TableHead>Petugas</TableHead><TableHead>Produk</TableHead><TableHead>SKU</TableHead><TableHead>Varian</TableHead><TableHead>Rak / Level</TableHead><TableHead>Jumlah</TableHead><TableHead>Mode</TableHead><TableHead>Aksi</TableHead></TableRow></TableHeader><TableBody>{paginate(filteredScans, Math.min(scanPage, totalPagesFor(filteredScans.length, scanPageSize)), scanPageSize).map(s => { const p = products.find(x => x.id === s.productId); return (<TableRow key={s.id}><TableCell>{fmtShort(s.time)}</TableCell><TableCell>{s.user}</TableCell><TableCell>{p?.name}</TableCell><TableCell>{p?.sku}</TableCell><TableCell>{p?.variant}</TableCell><TableCell>{s.rackId} / {s.level}</TableCell><TableCell>{s.qty}</TableCell><TableCell>{s.mode}</TableCell><TableCell><Button variant="destructive" size="sm" onClick={() => { if (confirm(`Hapus scan ini: ${p?.name} — ${p?.variant}, ${s.qty} unit di ${s.rackId} / ${s.level}? Jumlah fisik di pratinjau akan berkurang ${s.qty}.`)) onDeleteScan(s.id); }}><Trash2 className="size-4" /> Hapus</Button></TableCell></TableRow>); })}</TableBody></Table></div><Pager page={Math.min(scanPage, totalPagesFor(filteredScans.length, scanPageSize))} pageSize={scanPageSize} total={filteredScans.length} onPage={setScanPage} onPageSize={(n) => { setScanPageSize(n); setScanPage(1); }} />{filteredScans.length === 0 && <p className="mt-2 text-sm text-muted-foreground">{scanScope === 'aktif' ? `Belum ada scan di ${rackId} / ${level} ini — pindah Rak/Level di atas, atau tekan Lihat Semua.` : 'Belum ada scan di sesi ini.'}</p>}</>); })()}</div><div className="mt-4"><div className="mb-2 flex flex-wrap items-center gap-2"><b>Riwayat Mutasi Selama Opname</b><span className="text-xs text-muted-foreground">Mutasi yang dicatat lewat tombol “Catat Mutasi Selama Opname” selama sesi ini masih berjalan. Mutasi TIDAK mengubah snapshot, tapi SUDAH diperhitungkan di pratinjau: Stok Disesuaikan = Snapshot + Mutasi Masuk − Mutasi Keluar, jadi selisih di pratinjau sudah bersih dari mutasi ini. Mutasi tanpa Rak Asal berarti total cabang (bukan satu rak).</span></div>{(sess.mutations || []).length === 0 ? <p className="text-sm text-muted-foreground">Belum ada mutasi selama sesi ini — kalau ada penjualan/penerimaan/mutasi saat mengopname, catat lewat tombol “Catat Mutasi Selama Opname” di atas, maka muncul di list ini.</p> : (<div className="max-h-[420px] overflow-auto"><Table><TableHeader><TableRow><TableHead>Waktu</TableHead><TableHead>Petugas</TableHead><TableHead>Produk</TableHead><TableHead>SKU</TableHead><TableHead>Varian</TableHead><TableHead>Jenis</TableHead><TableHead>Arah</TableHead><TableHead>Qty</TableHead><TableHead>Rak Asal</TableHead><TableHead>Referensi</TableHead><TableHead>Keterangan</TableHead></TableRow></TableHeader><TableBody>{(sess.mutations || []).map(m => { const p = products.find(x => x.id === m.productId); return (<TableRow key={m.id}><TableCell>{fmtShort(m.time)}</TableCell><TableCell>{m.user}</TableCell><TableCell>{p?.name}</TableCell><TableCell>{p?.sku}</TableCell><TableCell>{p?.variant}</TableCell><TableCell>{m.kind}</TableCell><TableCell><b>{m.direction === 'Masuk' ? '+' : '−'}</b></TableCell><TableCell><b>{m.qty}</b></TableCell><TableCell>{m.rackId || 'Total Cabang'}</TableCell><TableCell>{m.reference || '—'}</TableCell><TableCell>{m.note || '—'}</TableCell></TableRow>); })}</TableBody></Table></div>)}</div></>)}
    {sess.status !== 'Berjalan' && <div className="mt-3"><Button variant="outline" onClick={onPreview}>Lihat Pratinjau / Laporan</Button> <Badge variant="secondary">Dikunci: {sess.lockedAt ? fmtShort(sess.lockedAt) : '—'}</Badge></div>}
  </CardContent></Card>);
}
type PreviewRow = { pid: string; rid: string; lv: string; sys: number; mutIn: number; mutOut: number; adjusted: number; fis: number; diff: number; scanned: boolean; last?: ScanRow; p?: Product };
function PreviewBody({ previewRows, unscannedRows, filter, setFilter }: { previewRows: PreviewRow[]; unscannedRows: { pid: string; rid: string; lv: string; sys: number; mutIn: number; mutOut: number; adjusted: number; p?: Product }[]; filter: string; setFilter: (s: string) => void }) {
  const [showUnscanned, setShowUnscanned] = useState(false); const [pbPage, setPbPage] = useState(1); const [pbPageSize, setPbPageSize] = useState<number | 'Semua'>(25);
  const [levelFilter, setLevelFilter] = useState('semua');
  const rows = previewRows;
  const levelOptions = Array.from(new Set(rows.map(r => `${r.rid} / ${r.lv}`))).sort();
  const statusShown = rows.filter(r => filter === 'semua' ? true : filter === 'selisih' ? r.diff !== 0 : filter === 'lebih' ? r.diff > 0 : r.diff < 0);
  const shown = (levelFilter === 'semua' ? statusShown : statusShown.filter(r => `${r.rid} / ${r.lv}` === levelFilter)).sort((a, b) => (a.rid.localeCompare(b.rid) || a.lv.localeCompare(b.lv) || Math.abs(b.diff) - Math.abs(a.diff)));
  const groupedShown: { label: string; rows: typeof shown }[] = [];
  for (const r of shown) { const label = `${r.rid} / ${r.lv}`; const g = groupedShown.find(x => x.label === label); if (g) g.rows.push(r); else groupedShown.push({ label, rows: [r] }); }
  const cocok = rows.filter(r => r.diff === 0).length, lebih = rows.filter(r => r.diff > 0).length, kurang = rows.filter(r => r.diff < 0).length; const counted = rows.length; const acc = counted ? Math.round((cocok / counted) * 100) : 0;
  return (<div><div className="grid grid-cols-2 gap-2 md:grid-cols-5"><Card><CardContent className="pt-4">Baris hasil scan<br /><b>{rows.length}</b></CardContent></Card><Card><CardContent className="pt-4">Cocok<br /><b>{cocok}</b></CardContent></Card><Card><CardContent className="pt-4">Lebih<br /><b>{lebih}</b></CardContent></Card><Card><CardContent className="pt-4">Kurang<br /><b>{kurang}</b></CardContent></Card><Card><CardContent className="pt-4">Belum dihitung (cek terpisah)<br /><b>{unscannedRows.length}</b></CardContent></Card></div><p className="mt-2 text-sm">Pratinjau ini HANYA berisi produk yang sudah discan di sesi ini. Produk yang belum discan TIDAK tampil di tabel utama, karena fisiknya belum diketahui — bukan 0. Akurasi: <b>{acc}%</b> (dari {counted} baris hasil scan) • Stok Sistem Disesuaikan = Snapshot + Mutasi Masuk − Mutasi Keluar • Selisih Akhir = Fisik − Disesuaikan</p><div className="mt-3 flex flex-wrap gap-2">{['semua', 'selisih', 'lebih', 'kurang'].map(f => <Button key={f} variant={filter === f ? 'default' : 'outline'} size="sm" onClick={() => { setFilter(f); setPbPage(1); }}>{f}</Button>)}<Button variant={showUnscanned ? 'default' : 'outline'} size="sm" onClick={() => setShowUnscanned(v => !v)}>Cek Belum Dihitung ({unscannedRows.length}) — bukan bagian pratinjau</Button></div><div className="mt-3 flex flex-wrap gap-2"><Button variant={levelFilter === 'semua' ? 'default' : 'outline'} size="sm" onClick={() => { setLevelFilter('semua'); setPbPage(1); }}>Semua level (tetap per kelompok)</Button>{levelOptions.map(lv => <Button key={lv} variant={levelFilter === lv ? 'default' : 'outline'} size="sm" onClick={() => { setLevelFilter(lv); setPbPage(1); }}>{lv}</Button>)}</div>{rows.length === 0 && <p className="mt-3 text-sm text-muted-foreground">Belum ada hasil scan di sesi ini — pratinjau kosong karena belum ada produk yang discan, bukan karena ada produk kosong.</p>}{levelFilter === 'semua' ? (<div className="max-h-[400px] overflow-auto">{groupedShown.map(g => (<div key={g.label} className="mt-3"><p className="text-sm font-medium">📦 {g.label} — {g.rows.length} baris • Cocok {g.rows.filter(r => r.diff === 0).length} • Lebih {g.rows.filter(r => r.diff > 0).length} • Kurang {g.rows.filter(r => r.diff < 0).length}</p><Table><TableHeader><TableRow><TableHead>Produk</TableHead><TableHead>Rak / Level</TableHead><TableHead>Snapshot</TableHead><TableHead>Mutasi</TableHead><TableHead>Disesuaikan</TableHead><TableHead>Fisik (Hasil Scan)</TableHead><TableHead>Selisih Akhir</TableHead><TableHead>Status</TableHead><TableHead>Waktu Scan Terakhir</TableHead></TableRow></TableHeader><TableBody>{g.rows.map(r => <TableRow key={r.pid + r.rid + r.lv}><TableCell>{r.p?.name} — {r.p?.variant} ({r.p?.sku})</TableCell><TableCell>{r.rid} / {r.lv}</TableCell><TableCell>{r.sys}</TableCell><TableCell>{r.mutIn === 0 && r.mutOut === 0 ? '—' : `+${r.mutIn} / −${r.mutOut}`}</TableCell><TableCell>{r.adjusted}</TableCell><TableCell><b>{r.fis}</b></TableCell><TableCell>{r.diff}</TableCell><TableCell>{r.diff === 0 ? 'Cocok' : r.diff > 0 ? 'Lebih' : 'Kurang'}</TableCell><TableCell>{r.last ? fmtShort(r.last.time) : '—'}</TableCell></TableRow>)}</TableBody></Table></div>))}{groupedShown.length === 0 && <p className="mt-3 text-sm text-muted-foreground">Tidak ada baris untuk filter ini.</p>}</div>) : (<><div className="max-h-[400px] overflow-auto"><Table><TableHeader><TableRow><TableHead>Produk</TableHead><TableHead>Rak / Level</TableHead><TableHead>Snapshot</TableHead><TableHead>Mutasi</TableHead><TableHead>Disesuaikan</TableHead><TableHead>Fisik (Hasil Scan)</TableHead><TableHead>Selisih Akhir</TableHead><TableHead>Status</TableHead><TableHead>Waktu Scan Terakhir</TableHead></TableRow></TableHeader><TableBody>{paginate(shown, Math.min(pbPage, totalPagesFor(shown.length, pbPageSize)), pbPageSize).map(r => <TableRow key={r.pid + r.rid + r.lv}><TableCell>{r.p?.name} — {r.p?.variant} ({r.p?.sku})</TableCell><TableCell>{r.rid} / {r.lv}</TableCell><TableCell>{r.sys}</TableCell><TableCell>{r.mutIn === 0 && r.mutOut === 0 ? '—' : `+${r.mutIn} / −${r.mutOut}`}</TableCell><TableCell>{r.adjusted}</TableCell><TableCell><b>{r.fis}</b></TableCell><TableCell>{r.diff}</TableCell><TableCell>{r.diff === 0 ? 'Cocok' : r.diff > 0 ? 'Lebih' : 'Kurang'}</TableCell><TableCell>{r.last ? fmtShort(r.last.time) : '—'}</TableCell></TableRow>)}</TableBody></Table></div><Pager page={Math.min(pbPage, totalPagesFor(shown.length, pbPageSize))} pageSize={pbPageSize} total={shown.length} onPage={setPbPage} onPageSize={(n) => { setPbPageSize(n); setPbPage(1); }} /></>)}{showUnscanned && (<div className="mt-4"><p className="text-sm font-medium">Belum dihitung — produk yang diharapkan ada (snapshot) tapi belum discan di sesi ini.</p><p className="text-sm text-muted-foreground">Daftar ini HANYA untuk cek sebelum kunci. Barang-barang ini belum discan, jadi fisiknya belum diketahui (bukan 0), dan tidak masuk total baris, akurasi, Excel Detail, maupun Adjustment. Jangan kunci sesi sebelum daftar ini dicek — barang yang tidak discan tidak akan masuk laporan/adjustment. Daftar ini juga dikelompokkan per level, sama seperti pratinjau di atas.</p>{(() => { const groups: { label: string; rows: typeof unscannedRows }[] = []; for (const u of [...unscannedRows].sort((a, b) => (a.rid.localeCompare(b.rid) || a.lv.localeCompare(b.lv)))) { const label = `${u.rid} / ${u.lv}`; const g = groups.find(x => x.label === label); if (g) g.rows.push(u); else groups.push({ label, rows: [u] }); } return (<div className="max-h-[300px] overflow-auto">{groups.map(g => (<div key={g.label} className="mt-3"><p className="text-sm font-medium">📦 {g.label} — {g.rows.length} produk</p><Table><TableHeader><TableRow><TableHead>Produk</TableHead><TableHead>Rak / Level</TableHead><TableHead>Snapshot</TableHead><TableHead>Mutasi</TableHead><TableHead>Disesuaikan</TableHead></TableRow></TableHeader><TableBody>{g.rows.map(u => <TableRow key={u.pid + u.rid + u.lv}><TableCell>{u.p?.name} — {u.p?.variant} ({u.p?.sku})</TableCell><TableCell>{u.rid} / {u.lv}</TableCell><TableCell>{u.sys}</TableCell><TableCell>+{u.mutIn} / −{u.mutOut}</TableCell><TableCell>{u.adjusted}</TableCell></TableRow>)}</TableBody></Table></div>))}</div>); })()}{unscannedRows.length === 0 && <p className="mt-2 text-sm text-muted-foreground">Tidak ada — semua produk yang diharapkan sudah discan.</p>}</div>)}</div>);
}
