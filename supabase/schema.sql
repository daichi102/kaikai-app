create extension if not exists "pgcrypto";

create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'field')),
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.appliance_slips (
  id uuid primary key default gen_random_uuid(),
  slip_type text not null default 'AQUA返品票',
  sto_number text not null,
  approval_number text not null,
  work_order_number text not null,
  vendor_name text,
  model_number text not null,
  serial_number text not null,
  request_type text not null,
  symptom text,
  inspection_level text,
  return_destination text,
  product_name text,
  request_department text,
  customer_name text,
  appliance_category text not null check (appliance_category in ('washing_machine', 'refrigerator', 'microwave')),
  status text not null default 'stored' check (status in ('stored', 'collected', 'returned')),
  ocr_needs_review boolean not null default false,
  duplicate_warning boolean not null default false,
  image_path text,
  registered_by uuid references auth.users(id),
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_appliance_model_serial
  on public.appliance_slips(model_number, serial_number);

create table if not exists public.appliance_status_histories (
  id uuid primary key default gen_random_uuid(),
  appliance_slip_id uuid not null references public.appliance_slips(id) on delete cascade,
  from_status text check (from_status in ('stored', 'collected', 'returned')),
  to_status text not null check (to_status in ('stored', 'collected', 'returned')),
  changed_by uuid references auth.users(id),
  changed_at timestamptz not null default now(),
  note text
);

create table if not exists public.notification_logs (
  id uuid primary key default gen_random_uuid(),
  appliance_category text not null check (appliance_category in ('washing_machine', 'refrigerator')),
  current_count integer not null,
  threshold integer not null,
  sent_at timestamptz not null default now(),
  sent_by uuid references auth.users(id)
);

create table if not exists public.line_send_logs (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  target_group_id text not null,
  sent_at timestamptz not null default now(),
  sent_by uuid references auth.users(id),
  status text not null check (status in ('success', 'failed')),
  error_message text
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_user_profiles_updated_at on public.user_profiles;
create trigger trg_user_profiles_updated_at
before update on public.user_profiles
for each row execute procedure public.set_updated_at();

drop trigger if exists trg_appliance_slips_updated_at on public.appliance_slips;
create trigger trg_appliance_slips_updated_at
before update on public.appliance_slips
for each row execute procedure public.set_updated_at();

alter table public.user_profiles enable row level security;
alter table public.appliance_slips enable row level security;
alter table public.appliance_status_histories enable row level security;
alter table public.notification_logs enable row level security;
alter table public.line_send_logs enable row level security;

drop policy if exists "authenticated read user_profiles" on public.user_profiles;
create policy "authenticated read user_profiles"
  on public.user_profiles
  for select
  to authenticated
  using (true);

drop policy if exists "authenticated read appliance_slips" on public.appliance_slips;
create policy "authenticated read appliance_slips"
  on public.appliance_slips
  for select
  to authenticated
  using (true);

drop policy if exists "authenticated read status_histories" on public.appliance_status_histories;
create policy "authenticated read status_histories"
  on public.appliance_status_histories
  for select
  to authenticated
  using (true);

drop policy if exists "authenticated read notification_logs" on public.notification_logs;
create policy "authenticated read notification_logs"
  on public.notification_logs
  for select
  to authenticated
  using (true);

drop policy if exists "authenticated read line_send_logs" on public.line_send_logs;
create policy "authenticated read line_send_logs"
  on public.line_send_logs
  for select
  to authenticated
  using (true);
