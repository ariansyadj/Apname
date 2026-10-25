import QRCode from 'qrcode';

export type LabelItem = {
  branchId: string;
  branchName: string;
  rackId: string;
  rackName: string;
  rackType: 'normal' | 'retur';
  level: string;
};

/** Kode QR level: identitas lokasi, bukan produk. Formatnya eksplisit agar
 *  bisa dibaca kamera HP apa pun tanpa aplikasi khusus. */
export function labelCode(item: LabelItem): string {
  return `APNAME|${item.branchId}|${item.rackId}|${item.level}`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Buka jendela cetak baru berisi label-labelnya, lalu cetak dari jendela itu.
 * QR dibuat lokal di browser (library qrcode), tidak ada data yang dikirim
 * ke layanan QR online. Jendela cetak harus diizinkan popup-nya oleh browser.
 */
export async function printLabels(items: LabelItem[]): Promise<void> {
  if (items.length === 0) {
    alert('Tidak ada label yang dipilih.');
    return;
  }
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) {
    alert('Popup diblokir browser. Izinkan popup untuk situs ini, lalu tekan Cetak Label lagi.');
    return;
  }
  win.document.write('<html><head><title>Label Rak — Apname</title><style>body{font-family:Arial,sans-serif;margin:16px} .grid{display:flex;flex-wrap:wrap;gap:12px} .label{width:280px;border:2px solid #111;border-radius:10px;padding:12px;text-align:center;page-break-inside:avoid} .rack{font-size:26px;font-weight:800;margin:0} .level{font-size:20px;font-weight:700;margin:6px 0} .meta{font-size:13px;color:#333} .code{font-family:monospace;font-size:11px;word-break:break-all;margin-top:6px} img{width:180px;height:180px} .note{font-size:12px;color:#555;margin-bottom:12px} @media print{ .note,.noprint{display:none} body{margin:0} }</style></head><body>');
  win.document.write('<p class="note">QR di bawah mengidentifikasi RAK + LEVEL (lokasi), bukan produk. Pindai dengan kamera HP untuk melihat kodenya. Tekan tombol Cetak di bawah, atau Ctrl+P.</p><button class="noprint" onclick="window.print()">Cetak</button><div class="grid">');
  for (const item of items) {
    const code = labelCode(item);
    const qr = await QRCode.toDataURL(code, { width: 360, margin: 1 });
    win.document.write(
      `<div class="label"><p class="rack">${esc(item.rackName)}</p>` +
        `<p class="level">${esc(item.level)}${item.rackType === 'retur' ? ' — RETUR' : ''}</p>` +
        `<p class="meta">${esc(item.branchName)} • ${esc(item.rackId)}</p>` +
        `<img src="${qr}" alt="QR ${esc(code)}" />` +
        `<p class="code">${esc(code)}</p></div>`,
    );
  }
  win.document.write('</div></body></html>');
  win.document.close();
  win.focus();
}
