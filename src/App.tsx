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
import { isSupabaseConfigured, loadRacksFromSupabase } from '@/lib/supabase';
import {
  LayoutDashboard, Package, Map, ClipboardList, FileText, ArrowLeftRight, Settings as SettingsIcon,
  Menu, RefreshCw, Camera, Eye, Plus, Trash2, RotateCw, ScanLine, Layers,
} from 'lucide-react';

type Role = 'super' | 'admin' | 'karyawan';
type User = { name: string; role: Role; branchId: string | null };
type ScanRow = { id: string; time: number; user: string; productId: string; rackId: string; level: string; qty: number; mode: string; barcode: string };
type SessionMutation = { id: string; time: number; user: string; productId: string; kind: string; direction: 'Masuk' | 'Keluar'; qty: number; rackId: string; reference: string; note: string };
type MoveRow = { id: string; time: number; user: string; productId: string; fromRack: string; fromLevel: string; toRack: string; toLevel: string; qty: number; reason: string; photo: string };
type Session = { id: string; title: string; branchId: string; racks: string[]; scopeLevels?: Record<string, string[]>; status: 'Berjalan' | 'Selesai'; createdAt: number; createdBy: string; lockedAt: number | null; snapshot: Record<string, number>; scans: ScanRow[]; mutations: SessionMutation[]; adjustmentStatus: 'Menunggu' | 'Disetujui'; externalAt: number | null };
type View = 'dashboard' | 'stok' | 'master' | 'visual' | 'opname' | 'laporan' | 'pindah' | 'settings';
const DEMO: Record<string, User> = { 'super@opname': { name: 'Super Admin', role: 'super', branchId: null }, 'admin@kwsn': { name: 'Admin KWSN', role: 'admin', branchId: 'KWSN' }, 'karyawan@kwsn': { name: 'Karyawan KWSN', role: 'karyawan', branchId: 'KWSN' } };
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
];
function load<T>(k: string, f: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : f; } catch { return f; } }
function save(k: string, v: unknown) { localStorage.setItem(k, JSON.stringify(v)); }
function downloadBlob(blob: Blob, name: string) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); }
function scopeLabel(s: Session): string {
  if (!s.scopeLevels) return s.racks.join(', ');
  return Object.entries(s.scopeLevels).map(([rid, lvs]) => `${rid}: ${lvs.join(', ')}`).join(' • ');
}
function levelsFor(sess: Session, rackId: string, allRacks: Rack[]): string[] {
  const scoped = sess.scopeLevels?.[rackId];
  if (scoped) return scoped;
  return allRacks.find(r => r.id === rackId)?.levels || [];
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
  const [products] = useState<Product[]>(() => load('opname-products', SEED_PRODUCTS));
  const [racks, setRacks] = useState<Rack[]>(() => load('opname-racks', seedRacks()));
  const [stock, setStock] = useState<Record<string, number>>(() => load('opname-stock', seedStock()));
  const [sessions, setSessions] = useState<Session[]>(() => load('opname-sessions', []));
  const [moves, setMoves] = useState<MoveRow[]>(() => load('opname-moves', []));
  const [lastSync, setLastSync] = useState<number | null>(() => load('opname-lastSync', null));
  const [now, setNow] = useState(Date.now());
  const [inoxUser, setInoxUser] = useState<string>(() => load('opname-inox-user', ''));
  const [inoxConnected, setInoxConnected] = useState<boolean>(() => load('opname-inox-connected', false));
  const [search, setSearch] = useState('');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewFilter, setPreviewFilter] = useState('semua');
  const [sessTitle, setSessTitle] = useState('Opname Bulanan Oktober 2026');
  const [sessBranch, setSessBranch] = useState('KWSN');
  const [sessRacks, setSessRacks] = useState<string[]>(['KWSN-A']);
  const [sessLevelScope, setSessLevelScope] = useState<Record<string, string[]> | null>(null);
  const [requestedVisualBranch, setRequestedVisualBranch] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => load('opname-sidebar-collapsed', false));
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mvProd, setMvProd] = useState('p1'); const [mvFromRack, setMvFromRack] = useState('KWSN-A'); const [mvFromLevel, setMvFromLevel] = useState('Level 1');
  const [mvToRack, setMvToRack] = useState('KWSN-B'); const [mvToLevel, setMvToLevel] = useState('Level 1'); const [mvQty, setMvQty] = useState(1); const [mvReason, setMvReason] = useState('Penataan Ulang');
  const [mvPhoto, setMvPhoto] = useState('');
  useEffect(() => { save('opname-user', user); }, [user]);
  useEffect(() => { save('opname-theme', theme); }, [theme]);
  useEffect(() => { save('opname-racks', racks); }, [racks]);
  useEffect(() => { save('opname-stock', stock); }, [stock]);
  useEffect(() => { save('opname-sessions', sessions); }, [sessions]);
  useEffect(() => { save('opname-moves', moves); }, [moves]);
  useEffect(() => { save('opname-lastSync', lastSync); }, [lastSync]);
  useEffect(() => { save('opname-sidebar-collapsed', sidebarCollapsed); }, [sidebarCollapsed]);
  useEffect(() => { save('opname-inox-user', inoxUser); save('opname-inox-connected', inoxConnected); }, [inoxUser, inoxConnected]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { // Supabase data layer: load racks when configured; otherwise demo fallback stays.
    if (!isSupabaseConfigured) return;
    loadRacksFromSupabase().then(rows => { if (rows && rows.length > 0) setRacks(rows); }).catch(() => {});
  }, []);
  const visibleBranches = useMemo(() => user?.role === 'super' ? BRANCHES : BRANCHES.filter(b => b.id === user?.branchId), [user]);
  const branchIds = branchFilter === 'Semua' ? visibleBranches.map(b => b.id) : [branchFilter];
  const visibleRacks = racks.filter(r => branchIds.includes(r.branchId));
  const visibleProducts = products.filter(p => branchFilter === 'Semua' || BRANCHES.find(b => b.location_id === p.location_id)?.id === branchFilter);
  const filteredProducts = visibleProducts.filter(p => (p.name + p.sku + p.variant).toLowerCase().includes(search.toLowerCase()));
  const activeSession = sessions.find(s => s.id === activeSessionId) || null;
  const stockAt = (pid: string, rid: string, lv: string) => stock[`${pid}|${rid}|${lv}`] || 0;
  const rackStockTotal = (rid: string) => products.reduce((a, p) => a + (racks.find(r => r.id === rid)?.levels || []).reduce((b, lv) => b + stockAt(p.id, rid, lv), 0), 0);
  function goView(v: View) { setView(v); setMobileSidebarOpen(false); }
  function doLogin() { const u = DEMO[loginEmail.trim().toLowerCase()]; if (u) { setUser(u); setBranchFilter(u.branchId || 'Semua'); } else alert('Akun demo tidak ditemukan. Pakai super@opname, admin@kwsn, atau karyawan@kwsn (password bebas, demo).'); }
  function doSync() { if (!inoxConnected) { alert('Hubungkan dulu akun iNOX di Settings → Integrasi iNOX.'); setView('settings'); return; } setTimeout(() => { const t = Date.now(); setLastSync(t); alert(`Sync selesai ${fmtShort(t)}. Produk baru ditambahkan, produk lama tidak ditimpa per rak.`); }, 900); }
  function toggleSessLevel(rid: string, lv: string) { setSessLevelScope(prev => { if (!prev) return { [rid]: [lv] }; const cur = prev[rid] || []; const next = cur.includes(lv) ? cur.filter(x => x !== lv) : [...cur, lv]; const nextScope = { ...prev }; if (next.length === 0) delete nextScope[rid]; else nextScope[rid] = next; return Object.keys(nextScope).length === 0 ? null : nextScope; }); }
  function createSession() {
    if (!lastSync && !confirm('Belum ada sync terbaru. Lanjutkan dengan data terakhir? Sebaiknya Sync Sekarang dulu.')) return;
    const snap: Record<string, number> = {};
    for (const pid of products.map(p => p.id)) for (const rid of sessRacks) {
      const rk = racks.find(r => r.id === rid); if (!rk) continue;
      const lvs = sessLevelScope?.[rid] || rk.levels;
      for (const lv of lvs) snap[`${pid}|${rid}|${lv}`] = stockAt(pid, rid, lv);
    }
    const s: Session = { id: 'OP-' + String(sessions.length + 101), title: sessTitle, branchId: sessBranch, racks: sessRacks, scopeLevels: sessLevelScope || undefined, status: 'Berjalan', createdAt: Date.now(), createdBy: user?.name || '-', lockedAt: null, snapshot: snap, scans: [], mutations: [], adjustmentStatus: 'Menunggu', externalAt: lastSync };
    setSessions(prev => [s, ...prev]); setActiveSessionId(s.id); setView('opname'); setSessLevelScope(null);
    alert(`Sesi ${s.id} dibuat. Snapshot dibekukan${s.scopeLevels ? ' hanya untuk level dalam scope.' : '.'}`);
  }
  function addScan(sess: Session, barcode: string, qty: number, mode: string, rackId: string, level: string) { const prod = products.find(p => p.barcode === barcode || p.sku === barcode); if (!prod) { alert('Barcode/SKU tidak ditemukan di master.'); return; } const row: ScanRow = { id: String(Date.now()) + Math.random().toString(36).slice(2), time: Date.now(), user: user?.name || '-', productId: prod.id, rackId, level, qty, mode, barcode }; setSessions(prev => prev.map(s => s.id === sess.id ? { ...s, scans: [row, ...s.scans] } : s)); }
  function addMutation(sess: Session, m: Omit<SessionMutation, 'id' | 'time' | 'user'>) { const row: SessionMutation = { ...m, id: String(Date.now()) + Math.random().toString(36).slice(2), time: Date.now(), user: user?.name || '-' }; setSessions(prev => prev.map(s => s.id === sess.id ? { ...s, mutations: [row, ...s.mutations] } : s)); }
  function lockSession(sess: Session) { const next = { ...stock }; const grouped: Record<string, number> = {}; for (const sc of sess.scans) grouped[`${sc.productId}|${sc.rackId}|${sc.level}`] = (grouped[`${sc.productId}|${sc.rackId}|${sc.level}`] || 0) + sc.qty; for (const [k, v] of Object.entries(grouped)) next[k] = v; setStock(next); setSessions(prev => prev.map(s => s.id === sess.id ? { ...s, status: 'Selesai', lockedAt: Date.now() } : s)); setShowPreview(false); alert(`Sesi ${sess.id} dikunci. Stok per rak/level diperbarui. Adjustment untuk iNOX bisa diunduh dari Laporan setelah disetujui.`); }
  function approveAdjustment(sess: Session) { setSessions(prev => prev.map(s => s.id === sess.id ? { ...s, adjustmentStatus: 'Disetujui' } : s)); }
  function doMove() {
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
    return Object.entries(sess.snapshot).map(([k, sys]) => {
      const [pid, rid, lv] = k.split('|');
      const fis = sess.scans.filter(s => s.productId === pid && s.rackId === rid && s.level === lv).reduce((a, s) => a + s.qty, 0);
      const mutIn = (sess.mutations || []).filter(m => m.productId === pid && m.direction === 'Masuk').reduce((a, m) => a + m.qty, 0);
      const mutOut = (sess.mutations || []).filter(m => m.productId === pid && m.direction === 'Keluar').reduce((a, m) => a + m.qty, 0);
      const adjusted = sys + mutIn - mutOut;
      const scanned = sess.scans.some(s => s.productId === pid && s.rackId === rid && s.level === lv);
      const last = sess.scans.filter(s => s.productId === pid && s.rackId === rid && s.level === lv).sort((a, b) => b.time - a.time)[0];
      const p = products.find(x => x.id === pid);
      return { pid, rid, lv, sys, mutIn, mutOut, adjusted, fis, diff: fis - adjusted, scanned, last, p };
    });
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
    sum.addRow(['Total baris', rows.length]); sum.addRow(['Cocok', rows.filter(r => r.scanned && r.diff === 0).length]); sum.addRow(['Lebih', rows.filter(r => r.diff > 0).length]); sum.addRow(['Kurang', rows.filter(r => r.diff < 0).length]); sum.addRow(['Belum dihitung', rows.filter(r => !r.scanned).length]);
    const det = wb.addWorksheet('Detail Opname');
    det.addRow(['Produk', 'Varian', 'SKU', 'Rak', 'Level', 'Stok Snapshot', 'Mutasi Masuk', 'Mutasi Keluar', 'Stok Sistem Disesuaikan', 'Fisik', 'Selisih Akhir', 'Waktu Scan Pertama', 'Waktu Scan Terakhir', 'Waktu Verifikasi']);
    rows.forEach(r => {
      const scans = sess.scans.filter(s => s.productId === r.pid && s.rackId === r.rid && s.level === r.lv).sort((a, b) => a.time - b.time);
      const row = det.addRow([r.p?.name || '', r.p?.variant || '', r.p?.sku || '', r.rid, r.lv, r.sys, r.mutIn, r.mutOut, r.adjusted, r.fis, r.diff, scans[0] ? new Date(scans[0].time) : '', scans[scans.length - 1] ? new Date(scans[scans.length - 1].time) : '', '']);
      [12, 13].forEach(c => { row.getCell(c).numFmt = 'dd mmm yyyy hh:mm:ss'; });
    });
    const sel = wb.addWorksheet('Selisih Saja');
    sel.addRow(['Produk', 'Varian', 'SKU', 'Rak', 'Level', 'Stok Sistem Disesuaikan', 'Fisik', 'Selisih Akhir', 'Waktu Scan Terakhir']);
    rows.filter(r => r.diff !== 0).forEach(r => {
      const last = r.last ? new Date(r.last.time) : '';
      const row = sel.addRow([r.p?.name || '', r.p?.variant || '', r.p?.sku || '', r.rid, r.lv, r.adjusted, r.fis, r.diff, last]);
      row.getCell(9).numFmt = 'dd mmm yyyy hh:mm:ss';
    });
    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `Opname-${sess.id}.xlsx`);
  }
  function exportAdjustment(sess: Session) {
    if (sess.adjustmentStatus !== 'Disetujui') { alert('Adjustment belum disetujui. Tekan "Setujui Adjustment" dulu sebelum export.'); return; }
    const head = 'SKU,Varian,Selisih Qty,Alasan,Nomor Sesi,Tanggal\n';
    const body = previewRows(sess).map(r => `${r.p?.sku || ''},${r.p?.variant || ''},${r.diff},Opname,${sess.id},${fmtShort(sess.lockedAt || Date.now())}`).join('\n');
    downloadBlob(new Blob([head + body], { type: 'text/csv' }), `Adjustment-iNOX-${sess.id}.csv`);
  }
  if (!user) return (<div data-theme={theme} className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground"><Card className="w-full max-w-md"><CardHeader><CardTitle className="text-2xl">Opname Per Rak</CardTitle><CardDescription>Login demo — pilih akun, password bebas (demo lokal).</CardDescription></CardHeader><CardContent className="space-y-4"><div><label className="text-sm font-medium">Email demo</label><Input className="mt-1" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} /></div><div className="flex flex-wrap gap-2">{Object.keys(DEMO).map(k => <Button key={k} variant="outline" size="sm" onClick={() => setLoginEmail(k)}>{k}</Button>)}</div><Button className="w-full" onClick={doLogin}>Masuk</Button></CardContent></Card></div>);
  const syncAgeMin = lastSync ? (now - lastSync) / 60000 : 9999;
  const syncVariant = !lastSync ? 'destructive' : syncAgeMin < 15 ? 'default' : syncAgeMin < 60 ? 'secondary' : 'destructive';
  return (<div data-theme={theme} className="min-h-screen bg-background text-foreground">
    <div className="flex">
      {/* Desktop sidebar: shadcn-admin pattern (header / content / footer) */}
      <div className="sticky top-0 hidden h-screen shrink-0 md:block" style={{ width: sidebarCollapsed ? 64 : 240 }}>
        <AppSidebar items={NAV_ITEMS} view={view} onSelect={(id) => goView(id as View)} collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed(v => !v)} userName={user.name} userRole={user.role} className="w-full" />
      </div>
      {/* Mobile drawer */}
      {mobileSidebarOpen && (<div className="fixed inset-0 z-50 md:hidden"><button aria-label="Tutup menu" className="absolute inset-0 bg-black/50" onClick={() => setMobileSidebarOpen(false)} /><div className="absolute inset-y-0 left-0 w-72"><AppSidebar items={NAV_ITEMS} view={view} onSelect={(id) => goView(id as View)} collapsed={false} onToggleCollapse={() => setSidebarCollapsed(v => !v)} onCloseMobile={() => setMobileSidebarOpen(false)} userName={user.name} userRole={user.role} className="w-full" /></div></div>)}
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
          <Card className="mb-4"><CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6"><div><Badge variant={syncVariant}>● Status Sync iNOX</Badge> <span className="text-sm">{lastSync ? <>Terakhir sync: {fmtWita(lastSync)} — sudah {elapsedSince(lastSync, now)}</> : 'Belum pernah sync'} {inoxConnected ? <Badge className="ml-1">Terhubung: {inoxUser}</Badge> : <Badge variant="outline" className="ml-1">Belum terhubung</Badge>}</span></div><Button variant="default" onClick={doSync}><RefreshCw className="size-4" /> Sync Sekarang</Button></CardContent></Card>
          {view === 'dashboard' && (<><div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card><CardContent className="pt-6"><p className="text-sm text-muted-foreground">Produk (variasi-lokasi)</p><b className="text-2xl">{filteredProducts.length}</b></CardContent></Card>
            <Card><CardContent className="pt-6"><p className="text-sm text-muted-foreground">Total Rak</p><b className="text-2xl">{visibleRacks.length}</b></CardContent></Card>
            <Card><CardContent className="pt-6"><p className="text-sm text-muted-foreground">Sesi Berjalan</p><b className="text-2xl">{sessions.filter(s => s.status === 'Berjalan').length}</b></CardContent></Card>
            <Card><CardContent className="pt-6"><p className="text-sm text-muted-foreground">Sesi Selesai</p><b className="text-2xl">{sessions.filter(s => s.status === 'Selesai').length}</b></CardContent></Card>
          </div><Card className="mt-4"><CardHeader><CardTitle>Cara pakai cepat</CardTitle></CardHeader><CardContent><p className="text-sm">1) Settings → isi akun iNOX sekali → Sync Sekarang. 2) Sesi Opname → pilih cabang, rak (atau 1 level) → Buat Sesi. 3) Di sesi, scan barcode (+1 atau isi jumlah) atau pakai Scan Kamera per rak/level. 4) Catat mutasi selama opname bila ada transaksi. 5) Pratinjau Mini Laporan → periksa → Kunci Sesi. 6) Laporan → export Excel (.xlsx) / CSV / Cetak PDF / Adjustment iNOX (setelah disetujui).</p><p className="mt-2 text-xs text-muted-foreground">Batasan demo: data masih localStorage bila Supabase belum dikonfigurasi, dan antrean scan offline belum ada — PWA di sini hanya cache shell aplikasi.</p></CardContent></Card></>)}
          {view === 'stok' && (<><div className="mb-3 flex gap-2"><Input style={{ maxWidth: 320 }} placeholder="Cari nama / SKU / varian…" value={search} onChange={e => setSearch(e.target.value)} /></div><Card><CardContent className="pt-6"><Table><TableHeader><TableRow><TableHead>SKU</TableHead><TableHead>Produk</TableHead><TableHead>Varian</TableHead><TableHead>Kategori</TableHead><TableHead>Cabang (location_id)</TableHead><TableHead>Harga Jual</TableHead><TableHead>Stok di Rak</TableHead><TableHead>Belum Ditempatkan</TableHead></TableRow></TableHeader><TableBody>{filteredProducts.map(p => { const bid = BRANCHES.find(b => b.location_id === p.location_id)?.id || ''; const inRacks = racks.filter(r => r.branchId === bid).reduce((a, r) => a + r.levels.reduce((b, lv) => b + stockAt(p.id, r.id, lv), 0), 0); return (<TableRow key={p.id}><TableCell>{p.sku}</TableCell><TableCell>{p.name}</TableCell><TableCell>{p.variant}</TableCell><TableCell>{p.category}</TableCell><TableCell>{bid} ({p.location_id})</TableCell><TableCell>{rupiah(p.price)}</TableCell><TableCell>{inRacks}</TableCell><TableCell>{stock[`${p.id}|${bid}|BELUM`] || 0}</TableCell></TableRow>); })}</TableBody></Table></CardContent></Card><p className="mt-2 text-xs text-muted-foreground">Bidang dari iNOX (SKU, nama, varian, kategori, harga) adalah acuan keras — edit di iNOX lalu sync. Bidang lokal (rak/level) diatur lewat Visual Gudang dan Pindah Produk.</p></>)}
          {view === 'master' && <MasterRacks allRacks={racks} branches={visibleBranches} stock={stock} products={products} canEdit={user.role !== 'karyawan'} onAddRack={addRack} onUpdateRack={updateRack} onRenameLevel={renameLevel} onDeleteLevel={deleteLevel} onDeleteRack={deleteRack} onGoVisual={(bid) => { setRequestedVisualBranch(bid); setView('visual'); }} onOpenRack={(rid) => { setSessRacks([rid]); setSessLevelScope(null); setSessBranch(rid.split('-')[0]); setView('opname'); }} onOpenLevel={(rid, lv) => { setSessBranch(rid.split('-')[0]); setSessRacks([rid]); setSessLevelScope({ [rid]: [lv] }); setSessTitle(`Opname ${rid} — ${lv}`); setView('opname'); }} />}
          {view === 'visual' && <VisualMap initialBranch={requestedVisualBranch} allRacks={racks} branches={visibleBranches} stock={stock} products={products} canEdit={user.role !== 'karyawan'} onUpdateRack={updateRack} onAddRack={addRack} onRenameLevel={renameLevel} onDeleteLevel={deleteLevel} onDeleteRack={deleteRack} onOpenRack={(rid) => { setSessRacks([rid]); setSessLevelScope(null); setSessBranch(rid.split('-')[0]); setView('opname'); }} onOpenLevel={(rid, lv) => { setSessBranch(rid.split('-')[0]); setSessRacks([rid]); setSessLevelScope({ [rid]: [lv] }); setSessTitle(`Opname ${rid} — ${lv}`); setView('opname'); }} />}
          {view === 'opname' && (<><Card className="mb-4"><CardHeader><CardTitle>Buat Sesi Opname — Fleksibel</CardTitle><CardDescription>1 sesi = 1 cabang. Scope bisa seluruh cabang, 1 rak saja, 1 level saja, atau kombinasi rak.</CardDescription></CardHeader><CardContent className="space-y-4"><div className="grid gap-3 md:grid-cols-3"><div><label className="text-sm font-medium">Judul</label><Input className="mt-1" value={sessTitle} onChange={e => setSessTitle(e.target.value)} /></div><FieldSelect label="Cabang (1 sesi = 1 cabang)" value={sessBranch} onChange={(v) => { setSessBranch(v); setSessRacks([]); setSessLevelScope(null); }} options={visibleBranches.map(b => ({ value: b.id, label: b.name }))} /><div><label className="text-sm font-medium">Rak dalam scope</label><div className="mt-1 flex flex-wrap gap-2">{racks.filter(r => r.branchId === sessBranch).map(r => <Button key={r.id} variant={sessRacks.includes(r.id) ? 'default' : 'outline'} size="sm" onClick={() => setSessRacks(prev => prev.includes(r.id) ? prev.filter(x => x !== r.id) : [...prev, r.id])}>{r.name}{r.type === 'retur' ? ' (RETUR)' : ''}</Button>)}</div></div></div><div><label className="text-sm font-medium">Level saja dalam rak (opsional — langsung di menu ini)</label><p className="text-xs text-muted-foreground">Kosong = semua level di rak yang dipilih. Klik satu level untuk mulai memilih hanya level itu, klik lagi untuk membatalkan pilihan level itu.</p><div className="mt-1 flex flex-wrap gap-2">{sessRacks.map(rid => { const rk = racks.find(r => r.id === rid); if (!rk) return null; return rk.levels.map(lv => { const selected = sessLevelScope ? (sessLevelScope[rid] || []).includes(lv) : false; return <Button key={rid + lv} variant={sessLevelScope && selected ? 'default' : 'outline'} size="sm" onClick={() => toggleSessLevel(rid, lv)}>{rid} — {lv}</Button>; }); })}</div>{sessLevelScope && <Button variant="link" size="sm" onClick={() => setSessLevelScope(null)}>Kembali ke semua level</Button>}</div>{sessLevelScope && <p className="text-sm">Scope level dari Visual Gudang: <b>{Object.entries(sessLevelScope).map(([rid, lvs]) => `${rid}: ${lvs.join(', ')}`).join(' • ')}</b> — tekan Buat Sesi untuk mengunci scope ini, atau pilih rak lain untuk membatalkan scope level. <Button variant="link" size="sm" onClick={() => setSessLevelScope(null)}>Batalkan scope level</Button></p>}<Button onClick={createSession} disabled={sessRacks.length === 0}>Buat Sesi &amp; Bekukan Snapshot</Button></CardContent></Card>
            {sessions.map(s => <SessionCard key={s.id} sess={s} products={products} racks={racks} active={activeSessionId === s.id} onSelect={() => setActiveSessionId(s.id)} onScan={(barcode, qty, mode, rackId, level) => addScan(s, barcode, qty, mode, rackId, level)} onMutation={(m) => addMutation(s, m)} onPreview={() => { setActiveSessionId(s.id); setShowPreview(true); }} />)}
            {activeSession && (<Dialog open={showPreview} onOpenChange={(o) => setShowPreview(o)}><DialogContent><DialogHeader><DialogTitle>Pratinjau Mini Laporan — {activeSession.id} {activeSession.status !== 'Selesai' && <Badge variant="secondary">DRAFT — BELUM DIKUNCI</Badge>}</DialogTitle><DialogDescription>{activeSession.title} • {activeSession.branchId} • Scope: {scopeLabel(activeSession)} • Dibuat {fmtShort(activeSession.createdAt)} • Scan terakhir {activeSession.scans[0] ? fmtShort(activeSession.scans[0].time) : '—'}</DialogDescription></DialogHeader><PreviewBody previewRows={previewRows(activeSession)} filter={previewFilter} setFilter={setPreviewFilter} /><DialogFooter><Button variant="outline" onClick={() => setShowPreview(false)}>Kembali ke Hitung</Button><Button variant="outline" onClick={() => setShowPreview(false)}>Tutup</Button>{activeSession.status === 'Berjalan' && <Button onClick={() => { if (confirm(`Kunci sesi ${activeSession.id}?`)) lockSession(activeSession); }}>Kunci Sesi</Button>}</DialogFooter></DialogContent></Dialog>)}</>)}
          {view === 'laporan' && (<><Card className="mb-3"><CardHeader><CardTitle>Menu Laporan — Daftar Semua Sesi</CardTitle><CardDescription>Tiap baris bisa diekspor lagi kapan saja. Export ulang memakai snapshot sesi yang dikunci, bukan stok live saat ini.</CardDescription></CardHeader></Card><Card><CardContent className="pt-6"><Table><TableHeader><TableRow><TableHead>Nomor</TableHead><TableHead>Judul</TableHead><TableHead>Cabang</TableHead><TableHead>Scope</TableHead><TableHead>Dibuat</TableHead><TableHead>Status</TableHead><TableHead>Scan</TableHead><TableHead>Adjustment</TableHead><TableHead>Aksi</TableHead></TableRow></TableHeader><TableBody>{sessions.map(s => <TableRow key={s.id}><TableCell>{s.id}</TableCell><TableCell>{s.title}</TableCell><TableCell>{s.branchId}</TableCell><TableCell>{scopeLabel(s)}</TableCell><TableCell>{fmtShort(s.createdAt)}</TableCell><TableCell>{s.status}</TableCell><TableCell>{s.scans.length}</TableCell><TableCell><Badge variant={s.adjustmentStatus === 'Disetujui' ? 'default' : 'secondary'}>{s.adjustmentStatus || 'Menunggu'}</Badge></TableCell><TableCell><div className="flex flex-wrap gap-1"><Button size="sm" variant="outline" onClick={() => { setActiveSessionId(s.id); setView('opname'); }}>Lihat</Button><Button size="sm" variant="outline" onClick={() => exportExcel(s)}>Excel (.xlsx)</Button><Button size="sm" variant="outline" onClick={() => exportCSV(s)}>CSV</Button><Button size="sm" variant="outline" onClick={() => window.print()}>PDF (Cetak)</Button><Button size="sm" variant="outline" onClick={() => approveAdjustment(s)} disabled={s.adjustmentStatus === 'Disetujui'}>Setujui Adjustment</Button><Button size="sm" onClick={() => exportAdjustment(s)} disabled={s.adjustmentStatus !== 'Disetujui'}>Adjustment iNOX</Button></div></TableCell></TableRow>)}</TableBody></Table></CardContent></Card>{sessions.length === 0 && <p className="mt-2 text-sm">Belum ada laporan. Buat dan kunci satu sesi dulu.</p>}</>)}
          {view === 'pindah' && (<Card className="max-w-2xl"><CardHeader><CardTitle>Pindah Produk Antar Level / Antar Rak</CardTitle></CardHeader><CardContent className="space-y-4"><div className="grid gap-3 md:grid-cols-2"><FieldSelect label="Produk" value={mvProd} onChange={setMvProd} options={products.map(p => ({ value: p.id, label: `${p.name} — ${p.variant} (${p.sku})` }))} /><div><label className="text-sm font-medium">Jumlah</label><Input className="mt-1" type="number" min={1} value={mvQty} onChange={e => setMvQty(Number(e.target.value))} /></div><FieldSelect label="Rak Asal" value={mvFromRack} onChange={setMvFromRack} options={racks.map(r => ({ value: r.id, label: `${r.branchId} — ${r.name}${r.type === 'retur' ? ' (RETUR)' : ''}` }))} /><FieldSelect label="Level Asal" value={mvFromLevel} onChange={setMvFromLevel} options={(racks.find(r => r.id === mvFromRack)?.levels || []).map(l => ({ value: l, label: l }))} /><FieldSelect label="Rak Tujuan" value={mvToRack} onChange={setMvToRack} options={racks.map(r => ({ value: r.id, label: `${r.branchId} — ${r.name}${r.type === 'retur' ? ' (RETUR)' : ''}` }))} /><FieldSelect label="Level Tujuan (spesifik)" value={mvToLevel} onChange={setMvToLevel} options={(racks.find(r => r.id === mvToRack)?.levels || []).map(l => ({ value: l, label: l }))} /><FieldSelect label="Alasan" value={mvReason} onChange={setMvReason} options={['Penataan Ulang', 'Retur Customer', 'Rusak', 'Kembali ke Rak Jual', 'Dikirim Balik ke Supplier', 'Dimusnahkan', 'Lainnya'].map(x => ({ value: x, label: x }))} /><div><label className="text-sm font-medium">Foto bukti (opsional)</label><Input className="mt-1" type="file" accept="image/*" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setMvPhoto(await compressImage(f)); }} />{mvPhoto && <img src={mvPhoto} alt="Foto bukti pindah" className="mt-2 max-h-32 rounded-md border" />}</div></div><p className="text-sm">Stok di level asal: <b>{stock[`${mvProd}|${mvFromRack}|${mvFromLevel}`] || 0}</b> • Stok di level tujuan: <b>{stock[`${mvProd}|${mvToRack}|${mvToLevel}`] || 0}</b> • Total cabang tidak berubah.</p><Button onClick={doMove}>Simpan Pindah</Button>{moves.length > 0 && <div className="pt-2"><Separator className="my-3" /><h3 className="font-semibold">Riwayat Pindah</h3><Table><TableHeader><TableRow><TableHead>Waktu</TableHead><TableHead>Produk</TableHead><TableHead>Asal → Tujuan</TableHead><TableHead>Qty</TableHead><TableHead>Alasan</TableHead><TableHead>Foto</TableHead></TableRow></TableHeader><TableBody>{moves.slice(0, 20).map(m => { const p = products.find(x => x.id === m.productId); return (<TableRow key={m.id}><TableCell>{fmtShort(m.time)}</TableCell><TableCell>{p?.name} — {p?.variant}</TableCell><TableCell>{m.fromRack} / {m.fromLevel} → {m.toRack} / {m.toLevel}</TableCell><TableCell>{m.qty}</TableCell><TableCell>{m.reason}</TableCell><TableCell>{m.photo ? <img src={m.photo} alt="Bukti" className="max-h-12 rounded border" /> : '—'}</TableCell></TableRow>); })}</TableBody></Table></div>}</CardContent></Card>)}
          {view === 'settings' && (<Card className="max-w-2xl"><CardHeader><CardTitle>Settings → Integrasi iNOX</CardTitle><CardDescription>Hanya Super Admin yang boleh mengubah ini di produksi. Kredensial disimpan terenkripsi di server (di demo ini hanya disimpan lokal dan tidak pernah ditampilkan lagi setelah disimpan, kecuali username).</CardDescription></CardHeader><CardContent className="space-y-4"><div><label className="text-sm font-medium">Username iNOX</label><Input className="mt-1" value={inoxUser} onChange={e => setInoxUser(e.target.value)} placeholder="mis. ariansya" /></div><div><label className="text-sm font-medium">Password iNOX</label><Input className="mt-1" type="password" placeholder="••••••••" /></div><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => { if (!inoxUser) { alert('Isi username dulu.'); return; } alert(`Uji Koneksi berhasil (demo): login ke https://inox.my.id/login sebagai ${inoxUser}, feed 1 halaman terbaca.`); }}>Uji Koneksi</Button><Button onClick={() => { if (!inoxUser) { alert('Isi username dulu.'); return; } setInoxConnected(true); alert('Integrasi disimpan. Sekarang tekan Sync Sekarang di atas.'); }}>Simpan &amp; Hubungkan</Button>{inoxConnected && <Button variant="destructive" onClick={() => { setInoxConnected(false); alert('Integrasi diputuskan. Data hasil sync lama tetap tampil.'); }}>Putuskan Integrasi / Logout iNOX</Button>}</div><div><h3 className="font-semibold">Pemetaan Lokasi iNOX → Cabang Opname</h3><ul className="mt-2 list-disc pl-5 text-sm">{BRANCHES.map(b => <li key={b.id}>{b.location_id} = {b.location_name} → {b.name}</li>)}</ul></div><div><h3 className="font-semibold">Deployment</h3><p className="text-sm">Frontend ini (Vite) siap di-deploy ke Netlify (statis). Data demo ini memakai localStorage agar langsung jalan tanpa Supabase. Untuk produksi, terapkan supabase/schema.sql dan isi .env (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY) — struktur data dan logikanya sama, hanya sumber datanya berpindah dari localStorage ke Supabase.</p></div></CardContent></Card>)}
        </main>
        <footer className="p-4 text-center text-xs text-muted-foreground">Apname — Opname Per Rak • Tema: {theme} • {fmtWita(now)}</footer>
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
  const svgRef = useRef<SVGSVGElement | null>(null);
  const suppressClick = useRef(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('Rak C'); const [newType, setNewType] = useState<'normal' | 'retur'>('normal');
  const [newLevels, setNewLevels] = useState('Level 1, Level 2, Level 3'); const [newW, setNewW] = useState(160); const [newH, setNewH] = useState(90);
  const [editName, setEditName] = useState(''); const [editW, setEditW] = useState(160); const [editH, setEditH] = useState(90); const [editRot, setEditRot] = useState(0);
  const [editLevels, setEditLevels] = useState<string[]>([]);
  const shown = allRacks.filter(r => r.branchId === visualBranch);
  const sel = allRacks.find(r => r.id === selId) || null;
  useEffect(() => { if (sel) { setEditName(sel.name); setEditW(sel.w); setEditH(sel.h); setEditRot(sel.rot); setEditLevels([...sel.levels]); } }, [sel?.id]);
  useEffect(() => { if (!branches.some(b => b.id === visualBranch)) setVisualBranch(branches[0]?.id || 'KWSN'); }, [branches]);
  useEffect(() => { if (initialBranch && branches.some(b => b.id === initialBranch)) setVisualBranch(initialBranch); }, [initialBranch, branches]);
  const toSvg = (e: React.PointerEvent) => { const rect = svgRef.current?.getBoundingClientRect(); if (!rect) return { x: 0, y: 0 }; return { x: (e.clientX - rect.left) * (700 / rect.width), y: (e.clientY - rect.top) * (300 / rect.height) }; };
  const onDown = (e: React.PointerEvent, r: Rack) => {
    if (!canEdit) return;
    const p = toSvg(e);
    dragRef.current = { id: r.id, offX: p.x - r.x, offY: p.y - r.y, startX: p.x, startY: p.y };
    setDragId(r.id); setMoved(false);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d) return;
    const p = toSvg(e);
    if (Math.abs(p.x - d.startX) + Math.abs(p.y - d.startY) > 5) setMoved(true);
    const nx = Math.round((p.x - d.offX) / 10) * 10; const ny = Math.round((p.y - d.offY) / 10) * 10;
    onUpdateRack(d.id, { x: Math.max(0, nx), y: Math.max(0, ny) });
  };
  const onUp = () => { if (moved) { suppressClick.current = true; setTimeout(() => { suppressClick.current = false; }, 50); } dragRef.current = null; setDragId(null); };
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
    <div className="overflow-x-auto"><svg ref={svgRef} width="700" height="300" viewBox="0 0 700 300" style={{ background: 'var(--muted)', borderRadius: 12, touchAction: 'none', width: '100%', maxWidth: 700 }} onPointerMove={onMove} onPointerUp={onUp}>{shown.map(r => { const total = products.reduce((a, p) => a + r.levels.reduce((b, lv) => b + (stock[`${p.id}|${r.id}|${lv}`] || 0), 0), 0); return (<g key={r.id} transform={`translate(${r.x} ${r.y}) rotate(${r.rot} ${r.w / 2} ${r.h / 2})`} onPointerDown={e => onDown(e, r)} onClick={() => { if (suppressClick.current) return; setSelId(r.id); }} style={{ cursor: canEdit ? 'grab' : 'pointer' }}><rect width={r.w} height={r.h} rx="10" fill={r.type === 'retur' ? '#f97316' : 'var(--card)'} stroke={dragId === r.id ? 'var(--accent)' : 'var(--border)'} strokeWidth="2" /><text x={r.w / 2} y="28" textAnchor="middle" fontSize="14" fontWeight="700" fill={r.type === 'retur' ? '#fff' : 'var(--foreground)'}>{r.name}{r.type === 'retur' ? ' — RETUR' : ''}</text><text x={r.w / 2} y="50" textAnchor="middle" fontSize="12" fill={r.type === 'retur' ? '#fff' : 'var(--muted-foreground)'}>{r.levels.length} level • {total} unit</text><text x={r.w / 2} y="70" textAnchor="middle" fontSize="11" fill={r.type === 'retur' ? '#fff' : 'var(--muted-foreground)'}>rot {r.rot}° • {r.branchId}</text></g>); })}</svg></div>
    {sel && (<div className="space-y-3"><div className="flex flex-wrap items-center gap-2"><b>{sel.branchId} — {sel.name}{sel.type === 'retur' ? ' (RETUR)' : ''}</b>{canEdit && <Button variant="outline" size="sm" onClick={() => onUpdateRack(sel.id, { rot: (sel.rot + 90) % 360 })}><RotateCw className="size-4" /> Rotate 90°</Button>}<Button onClick={() => onOpenRack(sel.id)}>Opname Rak Ini</Button>{canEdit && <Button variant="destructive" size="sm" onClick={() => { if (!confirm(`Hapus rak ${sel.name}? Rak dengan stok > 0 ditolak.`)) return; const msg = onDeleteRack(sel.id); if (msg !== 'OK') alert(msg); else setSelId(null); }}><Trash2 className="size-4" /> Hapus Rak</Button>}</div>
      {canEdit && (<Card><CardContent className="grid gap-3 pt-6 md:grid-cols-4"><div><label className="text-sm font-medium">Nama rak</label><Input className="mt-1" value={editName} onChange={e => setEditName(e.target.value)} /></div><div><label className="text-sm font-medium">Lebar (w)</label><Input className="mt-1" type="number" value={editW} onChange={e => setEditW(Number(e.target.value))} /></div><div><label className="text-sm font-medium">Tinggi (h)</label><Input className="mt-1" type="number" value={editH} onChange={e => setEditH(Number(e.target.value))} /></div><FieldSelect label="Rotate" value={String(editRot)} onChange={(v) => setEditRot(Number(v))} options={['0', '90', '180', '270'].map(x => ({ value: x, label: `${x}°` }))} /><div className="md:col-span-4"><label className="text-sm font-medium">Level (ubah nama di sini — stok ikut pindah ke nama baru; hapus level ditolak bila stok &gt; 0)</label>{editLevels.map((lv, i) => (<div key={i} className="mt-2 flex gap-2"><Input value={lv} onChange={e => setEditLevels(prev => prev.map((x, j) => j === i ? e.target.value : x))} /><Button variant="outline" size="sm" onClick={() => { const msg = onDeleteLevel(sel.id, sel.levels[i]); if (msg !== 'OK') alert(msg); else setEditLevels(prev => prev.filter((_, j) => j !== i)); }}>Hapus Level</Button></div>))}<Button variant="outline" size="sm" className="mt-2" onClick={() => setEditLevels(prev => [...prev, `Level ${prev.length + 1}`])}>+ Tambah Level</Button></div><div><Button onClick={saveEdit}>Simpan Perubahan Rak</Button></div></CardContent></Card>)}
      <div>{sel.levels.map(lv => { const tot = products.reduce((a, p) => a + (stock[`${p.id}|${sel.id}|${lv}`] || 0), 0); return (<Card key={lv} className="mt-2"><CardContent className="flex flex-wrap items-center justify-between gap-2 py-3"><span>{lv} — {tot} unit</span><Button size="sm" onClick={() => onOpenLevel(sel.id, lv)}>Opname Level Ini</Button></CardContent></Card>); })}</div></div>)}
  </CardContent></Card>);
}
function SessionCard({ sess, products, racks, active, onSelect, onScan, onMutation, onPreview }: { sess: Session; products: Product[]; racks: Rack[]; active: boolean; onSelect: () => void; onScan: (barcode: string, qty: number, mode: string, rackId: string, level: string) => void; onMutation: (m: Omit<SessionMutation, 'id' | 'time' | 'user'>) => void; onPreview: () => void }) {
  const [barcode, setBarcode] = useState(''); const [qty, setQty] = useState(1); const [mode, setMode] = useState('+1 per scan');
  const [rackId, setRackId] = useState(sess.racks[0] || '');
  const allowedLevels = levelsFor(sess, rackId, racks);
  const [level, setLevel] = useState(allowedLevels[0] || '');
  useEffect(() => { if (!allowedLevels.includes(level)) setLevel(allowedLevels[0] || ''); }, [rackId]);
  const [camOn, setCamOn] = useState(false); const videoRef = useRef<HTMLVideoElement | null>(null); const streamRef = useRef<MediaStream | null>(null);
  const [showMut, setShowMut] = useState(false);
  const [mutProd, setMutProd] = useState(products[0]?.id || ''); const [mutKind, setMutKind] = useState('Penjualan'); const [mutDir, setMutDir] = useState<'Masuk' | 'Keluar'>('Keluar'); const [mutQty, setMutQty] = useState(1); const [mutRack, setMutRack] = useState(''); const [mutRef, setMutRef] = useState(''); const [mutNote, setMutNote] = useState('');
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
          if (codes[0]?.rawValue) { onScan(codes[0].rawValue, mode === '+1 per scan' ? 1 : qty, 'Scan Kamera', rackId, level); clearInterval(timer); stopCam(); }
        } catch { /* keep scanning until stopped */ }
      }, 600);
      stream.getTracks()[0]?.addEventListener('ended', () => clearInterval(timer));
    } catch { alert('Izin kamera ditolak atau kamera tidak tersedia. Pakai input manual.'); }
  };
  return (<Card className="mb-3"><CardContent className="pt-6"><div className="flex flex-wrap items-center justify-between gap-2"><div><b>{sess.id} — {sess.title}</b> <Badge>{sess.status}</Badge> <Badge variant="secondary">{sess.branchId} • {scopeLabel(sess)}</Badge><div className="text-xs text-muted-foreground">Dibuat: {fmtShort(sess.createdAt)} • Sync saat sesi: {sess.externalAt ? fmtShort(sess.externalAt) : '—'} • Scan: {sess.scans.length} • Mutasi: {(sess.mutations || []).length}</div></div><Button variant="outline" onClick={onSelect}>{active ? 'Sesi Aktif' : 'Pilih Sesi Ini'}</Button></div>
    {sess.status === 'Berjalan' && (<><div className="mt-3 grid gap-2 md:grid-cols-4"><div><label className="text-sm font-medium">Barcode / SKU</label><Input className="mt-1" value={barcode} onChange={e => setBarcode(e.target.value)} placeholder="8990124000135" onKeyDown={e => { if (e.key === 'Enter' && barcode) { onScan(barcode, mode === '+1 per scan' ? 1 : qty, mode, rackId, level); setBarcode(''); } }} /></div><FieldSelect label="Mode" value={mode} onChange={setMode} options={['+1 per scan', 'Scan sekali, isi jumlah', 'Input manual'].map(x => ({ value: x, label: x }))} /><div><label className="text-sm font-medium">Jumlah</label><Input className="mt-1" type="number" min={1} value={qty} onChange={e => setQty(Number(e.target.value))} /></div><div className="flex gap-1"><div className="flex-1"><FieldSelect label="Rak" value={rackId} onChange={setRackId} options={sess.racks.map(r => ({ value: r, label: r }))} /></div><div className="flex-1"><FieldSelect label="Level" value={level} onChange={setLevel} options={allowedLevels.map(l => ({ value: l, label: l }))} /></div></div></div>
    <div className="mt-3 flex flex-wrap gap-2"><Button onClick={() => { if (!barcode) return; onScan(barcode, mode === '+1 per scan' ? 1 : qty, mode, rackId, level); setBarcode(''); }}><ScanLine className="size-4" /> Scan / Tambah</Button><Button variant="outline" onClick={camOn ? stopCam : startCam}><Camera className="size-4" /> {camOn ? 'Tutup Kamera' : 'Scan Kamera'}</Button><Button variant="outline" onClick={onPreview}><Eye className="size-4" /> Pratinjau Mini Laporan</Button><Button variant="outline" onClick={() => setShowMut(v => !v)}>Catat Mutasi Selama Opname</Button></div>
    {camOn && <video ref={videoRef} autoPlay playsInline muted className="mt-3 w-full max-w-md rounded-md border" />}
    {showMut && (<Card className="mt-3"><CardContent className="grid gap-3 pt-6 md:grid-cols-3"><FieldSelect label="Produk" value={mutProd} onChange={setMutProd} options={products.map(p => ({ value: p.id, label: `${p.name} — ${p.variant}` }))} /><FieldSelect label="Jenis" value={mutKind} onChange={setMutKind} options={['Penjualan', 'Pembelian/Penerimaan', 'Retur', 'Mutasi Antar Rak/Cabang', 'Rusak', 'Hilang', 'Koreksi', 'Lainnya'].map(x => ({ value: x, label: x }))} /><FieldSelect label="Arah" value={mutDir} onChange={(v) => setMutDir(v as 'Masuk' | 'Keluar')} options={[{ value: 'Masuk', label: 'Masuk (+)' }, { value: 'Keluar', label: 'Keluar (−)' }]} /><div><label className="text-sm font-medium">Qty</label><Input className="mt-1" type="number" min={1} value={mutQty} onChange={e => setMutQty(Number(e.target.value))} /></div><FieldSelect label="Rak asal (bila diketahui)" value={mutRack} onChange={setMutRack} options={[{ value: '', label: 'Rak Tidak Diketahui — Total Cabang' }, ...sess.racks.map(r => ({ value: r, label: r }))]} /><div><label className="text-sm font-medium">Referensi</label><Input className="mt-1" value={mutRef} onChange={e => setMutRef(e.target.value)} placeholder="No. nota / referensi" /></div><div className="md:col-span-3"><label className="text-sm font-medium">Keterangan</label><Input className="mt-1" value={mutNote} onChange={e => setMutNote(e.target.value)} /></div><div><Button onClick={() => { if (!mutProd || mutQty < 1) { alert('Pilih produk dan qty minimal 1.'); return; } onMutation({ productId: mutProd, kind: mutKind, direction: mutDir, qty: mutQty, rackId: mutRack, reference: mutRef, note: mutNote }); setShowMut(false); }}>Simpan Mutasi (Snapshot Tidak Diubah)</Button></div></CardContent></Card>)}
    <div className="mt-3"><Table><TableHeader><TableRow><TableHead>Waktu Scan</TableHead><TableHead>Petugas</TableHead><TableHead>Produk</TableHead><TableHead>Rak / Level</TableHead><TableHead>Jumlah</TableHead><TableHead>Mode</TableHead></TableRow></TableHeader><TableBody>{sess.scans.slice(0, 20).map(s => { const p = products.find(x => x.id === s.productId); return (<TableRow key={s.id}><TableCell>{fmtShort(s.time)}</TableCell><TableCell>{s.user}</TableCell><TableCell>{p?.name} — {p?.variant} ({p?.sku})</TableCell><TableCell>{s.rackId} / {s.level}</TableCell><TableCell>{s.qty}</TableCell><TableCell>{s.mode}</TableCell></TableRow>); })}</TableBody></Table></div></>)}
    {sess.status !== 'Berjalan' && <div className="mt-3"><Button variant="outline" onClick={onPreview}>Lihat Pratinjau / Laporan</Button> <Badge variant="secondary">Dikunci: {sess.lockedAt ? fmtShort(sess.lockedAt) : '—'}</Badge></div>}
  </CardContent></Card>);
}
type PreviewRow = { pid: string; rid: string; lv: string; sys: number; mutIn: number; mutOut: number; adjusted: number; fis: number; diff: number; scanned: boolean; last?: ScanRow; p?: Product };
function PreviewBody({ previewRows, filter, setFilter }: { previewRows: PreviewRow[]; filter: string; setFilter: (s: string) => void }) {
  const rows = previewRows;
  const shown = rows.filter(r => filter === 'semua' ? true : filter === 'selisih' ? r.diff !== 0 : filter === 'belum' ? !r.scanned : filter === 'lebih' ? r.diff > 0 : r.diff < 0).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  const cocok = rows.filter(r => r.scanned && r.diff === 0).length, lebih = rows.filter(r => r.diff > 0).length, kurang = rows.filter(r => r.diff < 0).length, belum = rows.filter(r => !r.scanned).length; const acc = rows.length ? Math.round((cocok / rows.length) * 100) : 0;
  return (<div><div className="grid grid-cols-2 gap-2 md:grid-cols-5"><Card><CardContent className="pt-4">Total baris<br /><b>{rows.length}</b></CardContent></Card><Card><CardContent className="pt-4">Cocok<br /><b>{cocok}</b></CardContent></Card><Card><CardContent className="pt-4">Lebih<br /><b>{lebih}</b></CardContent></Card><Card><CardContent className="pt-4">Kurang<br /><b>{kurang}</b></CardContent></Card><Card><CardContent className="pt-4">Belum<br /><b>{belum}</b></CardContent></Card></div><p className="mt-2 text-sm">Akurasi: <b>{acc}%</b> • Stok Sistem Disesuaikan = Snapshot + Mutasi Masuk − Mutasi Keluar • Selisih Akhir = Fisik − Disesuaikan</p><div className="mt-3 flex flex-wrap gap-2">{['semua', 'selisih', 'lebih', 'kurang', 'belum'].map(f => <Button key={f} variant={filter === f ? 'default' : 'outline'} size="sm" onClick={() => setFilter(f)}>{f}</Button>)}</div><Table><TableHeader><TableRow><TableHead>Produk</TableHead><TableHead>Rak / Level</TableHead><TableHead>Snapshot</TableHead><TableHead>Mutasi</TableHead><TableHead>Disesuaikan</TableHead><TableHead>Fisik</TableHead><TableHead>Selisih Akhir</TableHead><TableHead>Status</TableHead><TableHead>Waktu Scan Terakhir</TableHead></TableRow></TableHeader><TableBody>{shown.map(r => <TableRow key={r.pid + r.rid + r.lv}><TableCell>{r.p?.name} — {r.p?.variant} ({r.p?.sku})</TableCell><TableCell>{r.rid} / {r.lv}</TableCell><TableCell>{r.sys}</TableCell><TableCell>+{r.mutIn} / −{r.mutOut}</TableCell><TableCell>{r.adjusted}</TableCell><TableCell>{r.fis}</TableCell><TableCell>{r.diff}</TableCell><TableCell>{!r.scanned ? 'Belum dihitung' : r.diff === 0 ? 'Cocok' : r.diff > 0 ? 'Lebih' : 'Kurang'}</TableCell><TableCell>{r.last ? fmtShort(r.last.time) : '—'}</TableCell></TableRow>)}</TableBody></Table></div>);
}
