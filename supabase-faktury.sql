-- ============================================================
-- Faktury ke stažení z emailu (spustit JEDNOU v Supabase → SQL Editor)
-- Vytvoří úložiště „faktury" (jen PDF, max 10 MB). Soubor má v názvu
-- náhodný kód, takže odkaz zná jen ten, komu přišel email.
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('faktury', 'faktury', true, 10485760, array['application/pdf'])
on conflict (id) do nothing;

drop policy if exists "faktury nahrani" on storage.objects;
create policy "faktury nahrani" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'faktury');
