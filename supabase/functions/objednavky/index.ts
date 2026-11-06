// Supabase Edge Function „objednavky" — vše, co nesmí být ve veřejné stránce (6. 11. 2026):
//   • stažení objednávek z e-shopu (adresa API s heslem je jen v tabulce „tajne", stránka ji nikdy nevidí),
//   • mapa fotek produktů z heureka feedu (prohlížeč feed stáhnout nesmí – CORS),
//   • uživatelé appky (účty zakládá správce, žádné veřejné registrace),
//   • přihlášení Tiskového pomocníka (vlastní účet tiskarna@objednavky.local, smí jen do tiskové fronty).
// „Verify JWT" vypnout – přihlášení ověřuje funkce sama (automatické spouštění z pg_cron přihlášení nemá).
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY dává Supabase sám; PPL_APP_PIN (jen pro první účet).
//
// Volání: POST { action, ... }
//   verejny                      → { prvni: true } když ještě nikdo nemá účet (appka ukáže „Založit správce")
//   prvni     { email, heslo, jmeno, pin } → první účet = správce (jen když nikdo jiný není a PIN sedí)
//   ja        (člen)             → { email, jmeno, admin }
//   sync      (člen)             → stáhne objednávky z e-shopu hned (tlačítko v appce)
//   cron                         → totéž automaticky (pg_cron), nejvýš 1× za 5 min
//   fotky     (člen) / fotky_cron → obnoví mapu fotek z feedu a doplní chybějící fotky do objednávek
//   stav      (člen)             → poslední sync / fotky / zda je zadané API e-shopu
//   api       (správce) { url }  → nová adresa API e-shopu (po změně hesla v administraci e-shopu); ověří a uloží
//   clenove   (správce)          → seznam členů
//   pridat    (správce) { email, jmeno, heslo, admin } → založí / upraví účet
//   heslo     (správce) { email, heslo } → nové heslo kolegovi
//   odebrat   (správce) { email } → zruší přístup (účet smaže)
//   tisk_prihlas { klic }        → přístup pro Tiskového pomocníka (klíč z tabulky tajne „tisk_klic")

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-app-pin",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") || "";
const FEED_URL = "https://www.drozda-naradi.cz/fotky92438/xml/heureka_cz.xml";
const TISKARNA = "tiskarna@objednavky.local";

