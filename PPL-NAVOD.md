# PPL štítky — zapojení (jednorázově)

Appka posílá zásilky do PPL přes malou funkci v Supabase (`supabase/functions/ppl/index.ts`).
Klíče od PPL jsou jen v Supabase, do prohlížeče ani na GitHub se nikdy nedostanou.

## 1. Databáze
Supabase → **SQL Editor** → vlož obsah `supabase-ppl.sql` → **Run**.
(Přidá k objednávkám sloupec `ppl` a tabulku `app_settings` pro nastavení odesílatele.)

## 2. Funkce „ppl"
Supabase → **Edge Functions** → **Deploy a new function** → **Via Editor**
- název: `ppl`
- obsah: celý soubor `supabase/functions/ppl/index.ts`
- po nasazení v detailu funkce **vypni „Verify JWT"** (appka používá nový publishable klíč, který není JWT; místo toho chrání funkci PIN).

## 3. Secrets
Supabase → **Edge Functions → Secrets** → přidej:

| Název | Hodnota |
|---|---|
| `PPL_CLIENT_ID` | Client ID od PPL |
| `PPL_CLIENT_SECRET` | Client secret od PPL |
| `PPL_ENV` | `test` (zkoušení, nevznikají skutečné zásilky) → po vyzkoušení `prod` |
| `PPL_APP_PIN` | libovolné heslo, např. 6 číslic |

## 4. V appce
**PPL štítky → ⚙ Nastavení PPL**
- zkontroluj odesílatele (předvyplněno z podpisu e-mailu: Masarykova 1483, Rudná), doplň telefon
- vyplň **účet pro dobírky** (bez něj nejde poslat dobírku)
- zadej **PIN** (stejný jako `PPL_APP_PIN`) → **Otestovat spojení s PPL**

## Jak se tiskne
- **PPL štítky** v horní liště = všechny nové/otevřené PPL objednávky bez štítku, odškrtni co nechceš.
- **PPL štítek** v detailu objednávky = jen ta jedna.
- Každá zásilka jde rozkliknout a upravit (produkt, výdejní místo, dobírka, počet balíků, adresa…).
- Vyber pozici na archu A4 (1–4), kde začít — appka si pamatuje, kde jsi skončil.
- **Odeslat do PPL a tisknout** → otevře se PDF se štítky → tisk na A4.
- V detailu objednávky pak je číslo balíku (odkaz na sledování), „Znovu stáhnout štítek" a „Stornovat".

## Automatické předvyplnění
- doprava s kódem `[KM…]` nebo ParcelShop/ParcelBox → **SMAR** (výdejní místo), s dobírkou **SMAD**
- kurýr → **PRIV** (soukromá osoba) / **BUSS** (firma s IČO), s dobírkou PRID / BUSD — výchozí jde změnit v Nastavení PPL
- dobírka = celková cena zaokrouhlená na celé Kč, VS = číslo objednávky
- telefon se doplní o +420
