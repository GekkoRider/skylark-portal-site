-- ============================================================================
-- Skylark portal — Zoom Meeting SDK integration
-- Run this in the Supabase SQL Editor for project ref clsbenbapgvgmubzbgxw.
--
-- Before you run it, in a separate query, look at what policies already exist:
--     select * from pg_policies where schemaname = 'public' order by tablename;
-- Policy names in this project are NOT consistent (see the RLS notes in the
-- team handbook). Everything below uses NEW, short, unquoted names on NEW
-- tables/columns, so it will not collide with anything already there.
--
-- RLS rule for this project: any policy that needs to read another table goes
-- through a SECURITY DEFINER helper, never a direct sub-select (a direct
-- cross-table sub-select between children/enrollments/cohorts caused a 42P17
-- infinite-recursion outage once). Helpers is_staff(), is_tutor(),
-- current_tutor_cohort_ids() already exist; current_parent_cohort_ids() is
-- added here.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Columns on existing tables
-- ----------------------------------------------------------------------------

-- Each cohort gets ONE recurring Zoom meeting (type 3, no fixed time). It is
-- created lazily the first time a tutor opens the embedded room. classroom_link
-- is intentionally left in place as a transitional fallback.
alter table public.cohorts
  add column if not exists zoom_meeting_id        text,
  add column if not exists zoom_join_url          text,
  add column if not exists zoom_password          text,
  add column if not exists zoom_meeting_created_at timestamptz,
  add column if not exists zoom_owner_user_id     text;   -- the tutor Zoom user the meeting is owned by

create index if not exists cohorts_zoom_meeting_id_idx
  on public.cohorts (zoom_meeting_id);

-- The tutor's user inside Skylark's own Zoom account (their Zoom login email is
-- a valid value). The recurring meeting is created under this user and the host
-- ZAK is fetched for it.
alter table public.tutors
  add column if not exists zoom_user_id text;

-- upsert-by-email is used by the admin screen; make sure email is unique.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tutors'::regclass and contype = 'u'
      and conkey = array[
        (select attnum from pg_attribute
         where attrelid = 'public.tutors'::regclass and attname = 'email')
      ]
  ) then
    alter table public.tutors add constraint tutors_email_key unique (email);
  end if;
end $$;

-- Staff need to write tutors (name / login email / zoom_user_id) from /admin/.
-- Older projects only had a read policy here. Add a staff-write policy without
-- toggling RLS enablement (leave that exactly as it is — flipping it on a table
-- that currently has it off would break the existing tutor/admin reads).
drop policy if exists staff_manages_tutors on public.tutors;
create policy staff_manages_tutors on public.tutors
  for all
  using (is_staff())
  with check (is_staff());

-- ----------------------------------------------------------------------------
-- 2. Parent -> cohort helper (SECURITY DEFINER, no cross-table sub-select in a
--    policy). Reusable; the signature Edge Function does its own service-role
--    check, but this is handy elsewhere and for manual verification.
-- ----------------------------------------------------------------------------
create or replace function public.current_parent_cohort_ids()
returns setof uuid
language sql
security definer
set search_path = public
as $$
  select e.cohort_id
  from enrollments e
  join children c on c.id = e.child_id
  join families  f on f.id = c.family_id
  where f.auth_user_id = auth.uid()
    and e.active = true;
$$;

revoke all on function public.current_parent_cohort_ids() from public;
grant execute on function public.current_parent_cohort_ids() to authenticated;

-- ----------------------------------------------------------------------------
-- 3. session_recordings — one row per recording file Zoom produces per session.
--    Written only by the zoom-webhook Edge Function (service role, bypasses
--    RLS). Readable by staff, and by the tutor assigned to that cohort.
-- ----------------------------------------------------------------------------
create table if not exists public.session_recordings (
  id                        uuid primary key default gen_random_uuid(),
  cohort_id                 uuid references public.cohorts(id) on delete set null,
  zoom_meeting_id           text,
  zoom_meeting_uuid         text,
  session_date              date,
  recording_started_at      timestamptz,
  file_type                 text,           -- MP4 / M4A / TRANSCRIPT / CHAT / CC / CSV
  file_extension            text,
  bytes                     bigint,
  storage_path              text,           -- path inside the private 'session-recordings' bucket, null if not stored
  stored                    boolean default false,
  skipped_reason            text,           -- e.g. 'oversized', 'download_failed'
  zoom_play_url             text,
  consent_missing_child_ids uuid[] default '{}',   -- enrolled children with no current 'session_recording' consent
  raw_event                 jsonb,
  created_at                timestamptz default now(),
  unique (zoom_meeting_uuid, file_type)
);

