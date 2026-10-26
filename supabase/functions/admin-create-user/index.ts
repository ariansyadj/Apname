// admin-create-user — buat akun Supabase Auth dari aplikasi (khusus Super Admin).
//
// ALUR: Super Admin mengisi form di aplikasi (Kelola Akun, mode cloud) ->
// aplikasi memanggil fungsi ini dengan JWT user-nya -> fungsi MEMVERIFIKASI
// dulu bahwa penelepon benar Super Admin (via /auth/v1/user + klaim
// app_metadata.role) -> kalau ya, fungsi membuat user baru lewat Admin API
// dengan email_confirm=true (langsung aktif, tanpa email konfirmasi) dan
// klaim role/cabang langsung terpasang (app_metadata).
//
// KEAMANAN — baca sebelum mengubah:
// - Fungsi ini TIDAK PERNAH percaya klaim dari body request. Satu-satunya
//   sumber kebenaran role penelepon adalah token JWT yang diverifikasi
//   Supabase Auth. Body hanya membawa data akun BARU.
// - Service role key TIDAK PERNAH dikirim ke aplikasi. Ia hanya dibaca
//   fungsi ini dari variabel bawaan Supabase (sama seperti SUPABASE_URL —
//   keduanya otomatis tersedia, tidak perlu diisi manual di Secrets).
// - Jangan tambahkan jalur "self-signup" di sini: siapa pun yang bisa
//   memanggil fungsi tanpa verifikasi super bisa membuat akun super
//   untuk dirinya sendiri.
// - Tidak ada secret baru yang perlu diset untuk fungsi ini.

Deno.serve(async (req: Request) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const fail = (status: number, error: string) =>
    new Response(JSON.stringify({ ok: false, error }), { status, headers: cors });
  try {
    if (req.method !== "POST") return fail(405, "POST only");
    const sbUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    if (!sbUrl || !serviceKey || !anonKey) {
      return fail(500, "Variabel bawaan Supabase (SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY) belum tersedia di fungsi ini.");
    }

    // 1. Verifikasi penelepon = Super Admin (via token JWT, bukan body).
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return fail(401, "Login Supabase dulu.");
    const meRes = await fetch(`${sbUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
    });
    if (!meRes.ok) return fail(401, "Sesi tidak valid / sudah berakhir — login ulang sebagai Super Admin.");
    const me = await meRes.json() as { app_metadata?: { role?: string } };
    if (me?.app_metadata?.role !== "super") {
      return fail(403, "Hanya Super Admin yang boleh membuat akun.");
    }

    // 2. Validasi input akun baru.
    const body = await req.json() as {
      email?: string; password?: string; name?: string; username?: string;
      role?: string; branchId?: string | null;
    };
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const name = String(body.name || "").trim();
    const role = body.role;
    const branchId = role === "super" ? null : (body.branchId || null);
    if (!email.includes("@")) return fail(400, "Email tidak valid.");
    if (password.length < 6) return fail(400, "Password minimal 6 karakter.");
    if (role !== "super" && role !== "admin" && role !== "karyawan") {
      return fail(400, "Role harus super / admin / karyawan.");
    }
    if (role !== "super" && !branchId) {
      return fail(400, "Admin/Karyawan wajib punya cabang.");
    }
    if (branchId) {
      // Cabang harus benar-benar ada di tabel branches.
      const bRes = await fetch(`${sbUrl}/rest/v1/branches?id=eq.${encodeURIComponent(branchId)}&select=id`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      const rows = bRes.ok ? (await bRes.json() as unknown[]) : [];
      if (!Array.isArray(rows) || rows.length === 0) return fail(400, "Cabang tidak dikenal.");
    }

    // 3. Buat user via Admin API (auto-confirm + klaim langsung).
    const createRes = await fetch(`${sbUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        app_metadata: { role, branch_id: branchId },
        user_metadata: { name: name || email, ...(body.username ? { username: body.username } : {}) },
      }),
    });
    if (!createRes.ok) {
      const txt = await createRes.text();
      return fail(400, `Gagal membuat akun (${createRes.status}): ${txt.slice(0, 300)}`);
    }
    const created = await createRes.json() as { id?: string };
    return new Response(JSON.stringify({
      ok: true, userId: created.id || null, email, role, branch_id: branchId,
    }), { headers: cors });
  } catch (e) {
    return fail(500, e instanceof Error ? e.message : String(e));
  }
});
