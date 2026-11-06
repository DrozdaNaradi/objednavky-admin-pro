#!/usr/bin/env python3
"""Tiskový pomocník – tiskne štítky PPL z appky Objednávky Admin Pro rovnou na tiskárnu tohoto Macu
(100 %, A4, bez tiskového okna prohlížeče).

Jak to funguje: appka uloží PDF do tiskové fronty v Supabase (tabulka tisk_fronta) a určí,
která tiskárna ho má vytisknout. Pomocník se každé 2 s podívá do fronty, co je pro něj,
vytiskne to výchozí tiskárnou Macu a ve frontě to označí jako vytištěné.
Každých 30 s se ozve do tabulky tiskarny („jsem online, moje tiskárna je …“),
aby appka věděla, kam může tisknout. Běží na pozadí přes launchd.
"""
import base64, json, re, socket, subprocess, time, urllib.request
from datetime import datetime, timezone
from pathlib import Path

URL = 'https://jihbeduncgspzuamvfbt.supabase.co/rest/v1'
KEY = 'sb_publishable_hsx9W9DmppixFce-mSrrEA_cPM9hkKc'   # veřejný klíč appky (stejný jako v prohlížeči)
DIR = Path.home() / 'tiskovy-pomocnik'
TISK = DIR / 'tisk'
LOG = DIR / 'pomocnik.log'
ID = re.sub(r'[^\w-]+', '-', socket.gethostname().split('.')[0]).strip('-').lower() or 'mac'


def log(t):
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(f'{datetime.now():%Y-%m-%d %H:%M:%S}  {t}\n')


def api(method, path, data=None, prefer=None):
    h = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'}
    if prefer:
        h['Prefer'] = prefer
    req = urllib.request.Request(URL + path, data=json.dumps(data).encode() if data is not None else None, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=20) as r:
        b = r.read()
        return json.loads(b) if b else None


def vychozi_tiskarna():
    r = subprocess.run(['lpstat', '-d'], capture_output=True, text=True)
    return (r.stdout.split(':', 1)[-1].strip() if ':' in r.stdout else '') or None


def nazev_macu():
    r = subprocess.run(['scutil', '--get', 'ComputerName'], capture_output=True, text=True)
    return r.stdout.strip() or ID


def ozvi_se():
    api('POST', '/tiskarny?on_conflict=id', {'id': ID, 'nazev': nazev_macu(), 'tiskarna': vychozi_tiskarna(),
                                             'last_seen': datetime.now(timezone.utc).isoformat()},
        prefer='resolution=merge-duplicates,return=minimal')


# Hlášení tiskárny (lpstat -l -p → „Alerts:“), kvůli kterým tisk stojí. 6. 11. 2026: došel papír, fronta stála od 5. 11. 8:23,
# pomocník přitom hlásil „vytištěno“ a do fronty Macu se nahromadilo 23 štítků – po doplnění papíru vyjely všechny.
PORUCHY = {'media-empty': 'došel papír', 'media-needed': 'došel papír', 'media-jam': 'zaseknutý papír', 'jam': 'zaseknutý papír',
           'door-open': 'otevřená dvířka', 'cover-open': 'otevřený kryt', 'toner-empty': 'došel toner',
           'marker-supply-empty': 'došel toner', 'input-tray-missing': 'chybí zásobník papíru', 'offline': 'tiskárna je vypnutá nebo offline',
           'paused': 'tisk je na Macu pozastavený'}
STOJI_PO = 180   # úloha ve frontě Macu déle než 3 min = tiskárna netiskne


def _cups(tiskarna):
    """(porucha | None, [úlohy ve frontě Macu: (id, čas odeslání)])"""
    r = subprocess.run(['lpstat', '-l', '-p', tiskarna], capture_output=True, text=True)
    t = r.stdout
    porucha = None
    m = re.search(r'Alerts:\s*(.*)', t)
    alerts = m.group(1) if m else ''
    for klic, popis in PORUCHY.items():
        if re.search(rf'(?<![\w-]){klic}(?:-error|-report)?(?![\w-])', alerts):
            porucha = popis
            break
    if 'disabled' in t.split('\n', 1)[0]:
        porucha = porucha or 'tiskárna je na Macu zastavená'
    q = subprocess.run(['lpstat', '-o', tiskarna], capture_output=True, text=True).stdout
    ulohy = []
    for radek in q.splitlines():
        m = re.match(r'(\S+-\d+)\s+\S+\s+\d+\s+(.+)$', radek)
        if m:
            try:
                kdy = datetime.strptime(m.group(2).strip(), '%a %b %d %H:%M:%S %Y').timestamp()
            except ValueError:
                kdy = time.time()
            ulohy.append((m.group(1), kdy))
    return porucha, ulohy


def stav_tiskarny(tiskarna):
    """Text poruchy, když tiskárna teď netiskne (došel papír, fronta stojí…), jinak None."""
    porucha, ulohy = _cups(tiskarna)
    nejstarsi = min((k for _, k in ulohy), default=None)
    if nejstarsi and time.time() - nejstarsi > STOJI_PO:
        od = datetime.fromtimestamp(nejstarsi)
        return f'{porucha or "tiskárna netiskne"} – ve frontě Macu čeká úloh: {len(ulohy)}, nejstarší od {od:%d. %m. %H:%M}'
    return porucha


