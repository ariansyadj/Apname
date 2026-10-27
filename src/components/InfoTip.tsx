import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

// Tombol "i" kecil untuk keterangan/tips: teks keterangan disembunyikan
// sampai tombol diketuk, supaya layar kerja tidak penuh paragraf abu-abu.
// Dipakai untuk teks penjelasan cara pakai; status, pesan kosong, error,
// dan peringatan penting (mis. soal kunci sesi) tetap tampil langsung.
export function InfoTip({ children, className = '' }: { children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      <Button variant="outline" size="sm" className="h-6 w-6 rounded-full p-0 text-xs leading-none" onClick={() => setOpen((v) => !v)} aria-label="Keterangan" title="Keterangan">i</Button>
      {open && <div className="mt-1 text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}
