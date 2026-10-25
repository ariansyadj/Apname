/**
 * Lebar kolom KONSISTEN untuk semua output laporan (Excel .xlsx).
 * Satu nama kolom = satu lebar, di sheet mana pun ia muncul — jadi
 * "Produk" tidak lebar di satu sheet dan sempit di sheet lain, dan
 * "SKU"/"Varian"/"Rak"/"Level" selalu sama. Dipakai exportExcel di
 * App.tsx dan exportIsiExcel di MasterRacks.tsx.
 * Angka = lebar karakter ExcelJS (bukan piksel).
 */
export const COL_WIDTHS: Record<string, number> = {
  Produk: 36,
  Varian: 18,
  SKU: 18,
  Rak: 12,
  Level: 16,
  Kategori: 20,
  'Stok Snapshot': 14,
  'Mutasi Masuk': 13,
  'Mutasi Keluar': 13,
  'Stok Sistem Disesuaikan': 16,
  'Stok Disesuaikan': 16,
  Fisik: 12,
  'Fisik (Hasil Scan)': 14,
  'Selisih Akhir': 13,
  Selisih: 13,
  Status: 12,
  'Waktu Scan Pertama': 19,
  'Waktu Scan Terakhir': 19,
  'Scan Terakhir': 19,
  'Waktu Verifikasi': 16,
  'Stok di Level Ini': 16,
  'Harga Jual': 14,
  'Total Nilai': 16,
};

const DEFAULT_WIDTH = 14;

/** Rapikan satu sheet: lebar kolom dari nama header, header tebal +
 *  latar abu + teks melingkar, dan baris header dibekukan (freeze) supaya
 *  tetap terlihat saat scroll. headerRowIdx = baris header (1-based). */
export function styleReportSheet(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ws: any,
  headerRowIdx: number,
): void {
  const header = ws.getRow(headerRowIdx);
  const headers: string[] = [];
  header.eachCell?.((cell: { value?: unknown }) => {
    headers.push(String(cell.value ?? ''));
  });
  ws.columns = headers.map((h) => ({ width: COL_WIDTHS[h] ?? DEFAULT_WIDTH }));
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.height = 30;
  const lastCol = String.fromCharCode(64 + Math.max(1, headers.length));
  ws.views = [{ state: 'frozen', ySplit: headerRowIdx }];
  ws.autoFilter = { from: `A${headerRowIdx}`, to: `${lastCol}${headerRowIdx}` };
}