def vytiskni(job):
    tiskarna = vychozi_tiskarna()
    if not tiskarna:
        raise RuntimeError('Mac nemá nastavenou výchozí tiskárnu (Nastavení systému → Tiskárny).')
    porucha = stav_tiskarny(tiskarna)
    if porucha:   # nic dalšího do zaseknuté fronty – appka hned uvidí proč
        raise RuntimeError(f'Tiskárna {tiskarna.replace("_", " ")}: {porucha}. Oprav to u tiskárny a dej tisk znovu.')
    pdf = base64.b64decode(job.get('pdf') or '')
    if not pdf.startswith(b'%PDF'):
        raise RuntimeError('ve frontě není platné PDF')
    TISK.mkdir(parents=True, exist_ok=True)
    for old in TISK.glob('*.pdf'):   # staré soubory po 7 dnech pryč
        if time.time() - old.stat().st_mtime > 7 * 86400:
            old.unlink(missing_ok=True)
    nazev = re.sub(r'[^\w.-]+', '_', str(job.get('nazev') or 'stitky'))[:60]
    f = TISK / f'{datetime.now():%Y%m%d-%H%M%S}-{nazev}.pdf'
    f.write_bytes(pdf)
    # 100 % – žádné zmenšení ani „přizpůsobit stránce“, A4
    volby = ['-o', 'media=A4', '-o', 'print-scaling=none', '-o', 'fit-to-page=false']
    if na_sirku(pdf):   # PPL posílá arch 4 štítků NA ŠÍŘKU (842×595) – bez otočení tiskárna uřízne pravou polovinu
        volby += ['-o', 'orientation-requested=4']
    r = subprocess.run(['lp', *volby, str(f)], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError('tiskárna odmítla tisk: ' + r.stderr.strip())
    m = re.search(r'request id is (\S+)', r.stdout)
    cups_id = m.group(1) if m else None
    # počkat, až tiskárna úlohu opravdu převezme (appka čeká 30 s) – „vytištěno“ se hlásí, až když úloha z fronty Macu zmizí
    for _ in range(9):
        time.sleep(2)
        porucha, ulohy = _cups(tiskarna)
        if not cups_id or cups_id not in [u for u, _ in ulohy]:
            return tiskarna, r.stdout.strip()
        if porucha:   # tiskárna se zasekla – úlohu zrušit, ať po opravě nevyjede nečekaně (štítek se dá vytisknout znovu)
            subprocess.run(['cancel', cups_id], capture_output=True)
            raise RuntimeError(f'Tiskárna {tiskarna.replace("_", " ")}: {porucha}. Štítek se nevytiskl – oprav to u tiskárny a dej tisk znovu.')
    return tiskarna, r.stdout.strip() + ' (tiskárna ještě tiskne)'


def na_sirku(pdf):
    """Je první stránka PDF na šířku? (MediaBox širší než vyšší; /Rotate 90/270 to otočí)"""
    m = re.search(rb'/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]', pdf)
    if not m:
        return False
    x0, y0, x1, y1 = (float(v) for v in m.groups())
    sirka = abs(x1 - x0) > abs(y1 - y0)
    rot = re.search(rb'/Rotate\s+(\d+)', pdf)
    if rot and int(rot.group(1)) % 180 == 90:
        sirka = not sirka
    return sirka


def kolo():
    jobs = api('GET', f'/tisk_fronta?tiskarna_id=eq.{ID}&stav=eq.ceka&order=created_at&limit=5&select=id,nazev,pdf,created_by')
    for job in jobs or []:
        # zabrat úlohu (ať ji nevytiskne dvakrát)
        claimed = api('PATCH', f'/tisk_fronta?id=eq.{job["id"]}&stav=eq.ceka', {'stav': 'tiskne'}, prefer='return=representation')
        if not claimed:
            continue
        try:
            tiskarna, out = vytiskni(job)
        except Exception as e:
            api('PATCH', f'/tisk_fronta?id=eq.{job["id"]}&stav=eq.tiskne', {'stav': 'chyba', 'chyba': str(e)[:500]})
            log(f'CHYBA „{job.get("nazev")}“: {e}')
            continue
        log(f'vytištěno „{job.get("nazev")}“ ({job.get("created_by")}) → {tiskarna} {out}')
        for pokus in range(3):   # vytištěno je – hlášení do appky zkusit znovu, nikdy ho nepřepsat na „chyba“ (jinak by kolega tiskl podruhé)
            try:
                api('PATCH', f'/tisk_fronta?id=eq.{job["id"]}', {'stav': 'vytisteno', 'pdf': None, 'chyba': None,
                                                                 'vytisteno_at': datetime.now(timezone.utc).isoformat()})
                break
            except Exception as e:
                log(f'hlášení „vytištěno“ se nepovedlo ({e}), zkouším znovu')
                time.sleep(2)


if __name__ == '__main__':
    DIR.mkdir(parents=True, exist_ok=True)
    log(f'start – tiskárna {ID} ({vychozi_tiskarna()})')
    posledni = 0
    while True:
        try:
            if time.time() - posledni > 30:
                ozvi_se()
                posledni = time.time()
            kolo()
        except Exception as e:
            log(f'spojení: {e}')
            time.sleep(10)
        time.sleep(2)
