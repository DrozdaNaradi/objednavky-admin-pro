-- ============================================================
-- PPL štítky — doplnění databáze (spustit JEDNOU v Supabase → SQL Editor)
-- Nic nemaže, jen přidává.
-- ============================================================

-- U objednávky se uloží vytvořená PPL zásilka (číslo balíku, dávka, co se poslalo)
alter table public.orders add column if not exists ppl jsonb;

-- Sdílené nastavení aplikace (odesílatel, účet pro dobírky…) — stejné pro všechny uživatele
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}',
  updated_at timestamptz default now()
);
alter table public.app_settings enable row level security;
drop policy if exists "allow all settings" on public.app_settings;
create policy "allow all settings" on public.app_settings for all using (true) with check (true);
grant select, insert, update, delete on table public.app_settings to anon, authenticated;
