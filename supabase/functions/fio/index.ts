// Supabase Edge Function „fio" — načte příchozí platby z Fio banky a spáruje je s objednávkami.
// Token od Fio (jen pro čtení – „Pouze sledovat účet") je jen tady v Secrets, prohlížeč ani GitHub ho nikdy nevidí.
//
// Token od Fio se zadává v appce (Nastavení → Platby Fio): appka ho pošle sem (akce „token"), funkce ho ověří u Fio
// a uloží do tabulky „tajne", kterou prohlížeč NEMŮŽE číst (RLS bez pravidel, jen service role). Zpátky se nikdy neposílá.
// Secrets (Supabase → Edge Functions → Secrets):
//   PPL_APP_PIN   – stejný PIN jako pro PPL (appka ho posílá v hlavičce x-app-pin)
//   FIO_TOKEN     – volitelně; když je, má přednost před tokenem z appky
//   (SUPABASE_URL a SUPABASE_SERVICE_ROLE_KEY dává Supabase funkcím sám)
//
// Volání: POST { action }
//   sync  (s PINem)  → načte platby a spáruje (ruční „Načíst platby" v appce)
//   cron  (bez PINu) → totéž pro automatické spouštění; nic nevrací kromě počtů, max 1× za 10 min
//   ping  (s PINem)  → ověří token u Fio
//   token (s PINem) { token } → ověří a uloží token (prázdný = smazat)
//
// Párování: objednávky placené předem na účet (QR / převodem). Platba patří k objednávce, když
// variabilní symbol = číslo objednávky (bez úvodních nul), nebo je číslo objednávky ve zprávě pro příjemce.
// Součet plateb ≥ cena objednávky − 1 Kč → zaplaceno; méně → částečně. Ručně nastavený stav appka nepřepíše.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-app-pin",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DNI = 45;            // kolik dní zpět načítat z Fio (Fio bez silné autorizace max 90)
const OBJ_DNI = 60;        // objednávky za posledních N dní

async function db(path: string, init: RequestInit = {}) {
  const h = new Headers(init.headers);
  h.set("apikey", SB_KEY); h.set("Authorization", `Bearer ${SB_KEY}`);
  if (init.body) h.set("Content-Type", "application/json");
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: h });
  const t = await r.text();
  if (!r.ok) throw new Error(`Databáze (${r.status}): ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

const den = (d: Date) => d.toISOString().slice(0, 10);
const bezNul = (v: unknown) => String(v ?? "").replace(/\D/g, "").replace(/^0+/, "");

function sloupec(tx: Record<string, any>, ...jmena: string[]) {
  // Fio sloupce hledat podle názvu (VS, Objem, Datum…), ne podle čísla – číslování se historicky měnilo
  const w = jmena.map((n) => n.toLowerCase());
  for (const [k, c] of Object.entries(tx)) {
    if (!k.startsWith("column") || !c || typeof c !== "object") continue;
    const n = String((c as any).name || "").toLowerCase();
    if (w.some((x) => n === x || n.includes(x))) return (c as any).value;
  }
  return null;
}

async function tokenFio() {
  const env = Deno.env.get("FIO_TOKEN");
  if (env) return env;
  const r = await db("tajne?select=hodnota&klic=eq.fio_token");
  return r?.[0]?.hodnota || "";
}

async function nactiFio(tokenZkusit?: string) {
  const token = tokenZkusit || await tokenFio();
  if (!token) throw new Error("Není zadaný token Fio – vlož ho v appce v Nastavení → Platby Fio.");
  const to = new Date(), od = new Date(Date.now() - DNI * 864e5);
  const r = await fetch(`https://fioapi.fio.cz/v1/rest/periods/${token}/${den(od)}/${den(to)}/transactions.json`);
  if (r.status === 409) throw new Error("Fio: příliš častý dotaz (limit 1× za 30 s). Zkus to za chvíli.");
  if (r.status === 404 || r.status === 401) throw new Error("Fio: neplatný token.");
  if (!r.ok) throw new Error(`Fio vrátilo chybu ${r.status}.`);
  const d = await r.json();
  const txs = d?.accountStatement?.transactionList?.transaction || [];
  const out = [];
  for (const tx of txs) {
    const castka = Number(sloupec(tx, "objem"));
    if (!(castka > 0)) continue;   // jen příchozí platby
    out.push({
      id: String(sloupec(tx, "id pohybu") ?? ""),
      datum: String(sloupec(tx, "datum") ?? "").slice(0, 10),
      castka,
      mena: String(sloupec(tx, "měna", "mena") ?? "CZK"),
      vs: String(sloupec(tx, "vs") ?? "").trim(),
      zprava: String(sloupec(tx, "zpráva pro příjemce", "zprava") ?? "").trim(),
      nazev: String(sloupec(tx, "název protiúčtu", "nazev protiuctu") ?? sloupec(tx, "provedl") ?? "").trim(),
    });
  }
  return out.filter((p) => p.id);
}

