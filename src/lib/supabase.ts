// Data layer: Supabase when VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
// are present, otherwise the app falls back to localStorage demo data.
// No credential is hard-coded here; values come only from the environment.
// The client is dynamically imported so the Supabase SDK does not inflate
// the initial bundle when it is not configured.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isSupabaseConfigured = !!(url && anonKey)

// Best-effort load of racks from a live Supabase project that already
// has schema.sql applied. Returns null when not configured, when the
// table does not exist yet, or on any error, so the demo fallback stays
// usable instead of breaking the app.
export async function loadRacksFromSupabase(): Promise<import("../data").Rack[] | null> {
  if (!isSupabaseConfigured || !url || !anonKey) return null
  try {
    const { createClient } = await import("@supabase/supabase-js")
    const supabase = createClient(url, anonKey)
    const { data, error } = await supabase.from("racks").select("*")
    if (error || !data) return null
    return data.map((r: Record<string, unknown>) => ({
      id: String(r.id),
      branchId: String(r.branch_id),
      name: String(r.name),
      type: r.type === "retur" ? "retur" : "normal",
      levels: Array.isArray(r.levels) ? (r.levels as string[]) : [],
      x: Number(r.x ?? 20),
      y: Number(r.y ?? 20),
      w: Number(r.w ?? 160),
      h: Number(r.h ?? 90),
      rot: Number(r.rot ?? 0),
    }))
  } catch {
    return null
  }
}
