-- ============================================================
-- TabOut — Supabase schema
-- Paste this entire file into Supabase → SQL Editor → Run.
-- ============================================================
-- WARNING: the DROP block below wipes any existing TabOut data.
-- That's fine on a fresh project; remove it once you go to prod.
-- ============================================================
drop table if exists public.claims cascade;
drop table if exists public.items cascade;
drop table if exists public.room_members cascade;
drop table if exists public.rooms cascade;
drop table if exists public.profiles cascade;

-- ---------- profiles (mirrors auth.users with display name) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text unique not null,
  name text not null,
  created_at timestamptz default now()
);

-- auto-create profile when a new auth user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- rooms ----------
create table if not exists public.rooms (
  code text primary key check (code ~ '^[0-9]{4}$'),
  name text not null,
  host_id uuid not null references public.profiles(id) on delete cascade,
  tip_pct int not null default 20 check (tip_pct between 0 and 100),
  split_mode text not null default 'claim' check (split_mode in ('claim','even','custom')),
  created_at timestamptz default now()
);

-- ---------- room members (the "invite" link) ----------
create table if not exists public.room_members (
  room_code text not null references public.rooms(code) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  custom_share int not null default 0 check (custom_share between 0 and 100),
  joined_at timestamptz default now(),
  primary key (room_code, user_id)
);

create index if not exists room_members_user_idx on public.room_members(user_id);

-- ---------- items ----------
create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  room_code text not null references public.rooms(code) on delete cascade,
  name text not null,
  price numeric(10,2) not null check (price > 0),
  added_by uuid not null references public.profiles(id),
  created_at timestamptz default now()
);

create index if not exists items_room_idx on public.items(room_code);

-- ---------- claims (who's paying for what) ----------
create table if not exists public.claims (
  item_id uuid not null references public.items(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (item_id, user_id)
);

-- ============================================================
-- Row Level Security
-- ============================================================
alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.items enable row level security;
alter table public.claims enable row level security;

-- helper: is this user a member of this room?
create or replace function public.is_room_member(p_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.room_members
    where room_code = p_code and user_id = auth.uid()
  );
$$;

-- helper: is this user the host of this room?
create or replace function public.is_room_host(p_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.rooms
    where code = p_code and host_id = auth.uid()
  );
$$;

-- ---------- profiles policies ----------
drop policy if exists "profiles readable by all authenticated" on public.profiles;
create policy "profiles readable by all authenticated"
  on public.profiles for select
  to authenticated using (true);

drop policy if exists "profiles self insert" on public.profiles;
create policy "profiles self insert"
  on public.profiles for insert
  to authenticated with check (id = auth.uid());

drop policy if exists "profiles self update" on public.profiles;
create policy "profiles self update"
  on public.profiles for update
  to authenticated using (id = auth.uid());

-- ---------- rooms policies ----------
-- need to read rooms by code BEFORE joining, so allow any authenticated SELECT
drop policy if exists "rooms readable by authenticated" on public.rooms;
create policy "rooms readable by authenticated"
  on public.rooms for select
  to authenticated using (true);

drop policy if exists "rooms host can insert" on public.rooms;
create policy "rooms host can insert"
  on public.rooms for insert
  to authenticated with check (host_id = auth.uid());

drop policy if exists "rooms host can update" on public.rooms;
create policy "rooms host can update"
  on public.rooms for update
  to authenticated using (host_id = auth.uid());

drop policy if exists "rooms host can delete" on public.rooms;
create policy "rooms host can delete"
  on public.rooms for delete
  to authenticated using (host_id = auth.uid());

-- ---------- room_members policies ----------
drop policy if exists "members readable to members" on public.room_members;
create policy "members readable to members"
  on public.room_members for select
  to authenticated using (public.is_room_member(room_code));

drop policy if exists "members self insert" on public.room_members;
create policy "members self insert"
  on public.room_members for insert
  to authenticated with check (user_id = auth.uid());

drop policy if exists "members host updates shares" on public.room_members;
create policy "members host updates shares"
  on public.room_members for update
  to authenticated using (public.is_room_host(room_code));

drop policy if exists "members self leave or host removes" on public.room_members;
create policy "members self leave or host removes"
  on public.room_members for delete
  to authenticated using (user_id = auth.uid() or public.is_room_host(room_code));

-- ---------- items policies ----------
drop policy if exists "items readable to members" on public.items;
create policy "items readable to members"
  on public.items for select
  to authenticated using (public.is_room_member(room_code));

drop policy if exists "items members can add" on public.items;
create policy "items members can add"
  on public.items for insert
  to authenticated with check (
    added_by = auth.uid() and public.is_room_member(room_code)
  );

drop policy if exists "items host or adder can delete" on public.items;
create policy "items host or adder can delete"
  on public.items for delete
  to authenticated using (
    added_by = auth.uid() or public.is_room_host(room_code)
  );

-- ---------- claims policies ----------
drop policy if exists "claims readable to room members" on public.claims;
create policy "claims readable to room members"
  on public.claims for select
  to authenticated using (
    exists (
      select 1 from public.items i
      where i.id = item_id and public.is_room_member(i.room_code)
    )
  );

drop policy if exists "claims self insert" on public.claims;
create policy "claims self insert"
  on public.claims for insert
  to authenticated with check (
    user_id = auth.uid() and exists (
      select 1 from public.items i
      where i.id = item_id and public.is_room_member(i.room_code)
    )
  );

drop policy if exists "claims self delete" on public.claims;
create policy "claims self delete"
  on public.claims for delete
  to authenticated using (user_id = auth.uid());

-- ============================================================
-- Realtime: publish changes so clients can subscribe
-- ============================================================
alter publication supabase_realtime add table public.rooms;
alter publication supabase_realtime add table public.room_members;
alter publication supabase_realtime add table public.items;
alter publication supabase_realtime add table public.claims;
