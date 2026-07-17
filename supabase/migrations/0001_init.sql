-- Windy City Eatz Inventory Ordering System
-- Initial schema: config + orders tables, RLS policies, realtime, seed data

-- ============================================================
-- config table
-- Single-row (id = 1) table holding all app-wide settings:
-- locations, categories, suppliers, items, and role PINs.
-- ============================================================
create table if not exists public.config (
  id integer primary key default 1,
  locations jsonb not null default '[]'::jsonb,
  categories jsonb not null default '[]'::jsonb,
  suppliers jsonb not null default '[]'::jsonb,
  items jsonb not null default '[]'::jsonb,
  pins jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint config_singleton check (id = 1)
);

-- ============================================================
-- orders table
-- One row per line item within a submission batch.
-- batch_id groups every item an employee submits together so the
-- Order Team and Receiving screens can display/act on whole batches.
-- ============================================================
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null default gen_random_uuid(),
  date timestamptz not null default now(),
  location text not null,
  item_id text not null,
  item_name text not null,
  item_unit text not null,
  category text not null,
  qty integer not null default 0,
  urgent boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending', 'ordered', 'received', 'partial', 'dismissed')),
  notes text,
  submitted_by text not null,
  supplier text,
  ordered_date timestamptz,
  received_qty integer,
  received_date timestamptz,
  receive_notes text
);

create index if not exists orders_batch_id_idx on public.orders (batch_id);
create index if not exists orders_status_idx on public.orders (status);
create index if not exists orders_location_idx on public.orders (location);
create index if not exists orders_date_idx on public.orders (date desc);

-- ============================================================
-- Row Level Security
--
-- This app uses simple in-app PIN checks per role rather than
-- Supabase Auth (per the product requirement: PIN login only, no
-- email/password accounts). Because requests are made with the
-- public anon key and there is no authenticated Postgres role to
-- key policies off of, RLS here is permissive by design -- it
-- exists to keep the tables intentionally exposed (rather than
-- default-locked) and to document intent, not to enforce
-- per-role authorization. Real authorization is enforced in the
-- client UI. If you need real per-role database security, put a
-- Supabase Edge Function or server in front of writes and switch
-- these policies to require an authenticated JWT.
-- ============================================================
alter table public.config enable row level security;
alter table public.orders enable row level security;

drop policy if exists "config_select_anon" on public.config;
create policy "config_select_anon" on public.config
  for select to anon, authenticated using (true);

drop policy if exists "config_update_anon" on public.config;
create policy "config_update_anon" on public.config
  for update to anon, authenticated using (true) with check (true);

drop policy if exists "config_insert_anon" on public.config;
create policy "config_insert_anon" on public.config
  for insert to anon, authenticated with check (true);

drop policy if exists "orders_select_anon" on public.orders;
create policy "orders_select_anon" on public.orders
  for select to anon, authenticated using (true);

drop policy if exists "orders_insert_anon" on public.orders;
create policy "orders_insert_anon" on public.orders
  for insert to anon, authenticated with check (true);

drop policy if exists "orders_update_anon" on public.orders;
create policy "orders_update_anon" on public.orders
  for update to anon, authenticated using (true) with check (true);

drop policy if exists "orders_delete_anon" on public.orders;
create policy "orders_delete_anon" on public.orders
  for delete to anon, authenticated using (true);

-- ============================================================
-- Realtime
-- ============================================================
alter publication supabase_realtime add table public.orders;
alter publication supabase_realtime add table public.config;

-- ============================================================
-- Seed data
-- ============================================================
insert into public.config (id, locations, categories, suppliers, items, pins)
values (
  1,
  '["Windy City Eatz Soul", "Windy City Eatz Raceway", "Windy City Eatz Trailer"]'::jsonb,
  '["Food & Beverages", "Cleaning Supplies", "Office Supplies", "Equipment & Maintenance", "Personal Protective Equipment (PPE)"]'::jsonb,
  '["US Foods", "Gordon'\''s Food Service", "Sam'\''s Club"]'::jsonb,
  '[
    {"id": "vienna-hot-dogs", "name": "Vienna Hot Dogs", "unit": "case (x2)", "category": "Food & Beverages"},
    {"id": "italian-beef", "name": "Italian Beef", "unit": "case (x2)", "category": "Food & Beverages"},
    {"id": "mozzarella-cheese", "name": "Mozzarella Cheese", "unit": "unit", "category": "Food & Beverages"},
    {"id": "american-cheese", "name": "American Cheese", "unit": "unit", "category": "Food & Beverages"},
    {"id": "french-bread", "name": "French Bread", "unit": "case (x12)", "category": "Food & Beverages"},
    {"id": "poppyseed-buns", "name": "Poppyseed Buns", "unit": "case (x12)", "category": "Food & Beverages"},
    {"id": "paper-towels", "name": "Paper Towels", "unit": "case (x6)", "category": "Cleaning Supplies"},
    {"id": "utensils", "name": "Utensils", "unit": "case (x250)", "category": "Cleaning Supplies"}
  ]'::jsonb,
  '{"employee": "1111", "orderteam": "2222", "receiving": "3333", "admin": "4444"}'::jsonb
)
on conflict (id) do nothing;
