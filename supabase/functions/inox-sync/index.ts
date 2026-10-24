// Supabase Edge Function skeleton: iNOX stock-report sync.
// SKELETON ONLY — not deployed, not tested against a live iNOX session.
// Credentials come ONLY from Edge Function secrets (INOX_USERNAME,
// INOX_PASSWORD). Never put them in frontend code, in this file, or in git.
//
// iNOX facts this skeleton is built on (from the project prompt §5.7):
// - The stock feed is the stock-report page itself, a server-side
//   DataTables GET to https://inox.my.id/reports/stock-report
//   (X-Requested-With: XMLHttpRequest, Accept: application/json).
// - One row = one product variation in one business location, keyed by
//   product_id + variation_id + location_id. Numbers must be read from
//   data-orig-value attributes, not display text.
// - Paging: start/length, draw incrementing, stop when collected rows
//   equal recordsTotal from the first response. Do not hard-code 2544.
// - iNOX is a Laravel app: a real login needs the login page's CSRF
//   token (_token) from a cookie + form, then a POST to /login, then
//   the session cookie on every feed request. The steps below fetch
//   the token generically; if iNOX changes its login form, update
//   only the token extraction, not the paging logic.
//
// TODO before production use:
//  1. Verify the exact login form field names and CSRF flow live.
//  2. Add retry + backoff, per-page logging, and a "last sync" row.
//  3. Write rows to products/stock tables WITHOUT overwriting
//     per-rack stock: new products go to "Belum Ditempatkan" only,
//     existing products update only their external total + timestamp.
//  4. Never write anything back to iNOX from this function.

const BASE = "https://inox.my.id";

function getCookie(cookies: string[], name: string): string | null {
  for (const c of cookies) {
    const m = c.match(new RegExp(`^${name}=([^;]+)`));
    if (m) return m[1];
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }
  const username = Deno.env.get("INOX_USERNAME");
  const password = Deno.env.get("INOX_PASSWORD");
  if (!username || !password) {
    return new Response(
      JSON.stringify({ error: "INOX_USERNAME / INOX_PASSWORD secrets not set" }),
      { status: 500 },
    );
  }

  // 1. Login page -> CSRF token + session cookie.
  const loginPage = await fetch(`${BASE}/login`, { headers: { Accept: "text/html" } });
  const html = await loginPage.text();
  const tokenMatch = html.match(/name="_token"[^>]*value="([^"]+)"/);
  const setCookie = loginPage.headers.getSetCookie?.() ?? [];
  const sessionCookie = getCookie(setCookie, "inox_session") ?? getCookie(setCookie, "laravel_session") ?? "";

  // 2. POST login (field names to verify live; see TODO above).
  const form = new URLSearchParams();
  if (tokenMatch) form.set("_token", tokenMatch[1]);
  form.set("username", username);
  form.set("password", password);
  const loginRes = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: sessionCookie ? `laravel_session=${sessionCookie}` : "",
    },
    body: form.toString(),
    redirect: "manual",
  });
  const afterLogin = loginRes.headers.getSetCookie?.() ?? setCookie;
  const cookieHeader = afterLogin.map((c) => c.split(";")[0]).join("; ");

  // 3. Page the DataTables feed until recordsTotal is reached.
  const allRows: unknown[] = [];
  let start = 0;
  const length = 25;
  let draw = 1;
  let recordsTotal: number | null = null;
  while (recordsTotal === null || allRows.length < recordsTotal) {
    const params = new URLSearchParams({
      draw: String(draw),
      start: String(start),
      length: String(length),
      "search[value]": "",
      "search[regex]": "false",
      "order[0][column]": "1",
      "order[0][dir]": "asc",
      location_id: "",
      category_id: "",
      sub_category_id: "",
      brand_id: "",
      unit_id: "",
      only_mfg_products: "0",
      _: String(Date.now()),
    });
    const res = await fetch(`${BASE}/reports/stock-report?${params}`, {
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
        Referer: `${BASE}/reports/stock-report`,
        Cookie: cookieHeader,
      },
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return new Response(JSON.stringify({ error: "Feed returned HTML, session likely expired" }), { status: 401 });
    }
    const page = await res.json() as { recordsTotal: number; data: unknown[] };
    if (recordsTotal === null) recordsTotal = page.recordsTotal;
    allRows.push(...page.data);
    if (page.data.length === 0) break;
    start += length;
    draw += 1;
  }

  return new Response(JSON.stringify({
    ok: true,
    recordsTotal,
    rows: allRows.length,
    note: "Skeleton: rows fetched, not yet written to Supabase tables (see TODO in file header).",
  }), { headers: { "Content-Type": "application/json" } });
});