async function db(path: string, init: RequestInit = {}) {
  const h = new Headers(init.headers);
  h.set("apikey", SB_KEY); h.set("Authorization", `Bearer ${SB_KEY}`);
  if (init.body) h.set("Content-Type", "application/json");
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: h });
  const t = await r.text();
  if (!r.ok) throw new Error(`Databáze (${r.status}): ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
async function auth(path: string, init: RequestInit = {}) {
  const h = new Headers(init.headers);
  h.set("apikey", SB_KEY); h.set("Authorization", `Bearer ${SB_KEY}`); h.set("Content-Type", "application/json");
  const r = await fetch(`${SB_URL}/auth/v1/${path}`, { ...init, headers: h });
  const t = await r.text();
  let d: any = null; try { d = t ? JSON.parse(t) : null; } catch { /* */ }
  if (!r.ok) throw new Error(d?.msg || d?.message || d?.error_description || `Přihlašování (${r.status})`);
  return d;
}
const tajne = async (klic: string) => (await db(`tajne?select=hodnota&klic=eq.${klic}`))?.[0]?.hodnota || "";
const ulozTajne = (klic: string, hodnota: string) => db("tajne?on_conflict=klic", { method: "POST",
  headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ klic, hodnota, zmeneno: new Date().toISOString() }) });
const nastaveni = async (key: string) => (await db(`app_settings?select=value&key=eq.${key}`))?.[0]?.value || null;
const ulozNastaveni = (key: string, value: unknown) => db("app_settings?on_conflict=key", { method: "POST",
  headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }) });

// přihlášený člen z hlavičky Authorization (token ze supabase-js v prohlížeči)
async function clen(req: Request) {
  const a = req.headers.get("authorization") || "";
  if (!a.startsWith("Bearer ") || a.slice(7) === ANON) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: a } });
  if (!r.ok) return null;
  const u = await r.json();
  const email = String(u?.email || "").toLowerCase();
  if (!email) return null;
  const c = (await db(`clenove?select=email,jmeno,admin&email=eq.${encodeURIComponent(email)}`))?.[0];
  return c ? { ...c, id: u.id } : null;
}

// ---------- e-shop → objednávky ----------
function datum(s: unknown) {   // „2026-11-05 15:34:19.000000" je čas v Praze
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  // posun Prahy proti UTC v tu chvíli (zimní +1 h / letní +2 h)
  const casti = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Prague", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(utc)).map((x) => [x.type, x.value]));
  const praha = Date.UTC(+casti.year, +casti.month - 1, +casti.day, +casti.hour, +casti.minute, +casti.second);
  return new Date(utc - (praha - utc)).toISOString();
}
// porovnání bez ohledu na pořadí klíčů (jsonb v databázi klíče přeskládá)
const kanon = (v: any): string => v === null || v === undefined || v === "" ? "null" : Array.isArray(v) ? "[" + v.map(kanon).join(",") + "]"
  : typeof v === "object" ? "{" + Object.keys(v).filter((k) => v[k] !== undefined && v[k] !== null && v[k] !== "").sort().map((k) => JSON.stringify(k) + ":" + kanon(v[k])).join(",") + "}"
  : typeof v === "number" || /^-?\d+(\.\d+)?$/.test(String(v)) ? String(Number(v)) : JSON.stringify(v);
const cislo = (v: unknown) => { const n = parseFloat(String(v ?? "").replace(",", ".")); return isFinite(n) ? n : 0; };

async function mapaFotek(): Promise<Record<string, string>> {
  return (await db("product_image_cache?select=map&id=eq.main"))?.[0]?.map || {};
}

async function syncEshop(kdo: string) {
  const api = await tajne("eshop_api");
  if (!api) throw new Error("Chybí adresa API e-shopu – zadej ji v Nastavení → E-shop.");
  const r = await fetch(api, { headers: { "User-Agent": "objednavky-admin-pro" } });
  if (!r.ok) throw new Error(`E-shop odpověděl HTTP ${r.status}`);
  const j = await r.json().catch(() => null);
  if (!j?.success) throw new Error("E-shop API vrátil chybu: " + (j?.report || "neznámá – je adresa API správná?"));
  const list: any[] = j.params?.orderList || [];
  const mapa = await mapaFotek();
  const POLE = ["customer_name", "customer_email", "customer_phone", "company", "delivery_address", "billing_address",
    "shipping_method", "payment_method", "total_amount", "items"];
  const vse: any[] = await db("orders?select=id,order_number,order_date," + POLE.join(","));
  const podleCisla = new Map(vse.map((o) => [String(o.order_number), o]));
  const fotkaSku: Record<string, string> = {};
  for (const o of vse) for (const it of (o.items || [])) if (it?.sku && it?.img) fotkaSku[it.sku] = it.img;
  let nove = 0, upraveno = 0;
  const chyby: string[] = [];
  for (const o of list) {
    const num = String(o.number || o.id_order || "");
    if (!num) continue;
    try {
      const c = o.customer?.delivery_information || {};
      const b = o.customer?.billing_information || o.customer?.invoice_information || {};
      const ex = podleCisla.get(num);
      const exProd = (ex?.items || []).filter((x: any) => !x.type);
      const items: any[] = (o.row_list || []).map((p: any, i: number) => {
        const sku = String(p.product_number || ""), pid = String(p.product_id || "");
        const img = (pid && mapa[pid]) || exProd.find((x: any) => x.sku && x.sku === sku && x.img)?.img || exProd[i]?.img || fotkaSku[sku] || "";
        return { name: p.product_name || "", sku, qty: Math.round(cislo(p.count) || 1), price_with_vat: cislo(p.price_per_unit_with_vat),
          price_without_vat: cislo(p.price_per_unit), total_with_vat: cislo(p.price_total_with_vat), img,
          availability: p.availability ?? null, availability_text: String(p.availabilityText || "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim() };
      });
      const shipVat = cislo(o.delivery?.postovne), payVat = cislo(o.payment?.castka_platba);
      const shipNo = cislo(o.delivery?.postovne_bez_dph || o.delivery?.postovne_bez) || (shipVat ? Math.round(shipVat / 1.21 * 100) / 100 : 0);
      const payNo = cislo(o.payment?.castka_platba_bez_dph || o.payment?.castka_bez) || (payVat ? Math.round(payVat / 1.21 * 100) / 100 : 0);
      if (o.delivery?.nazev_postovne !== undefined) items.push({ type: "shipping", name: o.delivery.nazev_postovne || "Doprava", price_with_vat: shipVat, price_without_vat: shipNo, qty: 1 });
      if (o.payment?.nazev_platba !== undefined) items.push({ type: "payment", name: o.payment.nazev_platba || "Platba", price_with_vat: payVat, price_without_vat: payNo, qty: 1 });
      const mesto = (x: any) => String(x?.city || "").replace(/\s*\[.*?\]/g, "").trim();
      const ico = c.ico || b.ico || o.customer?.ico || o.ico || "";
      const dic = c.dic || b.dic || o.customer?.dic || o.dic || c.vat || b.vat || "";
      const firma = [c.company || b.company || "", ico ? "IČO:" + ico : "", dic ? "DIČ:" + dic : ""].filter(Boolean);
      const row: Record<string, unknown> = { order_number: num, customer_name: c.name || b.name || "", customer_email: c.email || b.email || "",
        customer_phone: c.phone || b.phone || "", company: firma.join("|"), delivery_address: [c.street, mesto(c), c.zip].filter(Boolean).join(", "),
        billing_address: [b.street, mesto(b), b.zip].filter(Boolean).join(", ") || null,
        shipping_method: o.delivery?.nazev_postovne || "", payment_method: o.payment?.nazev_platba || "",
        total_amount: cislo(o.total?.price_with_vat) || null, items };
      const d = datum(o.created?.date);
      if (d) row.order_date = d;
      if (ex) {
        // zapsat jen když se v e-shopu něco změnilo (jinak by každý běh rozeslal změnu všem otevřeným appkám)
        const jine = POLE.some((k) => kanon(ex[k]) !== kanon(row[k])) ||
          (row.order_date && new Date(String(row.order_date)).getTime() !== new Date(ex.order_date).getTime());
        if (jine) {
          await db(`orders?id=eq.${ex.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
          upraveno++;
        }
      } else {
        // unikátní číslo objednávky: když ji mezitím založil jiný běh, nic se nezdvojí
        await db("orders?on_conflict=order_number", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
          body: JSON.stringify({ ...row, order_date: row.order_date || new Date().toISOString(), status: "new" }) });
        nove++;
      }
    } catch (e) { chyby.push(`${num}: ${(e as Error).message}`); }
  }
  const s = { posledni: new Date().toISOString(), kdo, nove, upraveno, v_eshopu: list.length, chyby: chyby.slice(0, 5), chyba: null };
  await ulozNastaveni("eshop_stav", s);
  return s;
}

