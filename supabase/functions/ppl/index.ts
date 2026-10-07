// Supabase Edge Function „ppl" — prostředník mezi Objednávky Admin Pro a PPL CPL API (myAPI2).
// Client ID/secret od PPL zůstávají jen tady na serveru, prohlížeč je nikdy nevidí.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   PPL_CLIENT_ID      – od PPL
//   PPL_CLIENT_SECRET  – od PPL
//   PPL_ENV            – "test" (api-dev.dhl.com) nebo "prod" (api.dhl.com), výchozí "test"
//   PPL_APP_PIN        – libovolné heslo; aplikace ho posílá v hlavičce x-app-pin
//
// Volání: POST { action, ... }
//   ping                         → ověří přihlášení k PPL
//   create   { body }            → POST /shipment/batch, vrátí { batchId }
//   status   { batchId }         → GET /shipment/batch/{batchId}
//   label    { batchId, position } → PDF A4 (4 štítky na stranu) jako base64
//   cancel   { shipmentNumber }  → storno balíku (jen dokud nebyl předán PPL)
//   codelist { name }            → číselník (product, service, country…)
//   track    { numbers: [] }     → stav zásilek u PPL (sledování), max 200 čísel
//   whisper  { street, city, zip } → našeptávač a ověření adresy (PPL addressWhisper)

const ENV = (Deno.env.get("PPL_ENV") || "test").toLowerCase() === "prod" ? "prod" : "test";
const BASE = ENV === "prod"
  ? "https://api.dhl.com/ecs/ppl/myapi2"
  : "https://api-dev.dhl.com/ecs/ppl/myapi2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-app-pin",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

let token: { value: string; exp: number } | null = null;

async function getToken(): Promise<string> {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const id = Deno.env.get("PPL_CLIENT_ID");
  const secret = Deno.env.get("PPL_CLIENT_SECRET");
  if (!id || !secret) throw new Error("Chybí PPL_CLIENT_ID / PPL_CLIENT_SECRET v Supabase Secrets.");
  const r = await fetch(`${BASE}/login/getAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret, scope: "myapi2" }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`PPL přihlášení selhalo (HTTP ${r.status}): ${t.slice(0, 300)}`);
  const d = JSON.parse(t);
  token = { value: d.access_token, exp: Date.now() + (Number(d.expires_in) || 1800) * 1000 };
  return token.value;
}

async function ppl(path: string, init: RequestInit = {}) {
  const h = new Headers(init.headers);
  h.set("Authorization", `Bearer ${await getToken()}`);
  if (init.body && !h.has("Content-Type")) h.set("Content-Type", "application/json");
  h.set("Accept-Language", "cs");
  return fetch(path.startsWith("http") ? path : BASE + path, { ...init, headers: h });
}

async function readBody(r: Response) {
  const t = await r.text();
  try { return t ? JSON.parse(t) : null; } catch { return t; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const pin = Deno.env.get("PPL_APP_PIN");
    if (!pin) return json({ error: "Chybí PPL_APP_PIN v Supabase Secrets." }, 500);
    if (req.headers.get("x-app-pin") !== pin) return json({ error: "Špatný PIN pro PPL (Nastavení PPL v aplikaci)." }, 401);

    const p = await req.json().catch(() => ({}));
    const action = String(p.action || "");

    if (action === "ping") {
      await getToken();
      return json({ ok: true, env: ENV });
    }

    if (action === "create") {
      const r = await ppl("/shipment/batch", { method: "POST", body: JSON.stringify(p.body) });
      if (!r.ok) return json({ error: `PPL odmítlo zásilku (HTTP ${r.status})`, detail: await readBody(r), env: ENV }, 400);
      const loc = r.headers.get("Location") || r.headers.get("location") || "";
      const batchId = loc.split("/").filter(Boolean).pop() || "";
      if (!batchId) return json({ error: "PPL nevrátilo číslo dávky (Location).", detail: await readBody(r) }, 502);
      return json({ batchId, env: ENV });
    }

    if (action === "status") {
      const id = encodeURIComponent(String(p.batchId || ""));
      const r = await ppl(`/shipment/batch/${id}`);
      const d = await readBody(r);
      if (!r.ok) return json({ error: `Stav dávky nejde načíst (HTTP ${r.status})`, detail: d }, 400);
      return json({ ...d, env: ENV });
    }

    if (action === "label") {
      const id = encodeURIComponent(String(p.batchId || ""));
      const pos = Math.min(4, Math.max(1, parseInt(p.position) || 1));
      const r = await ppl(`/shipment/batch/${id}/label?pageSize=A4&position=${pos}&limit=200&offset=0`, {
        headers: { Accept: "application/pdf" },
      });
      if (!r.ok) return json({ error: `Štítek nejde stáhnout (HTTP ${r.status})`, detail: await readBody(r) }, 400);
      const buf = new Uint8Array(await r.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return json({ pdf: btoa(bin), contentType: r.headers.get("Content-Type") || "application/pdf" });
    }

    if (action === "cancel") {
      const n = encodeURIComponent(String(p.shipmentNumber || ""));
      const r = await ppl(`/shipment/${n}/cancel`, { method: "POST" });
      if (!r.ok) return json({ error: `Storno se nepovedlo (HTTP ${r.status})`, detail: await readBody(r) }, 400);
      return json({ ok: true });
    }

    if (action === "track") {
      const nums = (Array.isArray(p.numbers) ? p.numbers : []).map(String).filter((n) => /^\d{5,20}$/.test(n)).slice(0, 200);
      const items: unknown[] = [];
      for (let i = 0; i < nums.length; i += 50) {
        const q = nums.slice(i, i + 50).map((n) => "ShipmentNumbers=" + n).join("&");
        const r = await ppl(`/shipment?${q}&limit=100&offset=0`);
        const d = await readBody(r);
        if (!r.ok) return json({ error: `Stav zásilek nejde načíst (HTTP ${r.status})`, detail: d }, 400);
        if (Array.isArray(d)) items.push(...d);
      }
      return json({ items, env: ENV });
    }

    if (action === "whisper") {
      const q = new URLSearchParams();
      if (p.street) q.set("Street", String(p.street).slice(0, 100));
      if (p.city) q.set("City", String(p.city).slice(0, 50));
      if (p.zip) q.set("ZipCode", String(p.zip).replace(/\s/g, "").slice(0, 10));
      const r = await ppl(`/addressWhisper?${q}`);
      const d = await readBody(r);
      if (!r.ok) return json({ error: `Našeptávač adres nefunguje (HTTP ${r.status})`, detail: d }, 400);
      return json({ items: Array.isArray(d) ? d.slice(0, 10) : [] });
    }

    if (action === "codelist") {
      const name = String(p.name || "product").replace(/[^a-zA-Z]/g, "");
      const r = await ppl(`/codelist/${name}?limit=200&offset=0`);
      return json({ items: await readBody(r) }, r.ok ? 200 : 400);
    }

    return json({ error: "Neznámá akce: " + action }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || String(e), env: ENV }, 500);
  }
});
