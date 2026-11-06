-- ============================================================
-- Platby Fio — doplnění databáze (spustit JEDNOU v Supabase → SQL Editor)
-- Nic nemaže, jen přidává.
-- ============================================================

-- U objednávky stav platby: { stav: zaplaceno|castecne|nezaplaceno, zaplaceno, cena, platby[], overeno, zdroj, rucne?, kdo? }
alter table public.orders add column if not exists platba jsonb;

-- Příchozí platby z Fio (jen příchozí, posledních ~45 dní) – pro ruční kontrolu v appce
create table if not exists public.fio_platby (
  id text primary key,            -- ID pohybu ve Fio
  datum date,
  castka numeric,
  mena text,
  vs text,
  zprava text,
  nazev text,                     -- název protiúčtu (kdo platil)
  objednavka text,                -- spárované číslo objednávky
  created_at timestamptz default now()
);
alter table public.fio_platby enable row level security;
drop policy if exists "read fio platby" on public.fio_platby;
create policy "read fio platby" on public.fio_platby for select using (true);
grant select on table public.fio_platby to anon, authenticated;   -- zapisuje jen funkce „fio"

-- Tajné hodnoty (token Fio). RLS zapnuté a ŽÁDNÉ pravidlo → prohlížeč (anon) nic nepřečte ani nezapíše,
-- jen funkce v Supabase (service role).
create table if not exists public.tajne (
  klic text primary key,
  hodnota text not null,
  zmeneno timestamptz default now()
);
alter table public.tajne enable row level security;
revoke all on table public.tajne from anon, authenticated;

-- Automatické načítání plateb: každou hodinu 6:00–19:00 UTC (= 7:00/8:00–20:00/21:00 u nás), funkce sama
-- nepustí víc než 1× za 10 min. Potřebuje rozšíření pg_cron a pg_net (Database → Extensions).
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('fio-platby') where exists (select 1 from cron.job where jobname = 'fio-platby');
select cron.schedule('fio-platby', '5 6-19 * * *', $$
  select net.http_post(
    url := 'https://jihbeduncgspzuamvfbt.supabase.co/functions/v1/fio',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{"action":"cron"}'::jsonb
  );
$$);
