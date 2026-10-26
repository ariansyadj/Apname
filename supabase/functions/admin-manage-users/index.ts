// admin-manage-users — kelola akun Supabase Auth dari aplikasi (khusus Super Admin).
//
// Aksi: list (daftar akun), update (role / cabang / menu / nama / username /
// password), delete (hapus akun). Pola keamanan sama seperti
// admin-create-user: penelepon diverifikasi lewat JWT ke Supabase Auth dan
// harus ber-claim super; body request TIDAK PERNAH dipercaya untuk soal
// "siapa yang memanggil". Service role key hanya dibaca fungsi ini dari
// variabel bawaan Supabase — tidak pernah dikirim ke aplikasi, dan tidak
// ada secret baru yang perlu diisi.
//
// PENGAMAN:
// - Tidak bisa menghapus akun sendiri (biar Super Admin tidak mengunci
//   dirinya keluar dari sistem).
// - Tidak bisa menurunkan role sendiri dari super (alasan yang sama).
// - Update dilakukan dengan cara: baca dulu user target lewat Admin API,
//   gabungkan app_metadata/user_metadata lama dengan perubahan, lalu PUT
//   hasil gabungan — jadi mengubah menu saja tidak menghapus role/cabang,
//   dan sebaliknya.
// - Menu disimpan di app_metadata.menus (array id menu, mis. ["dashboard",
//   "stok", "opname"]). Aplikasi menyembunyikan menu yang tidak ada di
//   daftar itu; kalau klaim menus tidak ada (akun lama), semua menu tampil
//   seperti biasa. Menu "Kelola Akun" selalu tampil untuk Super Admin di
//   aplikasi, apa pun isi menus-nya, supaya tidak ada kondisi terkunci.

const MENU_IDS = ["dashboard", "stok", "cari", "master", "visual", "opname", "laporan", "pindah", "settings", "akun"];

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
  const ok = (data: Record<string, unknown>) =>
    new Response(JSON.stringify({ ok: true, ...data }), { headers: cors });
  try {
    if (req.method !== "POST") return fail(405, "POST only");
    const sbUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    if (!sbUrl || !serviceKey || !anonKey) {
      return fail(500, "Variabel bawaan Supabase belum tersedia di fungsi ini.");
    }

    // 1. Verifikasi penelepon = Super Admin (via token JWT, bukan body).
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return fail(401, "Login Supabase dulu.");
    const meRes = await fetch(`${sbUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
    });
    if (!meRes.ok) return fail(401, "Sesi tidak valid / sudah berakhir — login ulang sebagai Super Admin.");
    const me = await meRes.json() as { id?: string; app_metadata?: { role?: string } };
    if (me?.app_metadata?.role !== "super") {
      return fail(403, "Hanya Super Admin yang boleh mengelola akun.");
    }

    const adminHeaders = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    };
    const mapUser = (u: any) => ({
      id: u.id || "",
      email: u.email || "",
      name: (u.user_metadata && u.user_metadata.name) || u.email || "",
      username: (u.user_metadata && u.user_metadata.username) || "",
      role: (u.app_metadata && u.app_metadata.role) || "",
      branchId: (u.app_metadata && u.app_metadata.branch_id) || null,
      menus: Array.isArray(u.app_metadata && u.app_metadata.menus) ? u.app_metadata.menus : null,
      createdAt: u.created_at || null,
      lastSignInAt: u.last_sign_in_at || null,
    });

    const body = await req.json() as {
      action?: string; userId?: string; role?: string; branchId?: string | null;
      menus?: string[]; name?: string; username?: string; password?: string;
    };
    const action = body.action;

    // 2a. Daftar akun (paginasi Admin API, maks 10 halaman x 100).
    if (action === "list") {
      const users: unknown[] = [];
      for (let page = 1; page <= 10; page++) {
        const r = await fetch(`${sbUrl}/auth/v1/admin/users?per_page=100&page=${page}`, { headers: adminHeaders });
        if (!r.ok) return fail(400, `Gagal memuat daftar akun (${r.status}): ${(await r.text()).slice(0, 300)}`);
        const data = await r.json() as { users?: unknown[] };
        const batch = data.users || [];
        users.push(...batch);
        if (batch.length < 100) break;
      }
      return ok({ users: (users as any[]).map(mapUser) });
    }

    // 2b/2c butuh userId target.
    const userId = String(body.userId || "");
    if (!userId) return fail(400, "userId wajib diisi.");

    if (action === "delete") {
      if (userId === me.id) return fail(403, "Tidak bisa menghapus akun sendiri.");
      const r = await fetch(`${sbUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
        method: "DELETE", headers: adminHeaders,
      });
      if (!r.ok) return fail(400, `Gagal menghapus akun (${r.status}): ${(await r.text()).slice(0, 300)}`);
      return ok({ deleted: userId });
    }

    if (action === "update") {
      if (userId === me.id && body.role !== undefined && body.role !== "super") {
        return fail(403, "Tidak bisa menurunkan hak akses sendiri.");
      }
      if (body.role !== undefined && !["super", "admin", "karyawan"].includes(body.role)) {
        return fail(400, "Role harus super / admin / karyawan.");
      }
      if (body.menus !== undefined) {
        if (!Array.isArray(body.menus) || body.menus.some((m) => !MENU_IDS.includes(m))) {
          return fail(400, "Daftar menu tidak valid.");
        }
      }
      if (body.password !== undefined && body.password.length < 6) {
        return fail(400, "Password minimal 6 karakter.");
      }
      // Baca dulu, gabungkan, lalu PUT — supaya update parsial tidak
      // menghapus klaim/metadata yang tidak ikut diubah.
      const curRes = await fetch(`${sbUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { headers: adminHeaders });
      if (!curRes.ok) return fail(400, `Akun tidak ditemukan (${curRes.status}).`);
      const cur = await curRes.json() as any;
      const appMeta = { ...(cur.app_metadata || {}) };
      if (body.role !== undefined) appMeta.role = body.role;
      if (body.branchId !== undefined) appMeta.branch_id = body.role === "super" ? null : body.branchId;
      if (body.menus !== undefined) appMeta.menus = body.menus;
      const userMeta = { ...(cur.user_metadata || {}) };
      if (body.name !== undefined) userMeta.name = body.name;
      if (body.username !== undefined) userMeta.username = body.username;
      const putBody: Record<string, unknown> = { app_metadata: appMeta, user_metadata: userMeta };
      if (body.password !== undefined) putBody.password = body.password;
      const r = await fetch(`${sbUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
        method: "PUT", headers: adminHeaders, body: JSON.stringify(putBody),
      });
      if (!r.ok) return fail(400, `Gagal mengubah akun (${r.status}): ${(await r.text()).slice(0, 300)}`);
      return ok({ user: mapUser(await r.json()) });
    }

    return fail(400, "Action harus list / update / delete.");
  } catch (e) {
    return fail(500, e instanceof Error ? e.message : String(e));
  }
});
