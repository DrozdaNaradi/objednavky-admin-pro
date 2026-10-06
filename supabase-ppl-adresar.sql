-- ============================================================
-- PPL mimo e-shop: adresář příjemců (export z klient.ppl.cz) a zásilky bez objednávky
-- Spustit JEDNOU v Supabase → SQL Editor. Nic nemaže, jen přidává.
-- ============================================================
create table if not exists public.ppl_adresar (
  id uuid primary key default gen_random_uuid(),
  ppl_id text unique,            -- ZAKAZNIK_ID z exportu PPL
  nazev text, ulice text, mesto text, psc text, zeme text default 'CZ',
  email text, telefon text, kontakt text, poznamka text,
  updated_at timestamptz default now()
);
create table if not exists public.ppl_zasilky_mimo (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  created_by text,
  prijemce jsonb,                -- komu (jak se poslalo)
  ppl jsonb                      -- stejné jako orders.ppl (čísla zásilek, dávka, storno…)
);
alter table public.ppl_adresar enable row level security;
alter table public.ppl_zasilky_mimo enable row level security;
drop policy if exists "allow all adresar" on public.ppl_adresar;
create policy "allow all adresar" on public.ppl_adresar for all using (true) with check (true);
drop policy if exists "allow all zasilky mimo" on public.ppl_zasilky_mimo;
create policy "allow all zasilky mimo" on public.ppl_zasilky_mimo for all using (true) with check (true);
grant select, insert, update, delete on table public.ppl_adresar to anon, authenticated;
grant select, insert, update, delete on table public.ppl_zasilky_mimo to anon, authenticated;
