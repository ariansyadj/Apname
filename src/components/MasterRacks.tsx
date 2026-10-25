import { useEffect, useState } from 'react';
import type { Branch, Product, Rack } from '../data';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Trash2, Pencil, Map as MapIcon, ClipboardList, Printer } from 'lucide-react';
import { printLabels, type LabelItem } from '../lib/labels';

type Props = {
  allRacks: Rack[];
  branches: Branch[];
  stock: Record<string, number>;
  products: Product[];
  canEdit: boolean;
  onAddRack: (branchId: string, name: string, type: 'normal' | 'retur', levels: string[], w: number, h: number) => void;
  onUpdateRack: (id: string, patch: Partial<Rack>) => void;
  onRenameLevel: (rackId: string, oldLevel: string, newLevel: string) => string;
  onDeleteLevel: (rackId: string, level: string) => string;
  onDeleteRack: (id: string) => string;
  onGoVisual: (branchId: string) => void;
  onOpenRack: (id: string) => void;
  onOpenLevel: (rackId: string, level: string) => void;
};

export function MasterRacks({ allRacks, branches, stock, products, canEdit, onAddRack, onUpdateRack, onRenameLevel, onDeleteLevel, onDeleteRack, onGoVisual, onOpenRack, onOpenLevel }: Props) {
  const [branchId, setBranchId] = useState(branches[0]?.id || '');
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('Rak C');
  const [newType, setNewType] = useState<'normal' | 'retur'>('normal');
  const [newLevels, setNewLevels] = useState('Level 1, Level 2, Level 3');
  const [newW, setNewW] = useState(160);
  const [newH, setNewH] = useState(90);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editW, setEditW] = useState(160);
  const [editH, setEditH] = useState(90);
  const [editRot, setEditRot] = useState(0);
  const [editLevels, setEditLevels] = useState<string[]>([]);

  useEffect(() => {
    if (!branches.some((b) => b.id === branchId)) setBranchId(branches[0]?.id || '');
  }, [branches, branchId]);

  const shown = allRacks.filter((r) => r.branchId === branchId);
  const labelFor = (r: Rack, lv: string): LabelItem => ({ branchId: r.branchId, branchName: branches.find((b) => b.id === r.branchId)?.name || r.branchId, rackId: r.id, rackName: r.name, rackType: r.type, level: lv });
  const rackTotal = (rid: string, levels: string[]) =>
    products.reduce((a, p) => a + levels.reduce((b, lv) => b + (stock[`${p.id}|${rid}|${lv}`] || 0), 0), 0);
  const levelTotal = (rid: string, lv: string) =>
    products.reduce((a, p) => a + (stock[`${p.id}|${rid}|${lv}`] || 0), 0);

  const startEdit = (r: Rack) => {
    setEditId(r.id);
    setEditName(r.name);
    setEditW(r.w);
    setEditH(r.h);
    setEditRot(r.rot);
    setEditLevels([...r.levels]);
  };

  const saveEdit = (r: Rack) => {
    if (!editName.trim()) { alert('Nama rak tidak boleh kosong.'); return; }
    for (let i = 0; i < r.levels.length; i++) {
      const oldL = r.levels[i];
      const newL = editLevels[i] || oldL;
      if (newL !== oldL) {
        const msg = onRenameLevel(r.id, oldL, newL);
        if (msg !== 'OK') { alert(msg); return; }
      }
    }
    onUpdateRack(r.id, { name: editName.trim(), w: editW, h: editH, rot: editRot });
    setEditId(null);
    alert('Rak diperbarui.');
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Master Rak</CardTitle>
          <CardDescription>
            Daftar rak per cabang. Satu cabang = satu tempat, jadi rak KWSN tidak dicampur dengan rak cabang lain di denah yang sama.
            {canEdit ? ' Super Admin / Admin Cabang bisa tambah, edit nama dan level, dan hapus rak.' : ' Karyawan hanya bisa melihat — edit rak hanya untuk Super Admin / Admin Cabang.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="text-sm font-medium">Filter cabang</label>
              <Select value={branchId} onValueChange={setBranchId}>
                <SelectTrigger className="mt-1 w-[200px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                Cabang yang tampil mengikuti hak akses akun yang login. Admin/Karyawan hanya melihat cabangnya sendiri.
              </p>
            </div>
            <Button variant="outline" onClick={() => onGoVisual(branchId)}><MapIcon className="size-4" /> Lihat Denah Cabang Ini</Button>
            {canEdit && (
              <Button onClick={() => setShowCreate((v) => !v)}><Plus className="size-4" /> {showCreate ? 'Tutup Form' : 'Tambah Rak'}</Button>
            )}
          </div>

          {canEdit && showCreate && (
            <Card>
              <CardContent className="grid gap-3 pt-6 md:grid-cols-3">
                <div><label className="text-sm font-medium">Nama rak</label><Input className="mt-1" value={newName} onChange={(e) => setNewName(e.target.value)} /></div>
                <div>
                  <label className="text-sm font-medium">Tipe</label>
                  <Select value={newType} onValueChange={(v) => setNewType(v as 'normal' | 'retur')}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="normal">Normal</SelectItem><SelectItem value="retur">Retur</SelectItem></SelectContent>
                  </Select>
                </div>
                <div><label className="text-sm font-medium">Level (pisah koma)</label><Input className="mt-1" value={newLevels} onChange={(e) => setNewLevels(e.target.value)} /></div>
                <div><label className="text-sm font-medium">Lebar (w)</label><Input className="mt-1" type="number" value={newW} onChange={(e) => setNewW(Number(e.target.value))} /></div>
                <div><label className="text-sm font-medium">Tinggi (h)</label><Input className="mt-1" type="number" value={newH} onChange={(e) => setNewH(Number(e.target.value))} /></div>
                <div className="flex items-end"><Button onClick={() => { onAddRack(branchId, newName, newType, newLevels.split(','), newW, newH); setShowCreate(false); }}>Simpan Rak Baru</Button></div>
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>

      {shown.length === 0 && <p className="text-sm text-muted-foreground">Belum ada rak di cabang ini. Tambah rak lewat tombol di atas.</p>}

      {shown.map((r) => (
        <Card key={r.id}>
          <CardContent className="space-y-3 pt-6">
            <div className="flex flex-wrap items-center gap-2">
              <b>{r.name}</b>
              {r.type === 'retur' && <Badge>RETUR</Badge>}
              <Badge variant="outline">{r.branchId} • {r.levels.length} level • {rackTotal(r.id, r.levels)} unit • {r.w}×{r.h} • rot {r.rot}°</Badge>
              <div className="ml-auto flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => onGoVisual(r.branchId)}><MapIcon className="size-4" /> Denah</Button>
                <Button size="sm" onClick={() => onOpenRack(r.id)}><ClipboardList className="size-4" /> Opname Rak Ini</Button>
                <Button variant="outline" size="sm" onClick={() => printLabels(r.levels.map((lv) => labelFor(r, lv)))}><Printer className="size-4" /> Cetak Label Rak</Button>
                {canEdit && <Button variant="outline" size="sm" onClick={() => startEdit(r)}><Pencil className="size-4" /> Edit Rak</Button>}
                {canEdit && (
                  <Button variant="destructive" size="sm" onClick={() => { if (!confirm(`Hapus rak ${r.name}? Rak dengan stok > 0 ditolak.`)) return; const msg = onDeleteRack(r.id); if (msg !== 'OK') alert(msg); }}>
                    <Trash2 className="size-4" /> Hapus Rak
                  </Button>
                )}
              </div>
            </div>

            {editId === r.id && canEdit && (
              <Card>
                <CardContent className="grid gap-3 pt-6 md:grid-cols-4">
                  <div><label className="text-sm font-medium">Nama rak</label><Input className="mt-1" value={editName} onChange={(e) => setEditName(e.target.value)} /></div>
                  <div><label className="text-sm font-medium">Lebar (w)</label><Input className="mt-1" type="number" value={editW} onChange={(e) => setEditW(Number(e.target.value))} /></div>
                  <div><label className="text-sm font-medium">Tinggi (h)</label><Input className="mt-1" type="number" value={editH} onChange={(e) => setEditH(Number(e.target.value))} /></div>
                  <div>
                    <label className="text-sm font-medium">Rotate</label>
                    <Select value={String(editRot)} onValueChange={(v) => setEditRot(Number(v))}>
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>{['0', '90', '180', '270'].map((x) => <SelectItem key={x} value={x}>{x}°</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="md:col-span-4">
                    <label className="text-sm font-medium">Level — ubah nama di sini, stok ikut pindah ke nama baru. Hapus level ditolak bila stok &gt; 0.</label>
                    {editLevels.map((lv, i) => (
                      <div key={i} className="mt-2 flex gap-2">
                        <Input value={lv} onChange={(e) => setEditLevels((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))} />
                        <Button variant="outline" size="sm" onClick={() => { const msg = onDeleteLevel(r.id, r.levels[i]); if (msg !== 'OK') alert(msg); else setEditLevels((prev) => prev.filter((_, j) => j !== i)); }}>Hapus Level</Button>
                      </div>
                    ))}
                    <Button variant="outline" size="sm" className="mt-2" onClick={() => setEditLevels((prev) => [...prev, `Level ${prev.length + 1}`])}>+ Tambah Level</Button>
                  </div>
                  <div className="flex gap-2"><Button onClick={() => saveEdit(r)}>Simpan Perubahan Rak</Button><Button variant="outline" onClick={() => setEditId(null)}>Batal</Button></div>
                </CardContent>
              </Card>
            )}

            <div>
              {r.levels.map((lv) => (
                <div key={lv} className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
                  <span>{lv} — {levelTotal(r.id, lv)} unit</span>
                  <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => printLabels([labelFor(r, lv)])}><Printer className="size-4" /> Label</Button><Button size="sm" onClick={() => onOpenLevel(r.id, lv)}>Opname Level Ini Saja</Button></div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
