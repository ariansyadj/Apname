// Konfigurasi mode VPS untuk frontend Apname.
// Build VPS menyetel VITE_VPS_MODE=1 (API + WebSocket satu origin dengan
// aplikasi, jadi tidak perlu URL). VITE_VPS_URL opsional untuk dev
// (mis. http://localhost:4000 saat Vite jalan di 5173).
export const VPS_BASE = (import.meta.env.VITE_VPS_URL as string) || "";
export const isVpsConfigured =
  (import.meta.env.VITE_VPS_MODE as string) === "1" || !!VPS_BASE;
