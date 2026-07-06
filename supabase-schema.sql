create table if not exists public.onix_finance_state (
    user_id text primary key,
    payload jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
);

alter table public.onix_finance_state enable row level security;

drop policy if exists "onix finance anon read" on public.onix_finance_state;
drop policy if exists "onix finance anon all" on public.onix_finance_state;
drop policy if exists "onix finance own read" on public.onix_finance_state;
drop policy if exists "onix finance own insert" on public.onix_finance_state;
drop policy if exists "onix finance own update" on public.onix_finance_state;
drop policy if exists "onix finance own delete" on public.onix_finance_state;

create policy "onix finance own read"
on public.onix_finance_state
for select
to authenticated
using (auth.uid()::text = user_id);

create policy "onix finance own insert"
on public.onix_finance_state
for insert
to authenticated
with check (auth.uid()::text = user_id);

create policy "onix finance own update"
on public.onix_finance_state
for update
to authenticated
using (auth.uid()::text = user_id)
with check (auth.uid()::text = user_id);

create policy "onix finance own delete"
on public.onix_finance_state
for delete
to authenticated
using (auth.uid()::text = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'avatars',
    'avatars',
    true,
    3145728,
    array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "onix avatar public read" on storage.objects;
drop policy if exists "onix avatar own insert" on storage.objects;
drop policy if exists "onix avatar own update" on storage.objects;
drop policy if exists "onix avatar own delete" on storage.objects;

create policy "onix avatar public read"
on storage.objects
for select
to public
using (bucket_id = 'avatars');

create policy "onix avatar own insert"
on storage.objects
for insert
to authenticated
with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "onix avatar own update"
on storage.objects
for update
to authenticated
using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "onix avatar own delete"
on storage.objects
for delete
to authenticated
using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
);
