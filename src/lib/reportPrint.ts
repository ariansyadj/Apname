export type ReportRow = {
  name: string;
  variant: string;
  sku: string;
  rackId: string;
  level: string;
  sys: number;
  mutIn: number;
  mutOut: number;
  adjusted: number;
  fis: number;
  diff: number;
  scanned: boolean;
  lastScan: string;
};

export type ReportMeta = {
  id: string;
  title: string;
  branchId: string;
  scope: string;
  created: string;
  locked: string;
  totalRows: number;
  cocok: number;
  lebih: number;
  kurang: number;
  belum: number;
  scanCount: number;
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Cetak ISI laporan (tabel hasil scan), bukan halaman aplikasi.
 * Jendela cetak baru berisi tabel yang sama persis dengan sheet
 * "Detail Opname" di file .xlsx: Fisik dihitung dari total qty scan
 * per produk/rak/level, bukan dari stok live di luar sesi.
 * Dari jendela itu, Ctrl+P -> "Save as PDF" menghasilkan PDF isi laporan.
 */
export function printReport(meta: ReportMeta, rows: ReportRow[]): void {
  const win = window.open('', '_blank', 'width=1000,height=750');
  if (!win) {
    alert('Popup diblokir browser. Izinkan popup untuk situs ini, lalu tekan PDF Isi Laporan lagi.');
    return;
  }
  const status = (r: ReportRow) =>
    !r.scanned ? 'Belum dihitung' : r.diff === 0 ? 'Cocok' : r.diff > 0 ? 'Lebih' : 'Kurang';
  const body = rows
    .map(
      (r) =>
        `<tr><td>${esc(r.name)}</td><td>${esc(r.variant)}</td><td>${esc(r.sku)}</td><td>${esc(r.rackId)}</td><td>${esc(r.level)}</td><td>${r.sys}</td><td>${r.mutIn}</td><td>${r.mutOut}</td><td>${r.adjusted}</td><td><b>${r.fis}</b></td><td>${r.diff}</td><td>${esc(status(r))}</td><td>${esc(r.lastScan)}</td></tr>`,
    )
    .join('');
  win.document.write(`<html><head><title>Laporan Opname ${esc(meta.id)} — Apname</title><style>
    body{font-family:Arial,sans-serif;margin:16px;color:#111}
    h1{font-size:20px;margin:0 0 4px} h2{font-size:14px;margin:16px 0 6px}
    .meta{font-size:13px;color:#333;line-height:1.6}
    table{border-collapse:collapse;width:100%;font-size:12px}
    th,td{border:1px solid #999;padding:5px 6px;text-align:left}
    th{background:#eee}
    .note{font-size:12px;color:#555;margin:8px 0}
    @media print{ .note,.noprint{display:none} body{margin:0} }
    </style></head><body>`);
  win.document.write(`<p class="note">Ini ISI laporan, bukan halaman aplikasi. Tekan tombol Cetak di bawah, atau Ctrl+P, lalu pilih "Save as PDF" untuk menyimpan sebagai PDF.</p><button class="noprint" onclick="window.print()">Cetak / Simpan PDF</button>`);
  win.document.write(`<h1>Laporan Opname — ${esc(meta.id)}</h1><div class="meta">
    Judul: ${esc(meta.title)}<br/>Cabang: ${esc(meta.branchId)}<br/>Scope: ${esc(meta.scope)}<br/>
    Dibuat: ${esc(meta.created)} • Dikunci: ${esc(meta.locked)} • Jumlah scan: ${meta.scanCount}<br/>
    Total baris: ${meta.totalRows} • Cocok: ${meta.cocok} • Lebih: ${meta.lebih} • Kurang: ${meta.kurang} • Belum dihitung: ${meta.belum}
    </div>`);
  win.document.write(`<h2>Detail Hasil Scan (sama dengan sheet Detail Opname di .xlsx)</h2>
    <p class="note">Fisik = total jumlah hasil scan per produk/rak/level di sesi ini. Snapshot = stok sistem saat sesi dibuat. Selisih = Fisik − Stok Sistem Disesuaikan.</p>
    <table><thead><tr><th>Produk</th><th>Varian</th><th>SKU</th><th>Rak</th><th>Level</th><th>Snapshot</th><th>Mut. Masuk</th><th>Mut. Keluar</th><th>Stok Disesuaikan</th><th>Fisik (Hasil Scan)</th><th>Selisih</th><th>Status</th><th>Scan Terakhir</th></tr></thead><tbody>${body || '<tr><td colspan="13">Belum ada baris di laporan ini.</td></tr>'}</tbody></table>`);
  win.document.write('</body></html>');
  win.document.close();
  win.focus();
}
