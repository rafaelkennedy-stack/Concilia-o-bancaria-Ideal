-- Fila diária de conciliação: status por conta bancária por dia.
-- A fila reinicia automaticamente a cada novo dia porque as linhas são
-- chaveadas por (account_id, date); um novo dia simplesmente não tem linhas,
-- então todas as contas voltam para "pendente".

create type public.daily_status as enum (
  'pendente', 'em_andamento', 'conciliada', 'sem_movimento', 'adiada'
);

create table public.daily_account_status (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.bank_accounts(id) on delete cascade,
  date date not null default current_date,
  status public.daily_status not null default 'pendente',
  no_movement_reason text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, date)
);
create index on public.daily_account_status(date);

grant select, insert, update, delete on public.daily_account_status to authenticated;
grant all on public.daily_account_status to service_role;
alter table public.daily_account_status enable row level security;

create policy "auth read daily status" on public.daily_account_status
  for select to authenticated using (true);
create policy "auth insert daily status" on public.daily_account_status
  for insert to authenticated with check (auth.uid() = created_by);
create policy "auth update daily status" on public.daily_account_status
  for update to authenticated using (true) with check (true);
create policy "auth delete daily status" on public.daily_account_status
  for delete to authenticated using (true);
