-- Additional metadata for independently imported patient recordings.
-- Existing recording ownership and row-level security policies continue to apply.

alter table public.recording_sessions
  add column if not exists imported boolean not null default false,
  add column if not exists recording_date date,
  add column if not exists patient_name text,
  add column if not exists patient_age smallint,
  add column if not exists patient_gender text,
  add column if not exists source_file_name text;

alter table public.recording_sessions
  drop constraint if exists recording_sessions_patient_age_check;
alter table public.recording_sessions
  add constraint recording_sessions_patient_age_check
  check (patient_age is null or patient_age between 0 and 150);

create index if not exists recording_sessions_user_patient_date_idx
  on public.recording_sessions (user_id, recording_date desc, patient_name);

notify pgrst, 'reload schema';