alter table public.session_recordings enable row level security;

drop policy if exists staff_all_session_recordings on public.session_recordings;
create policy staff_all_session_recordings on public.session_recordings
  for all
  using (is_staff())
  with check (is_staff());

drop policy if exists tutor_reads_session_recordings on public.session_recordings;
create policy tutor_reads_session_recordings on public.session_recordings
  for select
  using (is_tutor() and cohort_id in (select current_tutor_cohort_ids()));

-- ----------------------------------------------------------------------------
-- 4. session_zoom_participation — supplementary join/leave timestamps straight
--    from Zoom. NOT attendance. The one-tap tutor-marked attendance table
--    stays the source of truth and is never touched by any of this.
-- ----------------------------------------------------------------------------
create table if not exists public.session_zoom_participation (
  id                    uuid primary key default gen_random_uuid(),
  cohort_id             uuid references public.cohorts(id) on delete set null,
  zoom_meeting_id       text,
  zoom_meeting_uuid     text,
  session_date          date,
  zoom_participant_uuid text,
  zoom_user_email       text,
  display_name          text,
  child_id              uuid references public.children(id) on delete set null,
  role                  text,               -- 'host' | 'participant' (best effort)
  joined_at             timestamptz,
  left_at               timestamptz,
  source                text default 'zoom',
  created_at            timestamptz default now()
);

create index if not exists szp_meeting_participant_idx
  on public.session_zoom_participation (zoom_meeting_uuid, zoom_participant_uuid);

alter table public.session_zoom_participation enable row level security;

drop policy if exists staff_all_session_participation on public.session_zoom_participation;
create policy staff_all_session_participation on public.session_zoom_participation
  for all
  using (is_staff())
  with check (is_staff());

drop policy if exists tutor_reads_session_participation on public.session_zoom_participation;
create policy tutor_reads_session_participation on public.session_zoom_participation
  for select
  using (is_tutor() and cohort_id in (select current_tutor_cohort_ids()));

-- ----------------------------------------------------------------------------
-- 5. Private storage bucket for recordings + policies on storage.objects.
--    Path convention written by the webhook: <cohort_id>/<yyyy-mm-dd>/<file>.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('session-recordings', 'session-recordings', false)
on conflict (id) do nothing;

drop policy if exists "staff manage session recordings" on storage.objects;
create policy "staff manage session recordings"
  on storage.objects for all
  using (bucket_id = 'session-recordings' and is_staff())
  with check (bucket_id = 'session-recordings' and is_staff());

drop policy if exists "tutor reads own cohort session recordings" on storage.objects;
create policy "tutor reads own cohort session recordings"
  on storage.objects for select
  using (
    bucket_id = 'session-recordings'
    and is_tutor()
    -- first path segment is the cohort id; the regex guard stops a non-uuid
    -- segment (e.g. the webhook's "unmatched" folder) from erroring the cast.
    and (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    and ((storage.foldername(name))[1])::uuid in (select current_tutor_cohort_ids())
  );

commit;

-- ============================================================================
-- Rollback (keep for reference; do not run unless backing this change out)
-- ----------------------------------------------------------------------------
-- begin;
--   drop policy if exists "tutor reads own cohort session recordings" on storage.objects;
--   drop policy if exists "staff manage session recordings" on storage.objects;
--   drop table if exists public.session_zoom_participation;
--   drop table if exists public.session_recordings;
--   drop function if exists public.current_parent_cohort_ids();
--   alter table public.cohorts
--     drop column if exists zoom_meeting_id,
--     drop column if exists zoom_join_url,
--     drop column if exists zoom_password,
--     drop column if exists zoom_meeting_created_at,
--     drop column if exists zoom_owner_user_id;
--   alter table public.tutors drop column if exists zoom_user_id;
--   -- bucket + its objects are left in place on purpose.
-- commit;
