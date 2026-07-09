
-- Roles
create type public.app_role as enum ('dani', 'diretor');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  created_at timestamptz not null default now()
);
grant select, insert, update on public.profiles to authenticated;
grant all on public.profiles to service_role;
alter table public.profiles enable row level security;
create policy "profiles readable by authenticated" on public.profiles for select to authenticated using (true);
create policy "users update own profile" on public.profiles for update to authenticated using (auth.uid() = id);

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  unique(user_id, role)
);
grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;
create policy "users read own roles" on public.user_roles for select to authenticated using (auth.uid() = user_id);

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

-- Auto-create profile + default role on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email));
  insert into public.user_roles (user_id, role) values (new.id, 'dani')
  on conflict do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Conciliações
create type public.reconciliation_status as enum ('aberta','fechada','reaberta');
create type public.entry_source as enum ('bb','agrotis');
create type public.entry_type as enum ('C','D');
create type public.match_confidence as enum ('strong','medium','pending');
create type public.match_status as enum ('suggested','confirmed','manual','no_pair');

create table public.reconciliations (
  id uuid primary key default gen_random_uuid(),
  reconciliation_date date not null default current_date,
  account text not null default 'Banco do Brasil',
  status public.reconciliation_status not null default 'aberta',
  created_by uuid not null references auth.users(id),
  bb_file_name text,
  agrotis_file_name text,
  closed_at timestamptz,
  closed_by uuid references auth.users(id),
  reopened_at timestamptz,
  reopened_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.reconciliations to authenticated;
grant all on public.reconciliations to service_role;
alter table public.reconciliations enable row level security;
create policy "authenticated read reconciliations" on public.reconciliations for select to authenticated using (true);
create policy "authenticated insert reconciliations" on public.reconciliations for insert to authenticated with check (auth.uid() = created_by);
create policy "authenticated update reconciliations" on public.reconciliations for update to authenticated using (true);

create table public.reconciliation_entries (
  id uuid primary key default gen_random_uuid(),
  reconciliation_id uuid not null references public.reconciliations(id) on delete cascade,
  source public.entry_source not null,
  entry_date date,
  description text,
  beneficiary text,
  amount numeric(14,2) not null,
  entry_type public.entry_type not null,
  document_ref text,
  raw jsonb,
  created_at timestamptz not null default now()
);
create index on public.reconciliation_entries(reconciliation_id);
grant select, insert, update, delete on public.reconciliation_entries to authenticated;
grant all on public.reconciliation_entries to service_role;
alter table public.reconciliation_entries enable row level security;
create policy "auth read entries" on public.reconciliation_entries for select to authenticated using (true);
create policy "auth write entries" on public.reconciliation_entries for all to authenticated using (true) with check (true);

create table public.reconciliation_matches (
  id uuid primary key default gen_random_uuid(),
  reconciliation_id uuid not null references public.reconciliations(id) on delete cascade,
  bb_entry_id uuid references public.reconciliation_entries(id) on delete cascade,
  agrotis_entry_id uuid references public.reconciliation_entries(id) on delete cascade,
  confidence public.match_confidence not null,
  status public.match_status not null default 'suggested',
  reason text,
  justification text,
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.reconciliation_matches(reconciliation_id);
grant select, insert, update, delete on public.reconciliation_matches to authenticated;
grant all on public.reconciliation_matches to service_role;
alter table public.reconciliation_matches enable row level security;
create policy "auth read matches" on public.reconciliation_matches for select to authenticated using (true);
create policy "auth write matches" on public.reconciliation_matches for all to authenticated using (true) with check (true);

create table public.reconciliation_audit_log (
  id uuid primary key default gen_random_uuid(),
  reconciliation_id uuid not null references public.reconciliations(id) on delete cascade,
  user_id uuid references auth.users(id),
  action text not null,
  details jsonb,
  created_at timestamptz not null default now()
);
create index on public.reconciliation_audit_log(reconciliation_id);
grant select, insert on public.reconciliation_audit_log to authenticated;
grant all on public.reconciliation_audit_log to service_role;
alter table public.reconciliation_audit_log enable row level security;
create policy "auth read log" on public.reconciliation_audit_log for select to authenticated using (true);
create policy "auth insert log" on public.reconciliation_audit_log for insert to authenticated with check (auth.uid() = user_id);
