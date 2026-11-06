-- ============================================================
-- ZABEZPEČENÍ (6. 11. 2026) – spustit JEDNOU v Supabase → SQL Editor, AŽ jsou nasazené funkce objednavky, ppl, fio.
-- Do databáze se pak dostane jen přihlášený člen týmu (tabulka clenove). Veřejný klíč ze stránky sám nic nepřečte
-- ani nezmění. Data nic nemaže.
-- ============================================================

-- Členové týmu: kdo smí do appky. Účty zakládá správce v appce (Nastavení → Uživatelé) přes funkci „objednavky“.
create table if not exists public.clenove (
  email text primary key,
  jmeno text,
  admin boolean not null default false,
  pridal text,
  created_at timestamptz default now()
);
alter table public.clenove enable row level security;

create or replace function public.je_clen() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.clenove where email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;
create or replace function public.je_tiskarna() returns boolean
language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = 'tiskarna@objednavky.local';
$$;
revoke all on function public.je_clen() from public, anon;
grant execute on function public.je_clen() to authenticated;
grant execute on function public.je_tiskarna() to authenticated;

drop policy if exists "clen cte cleny" on public.clenove;
create policy "clen cte cleny" on public.clenove for select to authenticated using (public.je_clen());
revoke all on table public.clenove from anon;
grant select on table public.clenove to authenticated;   -- zapisuje jen funkce „objednavky“ (správce)

-- Číslo objednávky jednou (dřív mohly dva prohlížeče naráz založit duplicitu)
create unique index if not exists orders_order_number_key on public.orders(order_number);

-- ---------- pravidla: všechno jen pro přihlášené členy ----------
do $$
declare t text;
begin
  foreach t in array array['orders','order_notes','order_activity','app_settings','ppl_adresar','ppl_zasilky_mimo'] loop
    execute format('alter table public.%I enable row level security', t);
    execute (select coalesce(string_agg(format('drop policy if exists %I on public.%I;', policyname, t), ' '), 'select 1')
             from pg_policies where schemaname = 'public' and tablename = t);
    execute format('create policy "jen clenove" on public.%I for all to authenticated using (public.je_clen()) with check (public.je_clen())', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', t);
  end loop;
end $$;

-- příchozí platby Fio a mapa fotek: členové jen čtou, zapisují funkce v Supabase
do $$
declare t text;
begin
  foreach t in array array['fio_platby','product_image_cache'] loop
    execute format('alter table public.%I enable row level security', t);
    execute (select coalesce(string_agg(format('drop policy if exists %I on public.%I;', policyname, t), ' '), 'select 1')
             from pg_policies where schemaname = 'public' and tablename = t);
    execute format('create policy "clenove ctou" on public.%I for select to authenticated using (public.je_clen())', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end $$;

-- tisková fronta: členové posílají štítky, Tiskový pomocník (vlastní účet tiskarna@objednavky.local) je tiskne
do $$
declare t text;
begin
  foreach t in array array['tisk_fronta','tiskarny'] loop
    execute format('alter table public.%I enable row level security', t);
    execute (select coalesce(string_agg(format('drop policy if exists %I on public.%I;', policyname, t), ' '), 'select 1')
             from pg_policies where schemaname = 'public' and tablename = t);
    execute format('create policy "clenove a tiskarna" on public.%I for all to authenticated using (public.je_clen() or public.je_tiskarna()) with check (public.je_clen() or public.je_tiskarna())', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', t);
  end loop;
end $$;

-- tajné hodnoty (token Fio, adresa API e-shopu, klíč pomocníka): nikdo z prohlížeče
alter table public.tajne enable row level security;
revoke all on table public.tajne from anon, authenticated;

-- faktury (PDF pro zákazníky): nahrávat smí jen člen; stáhnout dál jde odkazem s náhodným kódem v e-mailu
drop policy if exists "faktury nahrani" on storage.objects;
create policy "faktury nahrani" on storage.objects for insert to authenticated
  with check (bucket_id = 'faktury' and public.je_clen());

-- ---------- automaticky na serveru (prohlížeč už e-shop ani feed fotek nestahuje) ----------
create extension if not exists pg_cron;
create extension if not exists pg_net;
-- objednávky z e-shopu: každých 15 min 6:00–21:00 (zimní čas), funkce sama nepustí víc než 1× za 5 min
select cron.unschedule('eshop-objednavky') where exists (select 1 from cron.job where jobname = 'eshop-objednavky');
select cron.schedule('eshop-objednavky', '*/15 5-20 * * *', $$
  select net.http_post(url := 'https://jihbeduncgspzuamvfbt.supabase.co/functions/v1/objednavky',
    headers := '{"Content-Type":"application/json"}'::jsonb, body := '{"action":"cron"}'::jsonb, timeout_milliseconds := 120000);
$$);
-- mapa fotek z heureka feedu: každou hodinu 6:30–19:30
select cron.unschedule('eshop-fotky') where exists (select 1 from cron.job where jobname = 'eshop-fotky');
select cron.schedule('eshop-fotky', '30 5-18 * * *', $$
  select net.http_post(url := 'https://jihbeduncgspzuamvfbt.supabase.co/functions/v1/objednavky',
    headers := '{"Content-Type":"application/json"}'::jsonb, body := '{"action":"fotky_cron"}'::jsonb, timeout_milliseconds := 150000);
$$);