async function sparuj(platby: any[]) {
  const od = new Date(Date.now() - OBJ_DNI * 864e5).toISOString();
  const obj: any[] = await db(`orders?select=id,order_number,total_amount,payment_method,platba&order_date=gte.${od}&payment_method=ilike.*na%20%C3%BA%C4%8Det*`);
  const podleCisla = new Map(obj.map((o) => [bezNul(o.order_number), o]));
  const kObj = new Map<string, any[]>();
  for (const p of platby) {
    let o = p.vs ? podleCisla.get(bezNul(p.vs)) : undefined;
    if (!o) {   // číslo objednávky ve zprávě pro příjemce
      for (const [cislo, oo] of podleCisla) if (cislo.length >= 6 && bezNul(p.zprava).includes(cislo)) { o = oo; break; }
    }
    p.objednavka = o ? o.order_number : null;
    if (o) { if (!kObj.has(o.id)) kObj.set(o.id, []); kObj.get(o.id)!.push(p); }
  }
  let zmeneno = 0;
  const ted = new Date().toISOString();
  for (const o of obj) {
    if (o.platba?.rucne) continue;   // ručně nastavený stav nepřepisovat
    const pl = kObj.get(o.id) || [];
    const suma = Math.round(pl.reduce((a, p) => a + p.castka, 0) * 100) / 100;
    const cena = Number(o.total_amount || 0);
    const stav = !pl.length ? "nezaplaceno" : (suma >= cena - 1 ? "zaplaceno" : "castecne");
    const nova = { stav, zaplaceno: suma, cena, overeno: ted, zdroj: "fio",
      platby: pl.map((p) => ({ id: p.id, datum: p.datum, castka: p.castka, nazev: p.nazev })) };
    const stara = o.platba || {};
    if (stara.stav !== nova.stav || stara.zaplaceno !== nova.zaplaceno || !stara.overeno || Date.now() - new Date(stara.overeno).getTime() > 3 * 3600e3) {
      await db(`orders?id=eq.${o.id}`, { method: "PATCH", body: JSON.stringify({ platba: nova }) });
      if (stara.stav !== nova.stav) zmeneno++;
    }
  }
  return { objednavek: obj.length, zmeneno };
}

async function ulozStav(s: Record<string, unknown>) {
  await db("app_settings?on_conflict=key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: "fio_stav", value: s, updated_at: new Date().toISOString() }) });
}

async function synchronizuj(kdo: string, uzNactene?: any[]) {
  try {
    const platby = uzNactene || await nactiFio();   // Fio pustí jen 1 dotaz za 30 s → už načtené znovu nestahovat
    const p = await sparuj(platby);
    // příchozí platby (jen ty) – pro ruční kontrolu v appce
    if (platby.length) await db("fio_platby?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(platby) });
    const s = { token: true, posledni: new Date().toISOString(), kdo, plateb: platby.length, sparovano: platby.filter((x) => x.objednavka).length, ...p, chyba: null };
    await ulozStav(s);
    return s;
  } catch (e) {
    const s = { posledni: new Date().toISOString(), kdo, chyba: (e as Error).message };
    try { await ulozStav(s); } catch { /* */ }
    throw e;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const p = await req.json().catch(() => ({}));
    const action = String(p.action || "");
    if (action === "cron") {
      // automatické spouštění bez PINu: jen počty, a ne častěji než 1× za 10 minut
      const st = await db("app_settings?select=value&key=eq.fio_stav");
      const posl = st?.[0]?.value?.posledni;
      if (posl && Date.now() - new Date(posl).getTime() < 10 * 60e3) return json({ ok: true, preskoceno: true });
      const s = await synchronizuj("automaticky");
      return json({ ok: true, plateb: s.plateb, sparovano: s.sparovano });
    }
    const pin = Deno.env.get("PPL_APP_PIN");
    if (!pin) return json({ error: "Chybí PPL_APP_PIN v Supabase Secrets." }, 500);
    if (req.headers.get("x-app-pin") !== pin) return json({ error: "Špatný PIN (Nastavení → PPL štítky)." }, 401);
    if (action === "ping") { const pl = await nactiFio(); return json({ ok: true, plateb: pl.length }); }
    if (action === "token") {
      const t = String(p.token || "").trim();
      if (!t) { await db("tajne?klic=eq.fio_token", { method: "DELETE" }); await ulozStav({ token: false, chyba: null }); return json({ ok: true, smazano: true }); }
      if (!/^[A-Za-z0-9]{20,100}$/.test(t)) return json({ error: "Tohle nevypadá jako token Fio (jen písmena a číslice, desítky znaků)." }, 400);
      const pl = await nactiFio(t);   // ověřit u Fio dřív, než se uloží
      await db("tajne?on_conflict=klic", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ klic: "fio_token", hodnota: t, zmeneno: new Date().toISOString() }) });
      const s = await synchronizuj("po zadání tokenu", pl).catch((e) => ({ chyba: (e as Error).message }));
      return json({ ok: true, plateb: pl.length, ...s });
    }
    if (action === "sync") return json({ ok: true, ...(await synchronizuj(String(p.kdo || "ručně"))) });
    return json({ error: "Neznámá akce: " + action }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 500);
  }
});
