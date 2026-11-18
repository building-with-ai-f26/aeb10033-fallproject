-- Scrapbook Kitchen: Supabase setup (tables, photo bucket, and lock rules).
-- How to run: Supabase dashboard > SQL Editor > New query > paste this whole file > Run.
-- Safe to run again: it skips things that already exist and replaces the lock rules.
--
-- The lock rules ("Row Level Security") are the main security idea:
-- the database itself refuses to show or change a row unless it belongs to the signed-in person.
-- auth.uid() is the id of whoever's sign-in token came with the request.

-- ---------- Recipes ----------
-- Each recipe is stored whole as JSON in "data" (same shape as the old data/recipes.json),
-- so server.js and search.js barely change. user_id says whose recipe it is.
create table if not exists public.recipes (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists recipes_user_id_idx on public.recipes (user_id);

-- ---------- Chapters you add (built-in chapters stay in server.js) ----------
create table if not exists public.chapters (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 30),
  emoji text not null default '📓',
  created_at timestamptz not null default now()
);
create unique index if not exists chapters_user_name_idx on public.chapters (user_id, lower(name));

-- ---------- AI reads, for the daily limit per account ----------
-- One row each time the AI reads a recipe. There is deliberately no delete rule,
-- so nobody can erase their rows to reset the limit.
create table if not exists public.ai_reads (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists ai_reads_user_time_idx on public.ai_reads (user_id, created_at);

-- ---------- Turn on the locks ----------
alter table public.recipes enable row level security;
alter table public.chapters enable row level security;
alter table public.ai_reads enable row level security;

drop policy if exists "own recipes" on public.recipes;
create policy "own recipes" on public.recipes
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "own chapters" on public.chapters;
create policy "own chapters" on public.chapters
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "read own ai reads" on public.ai_reads;
create policy "read own ai reads" on public.ai_reads
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "add own ai reads" on public.ai_reads;
create policy "add own ai reads" on public.ai_reads
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

-- ---------- Photos: a private bucket, one folder per person ----------
-- Files are saved as <user id>/<file name>. The rules below only allow your own folder.
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

drop policy if exists "own photo folder" on storage.objects;
create policy "own photo folder" on storage.objects
  for all to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