// ---------- mapa fotek (feed ~40 MB čte po kouscích) ----------
async function obnovFotky(kdo: string) {
  const r = await fetch(FEED_URL, { headers: { "User-Agent": "objednavky-admin-pro" } });
  if (!r.ok || !r.body) throw new Error(`Feed fotek: HTTP ${r.status}`);
  const nova: Record<string, string> = {};
  const rd = r.body.pipeThrough(new TextDecoderStream()).getReader();
  const hodnota = (x: string, tag: string) => {
    const m = x.match(new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?\\s*([^<\\]]*?)\\s*(?:\\]\\]>)?\\s*</${tag}>`));
    return m ? m[1].replace(/&amp;/g, "&").trim() : "";
  };
  let buf = "";
  for (;;) {
    const { value, done } = await rd.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf("</SHOPITEM>")) >= 0) {
      const item = buf.slice(0, i); buf = buf.slice(i + 11);
      const id = hodnota(item, "ITEM_ID"), img = hodnota(item, "IMGURL");
      if (id && img) nova[id] = img;
    }
  }
  const stara = await mapaFotek();
  const nS = Object.keys(stara).length, nN = Object.keys(nova).length;
  if (nN < 1000 || (nS && nN < nS * 0.5)) throw new Error(`Feed fotek vypadá useknutý (${nN} produktů, dřív ${nS}) – mapu nepřepisuji.`);
  const mapa = { ...stara, ...nova };
  await db("product_image_cache?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ id: "main", map: mapa, updated_at: new Date().toISOString() }) });
  // objednávky bez fotky: doplnit ze stejného kódu v jiné objednávce (mapa je podle ID produktu – to doplní sync)
  const vse: any[] = await db("orders?select=id,items");
  const fotkaSku: Record<string, string> = {};
  for (const o of vse) for (const it of (o.items || [])) if (it?.sku && it?.img) fotkaSku[it.sku] = it.img;
  let doplneno = 0;
  for (const o of vse) {
    if (!Array.isArray(o.items) || !o.items.some((it: any) => !it.type && !it.img && fotkaSku[it.sku])) continue;
    const items = o.items.map((it: any) => (!it.type && !it.img && fotkaSku[it.sku]) ? { ...it, img: fotkaSku[it.sku] } : it);
    await db(`orders?id=eq.${o.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ items }) });
    doplneno++;
  }
  const s = { posledni: new Date().toISOString(), kdo, fotek: Object.keys(mapa).length, novych: Object.keys(nova).filter((k) => !(k in stara)).length, doplneno, chyba: null };
  await ulozNastaveni("fotky_stav", s);
  return s;
}

