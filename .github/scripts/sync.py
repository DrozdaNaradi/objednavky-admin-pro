#!/usr/bin/env python3
"""Sync objednávek z eshopu do Supabase — spouští GitHub Actions každý den v 6:00."""

import json, sys, re, urllib.request, urllib.error
from datetime import datetime, timezone

SUPABASE_URL = 'https://jihbeduncgspzuamvfbt.supabase.co'
SUPABASE_KEY = 'sb_publishable_hsx9W9DmppixFce-mSrrEA_cPM9hkKc'
ESHOP_API   = 'https://www.drozda-naradi.cz/request.php?action=GetOrders&version=v2.0&password=0b32cf860ef67dc19fa0fce62d18c962'

def fetch(url, method='GET', data=None, extra_headers=None):
    headers = {'Content-Type': 'application/json'}
    if extra_headers:
        headers.update(extra_headers)
    body = json.dumps(data).encode() if data is not None else None
    req  = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def sb(method, path, body=None):
    headers = {
        'apikey':        SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
    }
    if method == 'POST':
        headers['Prefer'] = 'resolution=merge-duplicates,return=minimal'
    elif method in ('PATCH', 'GET'):
        headers['Prefer'] = 'return=minimal'
    return fetch(SUPABASE_URL + '/rest/v1' + path, method, body, headers)

def parse_date(raw):
    try:
        return datetime.fromisoformat(raw.replace(' ', 'T')).replace(tzinfo=timezone.utc).isoformat()
    except Exception:
        return datetime.now(timezone.utc).isoformat()

def flt(v, default=0.0):
    try: return float(v or default)
    except: return default

def main():
    print('▸ Stahuji objednávky z eshopu...')
    status, text = fetch(ESHOP_API)
    print(f'  Eshop API status: {status}')
    try:
        data = json.loads(text)
    except Exception as e:
        print(f'❌ Nelze parsovat odpověď eshopu: {e}')
        print(f'  Odpověď (prvních 300 znaků): {text[:300]}')
        sys.exit(1)

    if not data.get('success'):
        print('❌ Eshop API vrátil chybu:', data.get('report'))
        sys.exit(1)

    order_list = data.get('params', {}).get('orderList', [])
    print(f'  Nalezeno objednávek: {len(order_list)}')

    imported = updated = 0

    for o in order_list:
        num = str(o.get('number') or o.get('id_order') or '')
        if not num:
            continue

        c = o.get('customer', {}).get('delivery_information') or {}
        b = (o.get('customer', {}).get('billing_information')
             or o.get('customer', {}).get('invoice_information') or {})

        # Produkty
        items = []
        for p in o.get('row_list', []):
            items.append({
                'name':              p.get('product_name', ''),
                'sku':               str(p.get('product_number', '')),
                'qty':               int(p.get('count') or 1),
                'price_with_vat':    flt(p.get('price_per_unit_with_vat')),
                'price_without_vat': flt(p.get('price_per_unit')),
                'total_with_vat':    flt(p.get('price_total_with_vat')),
                'img':               '',
                'availability':      p.get('availability'),
                'availability_text': str(p.get('availabilityText') or ''),
            })

        # Doprava + platba
        ship_vat    = flt(o.get('delivery', {}).get('postovne'))
        ship_no_vat = flt(o.get('delivery', {}).get('postovne_bez_dph')) or (round(ship_vat / 1.21 * 100) / 100 if ship_vat else 0)
        pay_vat     = flt(o.get('payment', {}).get('castka_platba'))
        pay_no_vat  = flt(o.get('payment', {}).get('castka_platba_bez_dph')) or (round(pay_vat / 1.21 * 100) / 100 if pay_vat else 0)

        if 'nazev_postovne' in o.get('delivery', {}):
            items.append({'type': 'shipping', 'name': o['delivery'].get('nazev_postovne') or 'Doprava',
                          'price_with_vat': ship_vat, 'price_without_vat': ship_no_vat, 'qty': 1})
        if 'nazev_platba' in o.get('payment', {}):
            items.append({'type': 'payment',  'name': o['payment'].get('nazev_platba') or 'Platba',
                          'price_with_vat': pay_vat,  'price_without_vat': pay_no_vat,  'qty': 1})

        city = re.sub(r'\s*\[.*?\]', '', c.get('city') or '').strip()
        ico  = c.get('ico') or b.get('ico') or ''
        dic  = c.get('dic') or b.get('dic') or ''
        company_name  = c.get('company') or b.get('company') or ''
        company_parts = [x for x in [company_name,
                                      'IČO:' + ico if ico else '',
                                      'DIČ:' + dic if dic else ''] if x]

        total = (flt(o.get('total', {}).get('price_with_vat')) + ship_vat + pay_vat) or None

        row = {
            'order_number':    num,
            'customer_name':   c.get('name')  or b.get('name')  or '',
            'customer_email':  c.get('email') or b.get('email') or '',
            'customer_phone':  c.get('phone') or b.get('phone') or '',
            'company':         '|'.join(company_parts),
            'delivery_address': ', '.join(filter(None, [c.get('street'), city, c.get('zip')])),
            'shipping_method': o.get('delivery', {}).get('nazev_postovne') or '',
            'payment_method':  o.get('payment',  {}).get('nazev_platba')  or '',
            'total_amount':    total,
            'order_date':      parse_date(o.get('created', {}).get('date') or ''),
            'items':           items,
        }

        # Existuje objednávka?
        s, body = sb('GET', f'/orders?order_number=eq.{num}&select=id')
        try:
            existing = json.loads(body) if body else []
        except Exception:
            existing = []

        if existing:
            sb('PATCH', f'/orders?order_number=eq.{num}', row)
            updated += 1
        else:
            sb('POST', '/orders', {**row, 'status': 'new'})
            imported += 1

    print(f'✅ Hotovo: {imported} nových, {updated} aktualizováno')

if __name__ == '__main__':
    main()
