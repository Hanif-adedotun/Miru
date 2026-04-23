create extension if not exists pgcrypto;

create table if not exists public.miru_sessions (
  id uuid primary key default gen_random_uuid(),
  prompt text not null,
  mode text not null check (mode in ('auto', 'ask', 'interactive')),
  origin text not null,
  latest_url text not null,
  latest_title text not null,
  latest_context jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.miru_plans (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.miru_sessions(id) on delete cascade,
  prompt text not null,
  mode text not null check (mode in ('auto', 'ask', 'interactive')),
  context jsonb not null,
  proposed_action jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists miru_plans_session_id_idx on public.miru_plans(session_id);
create index if not exists miru_sessions_origin_idx on public.miru_sessions(origin);

create or replace function public.set_miru_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_miru_sessions_updated_at on public.miru_sessions;

create trigger set_miru_sessions_updated_at
before update on public.miru_sessions
for each row
execute procedure public.set_miru_updated_at();