// ---------- uživatelé ----------
async function authUzivatel(email: string) {
  const d = await auth(`admin/users?per_page=1000`);
  return (d?.users || []).find((u: any) => String(u.email).toLowerCase() === email);
}
async function zalozUcet(email: string, heslo: string, jmeno: string) {
  const u = await authUzivatel(email);
  if (u) return auth(`admin/users/${u.id}`, { method: "PUT", body: JSON.stringify({ password: heslo, email_confirm: true, user_metadata: { jmeno } }) });
  return auth("admin/users", { method: "POST", body: JSON.stringify({ email, password: heslo, email_confirm: true, user_metadata: { jmeno } }) });
}
const platnyEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const platneHeslo = (h: string) => h.length >= 8;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const p = await req.json().catch(() => ({}));
    const action = String(p.action || "");

    // --- bez přihlášení ---
    if (action === "verejny") {
      const c = await db("clenove?select=email&limit=1");
      return json({ prvni: !c?.length });
    }
    if (action === "prvni") {
      const c = await db("clenove?select=email&limit=1");
      if (c?.length) return json({ error: "Správce už existuje – účet ti založí v Nastavení → Uživatelé." }, 403);
      const pin = Deno.env.get("PPL_APP_PIN");
      if (!pin || String(p.pin || "") !== pin) { await new Promise((r) => setTimeout(r, 1500)); return json({ error: "Špatný PIN." }, 401); }
      const email = String(p.email || "").trim().toLowerCase(), heslo = String(p.heslo || ""), jmeno = String(p.jmeno || "").trim();
      if (!platnyEmail(email) || !platneHeslo(heslo) || !jmeno) return json({ error: "Vyplň jméno, e-mail a heslo (aspoň 8 znaků)." }, 400);
      await zalozUcet(email, heslo, jmeno);
      await db("clenove", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ email, jmeno, admin: true, pridal: "první spuštění" }) });
      return json({ ok: true });
    }
    if (action === "cron") {
      const st = await nastaveni("eshop_stav");
      if (st?.posledni && Date.now() - new Date(st.posledni).getTime() < 5 * 60e3) return json({ ok: true, preskoceno: true });
      try { return json({ ok: true, ...(await syncEshop("automaticky")) }); }
      catch (e) { await ulozNastaveni("eshop_stav", { ...(st || {}), posledni: new Date().toISOString(), kdo: "automaticky", chyba: (e as Error).message }); throw e; }
    }
    if (action === "fotky_cron") {
      const st = await nastaveni("fotky_stav");
      if (st?.posledni && Date.now() - new Date(st.posledni).getTime() < 30 * 60e3) return json({ ok: true, preskoceno: true });
      try { return json({ ok: true, ...(await obnovFotky("automaticky")) }); }
      catch (e) { await ulozNastaveni("fotky_stav", { ...(st || {}), posledni: new Date().toISOString(), chyba: (e as Error).message }); throw e; }
    }
    if (action === "tisk_prihlas") {
      const klic = await tajne("tisk_klic");
      if (!klic || String(p.klic || "") !== klic) { await new Promise((r) => setTimeout(r, 1500)); return json({ error: "Špatný klíč tiskového pomocníka." }, 401); }
      // účet tiskárny: heslo se vygeneruje znovu při každém přihlášení, nikdo ho nezná
      const heslo = crypto.randomUUID() + crypto.randomUUID();
      await zalozUcet(TISKARNA, heslo, "Tiskový pomocník");
      const t = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, { method: "POST",
        headers: { apikey: ANON || SB_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email: TISKARNA, password: heslo }) });
      const d = await t.json();
      if (!t.ok) throw new Error(d?.msg || d?.error_description || "přihlášení tiskárny selhalo");
      return json({ access_token: d.access_token, expires_in: d.expires_in, anon: ANON });
    }

    // --- přihlášený člen ---
    const ja = await clen(req);
    if (!ja) return json({ error: "Nejsi přihlášený (nebo nemáš přístup) – přihlas se znovu." }, 401);
    if (action === "ja") return json({ email: ja.email, jmeno: ja.jmeno, admin: ja.admin });
    if (action === "sync") return json({ ok: true, ...(await syncEshop(ja.jmeno || ja.email)) });
    if (action === "fotky") return json({ ok: true, ...(await obnovFotky(ja.jmeno || ja.email)) });
    if (action === "stav") return json({ eshop: await nastaveni("eshop_stav"), fotky: await nastaveni("fotky_stav"), api: !!(await tajne("eshop_api")) });

    // --- správce ---
    if (!ja.admin) return json({ error: "Tohle smí jen správce appky." }, 403);
    if (action === "api") {
      const url = String(p.url || "").trim();
      if (!/^https:\/\/[^\s]+request\.php\?[^\s]*action=GetOrders/i.test(url)) return json({ error: "Tohle nevypadá jako adresa API e-shopu (…request.php?action=GetOrders…&password=…)." }, 400);
      const r = await fetch(url);
      const j = await r.json().catch(() => null);
      if (!j?.success) return json({ error: "E-shop tuhle adresu odmítl: " + (j?.report || ("HTTP " + r.status)) }, 400);
      await ulozTajne("eshop_api", url);
      return json({ ok: true, objednavek: (j.params?.orderList || []).length });
    }
    if (action === "clenove") return json({ clenove: await db("clenove?select=email,jmeno,admin,pridal,created_at&order=created_at") });
    if (action === "pridat") {
      const email = String(p.email || "").trim().toLowerCase(), heslo = String(p.heslo || ""), jmeno = String(p.jmeno || "").trim();
      if (!platnyEmail(email) || !jmeno) return json({ error: "Vyplň jméno a e-mail." }, 400);
      const uz = (await db(`clenove?select=email&email=eq.${encodeURIComponent(email)}`))?.length;
      if (!uz && !platneHeslo(heslo)) return json({ error: "Heslo musí mít aspoň 8 znaků." }, 400);
      if (heslo) { if (!platneHeslo(heslo)) return json({ error: "Heslo musí mít aspoň 8 znaků." }, 400); await zalozUcet(email, heslo, jmeno); }
      await db("clenove?on_conflict=email", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ email, jmeno, admin: !!p.admin, pridal: ja.jmeno || ja.email }) });
      return json({ ok: true });
    }
    if (action === "heslo") {
      const email = String(p.email || "").trim().toLowerCase(), heslo = String(p.heslo || "");
      if (!platneHeslo(heslo)) return json({ error: "Heslo musí mít aspoň 8 znaků." }, 400);
      const u = await authUzivatel(email);
      if (!u) return json({ error: "Takový účet není." }, 404);
      await auth(`admin/users/${u.id}`, { method: "PUT", body: JSON.stringify({ password: heslo }) });
      return json({ ok: true });
    }
    if (action === "odebrat") {
      const email = String(p.email || "").trim().toLowerCase();
      if (email === ja.email) return json({ error: "Sám sebe odebrat nejde." }, 400);
      await db(`clenove?email=eq.${encodeURIComponent(email)}`, { method: "DELETE" });
      const u = await authUzivatel(email);
      if (u) await auth(`admin/users/${u.id}`, { method: "DELETE" });
      return json({ ok: true });
    }
    return json({ error: "Neznámá akce: " + action }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
