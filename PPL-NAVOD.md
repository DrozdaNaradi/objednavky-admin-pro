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
**PPL štítky → Nastavení** (odkaz vpravo nahoře v okně)
- zkontroluj odesílatele (předvyplněno z podpisu e-mailu: Masarykova 1483, Rudná), doplň telefon
- vyplň **účet pro dobírky** (bez něj nejde poslat dobírku)
- zadej **PIN** (stejný jako `PPL_APP_PIN`) → **Otestovat spojení s PPL**

## Jak se tiskne (3 kroky v jednom okně)
- Otevři **PPL štítky** v horní liště (všechny čekající PPL objednávky) nebo **Tisk štítku PPL** v detailu objednávky.
- Pokud něco chybí v nastavení (PIN, účet pro dobírky…), je to žlutě nahoře i s tlačítkem, kde to doplnit.
- **1 Zkontroluj zásilky** – zaškrtnuté se vytisknou; zelené „✓ Připraveno", červené „⚠ Doplnit: …". Kliknutím na řádek se otevře úprava: jak doručit, dobírka ano/ne, počet balíků (− / +), příjemce, další možnosti.
- **2 Kam na arch A4?** – obrázek archu: šedé = už použité místo, modré = sem přijde štítek (se jménem). Klikni na první volné místo.
- **3 Tisk** – tlačítko řekne, kolik štítků vznikne; když nejde stisknout, pod ním je napsané proč. Po potvrzení se otevře PDF → tisk. Kdyby se okno neotevřelo, je tam „Otevřít štítky znovu".
- V detailu objednávky pak je číslo balíku (odkaz na sledování), „Znovu stáhnout štítek" a „Stornovat".

## Automatické předvyplnění
- doprava s kódem `[KM…]` nebo ParcelShop/ParcelBox → **SMAR** (výdejní místo), s dobírkou **SMAD**
- kurýr → **PRIV** (soukromá osoba) / **BUSS** (firma s IČO), s dobírkou PRID / BUSD — výchozí jde změnit v Nastavení PPL
- dobírka = celková cena zaokrouhlená na celé Kč, VS = číslo objednávky
- telefon se doplní o +420
