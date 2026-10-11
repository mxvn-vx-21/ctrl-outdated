-- Reference copy of lib/schema.js (the API runs this automatically on first request). PostgreSQL 13+.
select pg_advisory_xact_lock(727001);

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code_hash text not null,
  status text not null default 'pending' check (status in ('pending','active')),
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  code_changed_at timestamptz
);
create unique index if not exists workspaces_email_uq on workspaces (email);
create unique index if not exists workspaces_code_uq on workspaces (code_hash);

create table if not exists sessions (
  token_hash text primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_ws_idx on sessions (workspace_id);

create table if not exists email_tokens (
  token_hash text primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('verify','recover')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists email_tokens_ws_idx on email_tokens (workspace_id, kind);

create table if not exists rate_limits (
  key text primary key,
  count integer not null,
  window_start timestamptz not null default now()
);
create table if not exists login_failures (
  key text primary key,
  fails integer not null default 0,
  last_fail timestamptz not null default now(),
  locked_until timestamptz
);

-- App data tables (original MONO definitions, unchanged) -------------------
create table if not exists folders (
  id bigserial primary key,
  name text not null check (length(btrim(name)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists tasks (
  id bigserial primary key,
  title text not null check (length(btrim(title)) > 0),
  description text not null default '',
  due_date date,
  due_time integer check (due_time between 0 and 1439),
  priority smallint not null default 1 check (priority between 0 and 2),
  is_completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists notes (
  id bigserial primary key,
  title text not null default '',
  content jsonb not null default '{"v":1,"blocks":[]}',
  is_pinned boolean not null default false,
  folder_id bigint references folders(id) on delete set null,
  content_format_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists countdowns (
  id bigserial primary key,
  title text not null check (length(btrim(title)) > 0),
  target_date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Multi-tenant migration: every row belongs to a workspace -----------------
-- Rows created before accounts existed keep workspace_id NULL: nothing is deleted,
-- they are simply invisible until you explicitly assign them (see README).
alter table folders    add column if not exists workspace_id uuid references workspaces(id) on delete cascade;
alter table tasks      add column if not exists workspace_id uuid references workspaces(id) on delete cascade;
alter table notes      add column if not exists workspace_id uuid references workspaces(id) on delete cascade;
alter table countdowns add column if not exists workspace_id uuid references workspaces(id) on delete cascade;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'folders_ws_required') then
    alter table folders add constraint folders_ws_required check (workspace_id is not null) not valid; end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_ws_required') then
    alter table tasks add constraint tasks_ws_required check (workspace_id is not null) not valid; end if;
  if not exists (select 1 from pg_constraint where conname = 'notes_ws_required') then
    alter table notes add constraint notes_ws_required check (workspace_id is not null) not valid; end if;
  if not exists (select 1 from pg_constraint where conname = 'countdowns_ws_required') then
    alter table countdowns add constraint countdowns_ws_required check (workspace_id is not null) not valid; end if;
end $$;

drop index if exists folders_name_uq;
create unique index if not exists folders_ws_name_uq on folders (workspace_id, lower(name));
create index if not exists folders_ws_idx on folders (workspace_id);
create index if not exists tasks_ws_idx on tasks (workspace_id);
create index if not exists tasks_ws_due_idx on tasks (workspace_id, due_date);
create index if not exists notes_ws_idx on notes (workspace_id, is_pinned, updated_at);
create index if not exists notes_folder_idx on notes (folder_id);
create index if not exists countdowns_ws_idx on countdowns (workspace_id);
