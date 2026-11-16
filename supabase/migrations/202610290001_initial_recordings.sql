-- Private recording storage. Apply this migration to the Supabase project before enabling cloud sync.
-- Every row is scoped to the signed-in Supabase Auth user through RLS.

create table if not exists public.recording_sessions (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  device_name text,
  vendor_id text,
  product_id text,
  baud_rate integer not null check (baud_rate between 300 and 4000000),
  data_bits smallint not null default 8 check (data_bits in (5, 6, 7, 8)),
  parity text not null default 'none' check (parity in ('none', 'even', 'odd', 'mark', 'space')),
  stop_bits numeric(2,1) not null default 1 check (stop_bits in (1, 1.5, 2)),
  started_at timestamptz not null,
  ended_at timestamptz,
  status text not null check (status in ('recording', 'completed', 'interrupted')),
  simulated boolean not null default false,
  device_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recording_sessions_id_user_unique unique (id, user_id)
);

create table if not exists public.recording_events (
  session_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  sequence integer not null check (sequence > 0),
  received_at timestamptz not null,
  raw text not null,
  complete boolean not null default true,
  event_type text not null,
  mode text,
  device_time text,
  source_date text,
  value numeric,
  denominator numeric,
  parsed_fields jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (session_id, sequence),
  constraint recording_events_session_owner_fk
    foreign key (session_id, user_id)
    references public.recording_sessions (id, user_id)
    on delete cascade
);

create index if not exists recording_sessions_user_started_idx
  on public.recording_sessions (user_id, started_at desc);
create index if not exists recording_events_user_session_idx
  on public.recording_events (user_id, session_id, sequence);

alter table public.recording_sessions enable row level security;
alter table public.recording_events enable row level security;

drop policy if exists "Users can read their own recording sessions" on public.recording_sessions;
create policy "Users can read their own recording sessions"
  on public.recording_sessions for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own recording sessions" on public.recording_sessions;
create policy "Users can create their own recording sessions"
  on public.recording_sessions for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own recording sessions" on public.recording_sessions;
create policy "Users can update their own recording sessions"
  on public.recording_sessions for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own recording sessions" on public.recording_sessions;
create policy "Users can delete their own recording sessions"
  on public.recording_sessions for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can read their own recording events" on public.recording_events;
create policy "Users can read their own recording events"
  on public.recording_events for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own recording events" on public.recording_events;
create policy "Users can create their own recording events"
  on public.recording_events for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.recording_sessions s
      where s.id = session_id and s.user_id = (select auth.uid())
    )
  );

drop policy if exists "Users can update their own recording events" on public.recording_events;
create policy "Users can update their own recording events"
  on public.recording_events for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own recording events" on public.recording_events;
create policy "Users can delete their own recording events"
  on public.recording_events for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.recording_sessions from anon;
revoke all on public.recording_events from anon;
grant select, insert, update, delete on public.recording_sessions to authenticated;
grant select, insert, update, delete on public.recording_events to authenticated;

notify pgrst, 'reload schema';
