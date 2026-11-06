#!/usr/bin/env python3
"""Mapa fotek produktů (ITEM_ID → IMGURL z heureka feedu e-shopu) do Supabase – spouští GitHub Actions každou hodinu přes den.

Proč tady: prohlížeč feed přímo stáhnout nesmí (CORS) a veřejné proxy (corsproxy.io, allorigins) od 11/2026 nefungují,
takže se sdílená mapa fotek od 30. 10. neobnovovala a nové produkty v objednávkách by neměly fotku.
Pojistka jako v appce: nová data se jen PŘIDAJÍ ke stávající mapě, useknutý feed (< 1000 nebo < 50 % staré mapy) se neuloží.
"""
import json, sys, urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

SUPABASE_URL = 'https://jihbeduncgspzuamvfbt.supabase.co'
SUPABASE_KEY = 'sb_publishable_hsx9W9DmppixFce-mSrrEA_cPM9hkKc'
FEED_URL = 'https://www.drozda-naradi.cz/fotky92438/xml/heureka_cz.xml'
H = {'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json'}


def sb(method, path, body=None, prefer=None):
    h = dict(H, **({'Prefer': prefer} if prefer else {}))
    req = urllib.request.Request(SUPABASE_URL + '/rest/v1' + path, method=method, headers=h,
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=60) as r:
        b = r.read()
        return json.loads(b) if b else None


def main():
    nova = {}
    with urllib.request.urlopen(urllib.request.Request(FEED_URL, headers={'User-Agent': 'objednavky-admin-pro'}), timeout=120) as r:
        for _, el in ET.iterparse(r):
            if el.tag == 'SHOPITEM':
                i, img = (el.findtext('ITEM_ID') or '').strip(), (el.findtext('IMGURL') or '').strip()
                if i and img:
                    nova[i] = img
                el.clear()
    stara = (sb('GET', '/product_image_cache?id=eq.main&select=map') or [{}])[0].get('map') or {}
    print(f'Feed: {len(nova)} produktů s fotkou, sdílená mapa: {len(stara)}')
    if len(nova) < 1000 or (stara and len(nova) < len(stara) * 0.5):
        print('Feed vypadá useknutý – mapu nepřepisuji.')
        sys.exit(1)
    mapa = {**stara, **nova}
    sb('POST', '/product_image_cache?on_conflict=id', {'id': 'main', 'map': mapa, 'updated_at': datetime.now(timezone.utc).isoformat()},
       prefer='resolution=merge-duplicates,return=minimal')
    print(f'Uloženo: {len(mapa)} fotek (nových {len(set(nova) - set(stara))})')


if __name__ == '__main__':
    main()
