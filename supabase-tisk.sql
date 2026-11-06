-- ============================================================
-- Tisková fronta: appka uloží PDF se štítky, Tiskový pomocník na Macu u tiskárny ho vytiskne (100 %, bez okna).
-- Spustit JEDNOU v Supabase → SQL Editor. Nic nemaže, jen přidává.
-- ============================================================
create table if not exists public.tiskarny (
  id text primary key,
  nazev text,
  tiskarna text,
  last_seen timestamptz default now()
);
create table if not exists public.tisk_fronta (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  created_by text,
  nazev text,
  tiskarna_id text,
  pdf text,
  stav text not null default 'ceka',
  chyba text,
  vytisteno_at timestamptz
);
create index if not exists idx_tisk_fronta_ceka on public.tisk_fronta(tiskarna_id, stav);
alter table public.tiskarny enable row level security;
alter table public.tisk_fronta enable row level security;
drop policy if exists "allow all tiskarny" on public.tiskarny;
create policy "allow all tiskarny" on public.tiskarny for all using (true) with check (true);
drop policy if exists "allow all tisk fronta" on public.tisk_fronta;
create policy "allow all tisk fronta" on public.tisk_fronta for all using (true) with check (true);
grant select, insert, update, delete on table public.tiskarny to anon, authenticated;
grant select, insert, update, delete on table public.tisk_fronta to anon, authenticated;
