-- Mathside FRESH SUPABASE INSTALL / 2026-10-28
-- Student drafts and submission cleanup triggers; no notifications.
-- Run in Supabase SQL Editor in filename order on a BLANK project.

-- =====================================================================
-- MATHSIDE V10 CLASSROOM FEATURES UPGRADE
-- Adds:
--   * Student To-Do List (uses existing assignments/submissions)
--   * Student Calendar (uses existing assignment due dates)
--   * Teacher Feedback Inbox (uses existing graded submissions)
--   * Student assignment draft saving
--   * Assignment resubmission controls (uses existing allow_resubmission)
--   * Notifications Center
--   * Export Class Record to Excel (frontend only)
--
-- Attendance and private messaging are intentionally NOT included.
-- No new Edge Function is required for these V10 features.
--
-- Run this ONCE after the existing Mathside V9.x database setup.
-- This script is idempotent and can be safely re-run.
-- =====================================================================

create extension if not exists pgcrypto;
create schema if not exists mathside_private;

-- ---------------------------------------------------------------------
-- 0. CLEAN UP PRIVATE-MESSAGING OBJECTS FROM ANY EARLIER V10 TEST BUILD
-- ---------------------------------------------------------------------
-- These statements do nothing on a normal V9.x database. They make this
-- upgrade safe if an earlier preview of V10 with messaging was tested.
drop table if exists public.mathside_messages cascade;
drop function if exists public.mathside_message_contacts();
drop function if exists public.mathside_send_message(uuid, text, uuid);
drop function if exists public.mathside_get_conversation(uuid);
drop function if exists public.mathside_mark_conversation_read(uuid);
drop function if exists mathside_private.notify_private_message();
drop function if exists mathside_private.can_message_users(uuid, uuid);

-- ---------------------------------------------------------------------
-- 1. STUDENT ASSIGNMENT DRAFTS
-- ---------------------------------------------------------------------
create table if not exists public.mathside_assignment_drafts (
  student_id uuid not null references public.mathside_profiles(id) on delete cascade,
  assignment_id uuid not null references public.mathside_assignments(id) on delete cascade,
  answers jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (student_id, assignment_id),
  check (jsonb_typeof(answers) = 'array')
);

create index if not exists mathside_assignment_drafts_updated_idx
  on public.mathside_assignment_drafts(student_id, updated_at desc);

alter table public.mathside_assignment_drafts enable row level security;

drop policy if exists mathside_drafts_select on public.mathside_assignment_drafts;
drop policy if exists mathside_drafts_insert on public.mathside_assignment_drafts;
drop policy if exists mathside_drafts_update on public.mathside_assignment_drafts;
drop policy if exists mathside_drafts_delete on public.mathside_assignment_drafts;

create policy mathside_drafts_select
on public.mathside_assignment_drafts
for select
to authenticated
using (student_id = (select auth.uid()));

create policy mathside_drafts_insert
on public.mathside_assignment_drafts
for insert
to authenticated
with check (
  student_id = (select auth.uid())
  and mathside_private.is_student((select auth.uid()))
  and exists (
    select 1
    from public.mathside_assignments a
    where a.id = assignment_id
      and a.status = 'published'
      and mathside_private.student_in_section(a.section_id, (select auth.uid()))
  )
);

create policy mathside_drafts_update
on public.mathside_assignment_drafts
for update
to authenticated
using (student_id = (select auth.uid()))
with check (
  student_id = (select auth.uid())
  and exists (
    select 1
    from public.mathside_assignments a
    where a.id = assignment_id
      and a.status = 'published'
      and mathside_private.student_in_section(a.section_id, (select auth.uid()))
  )
);

create policy mathside_drafts_delete
on public.mathside_assignment_drafts
for delete
to authenticated
using (student_id = (select auth.uid()));

grant select, insert, update, delete on public.mathside_assignment_drafts to authenticated;

-- ---------------------------------------------------------------------
-- 3. CLEAN DRAFT AFTER SUCCESSFUL SUBMISSION / RESUBMISSION
-- ---------------------------------------------------------------------
create or replace function mathside_private.clear_submitted_draft()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.mathside_assignment_drafts
  where student_id = new.student_id
    and assignment_id = new.assignment_id;
  return new;
end;
$$;

drop trigger if exists mathside_submission_clear_draft on public.mathside_submissions;
create trigger mathside_submission_clear_draft
after insert or update of submitted_at on public.mathside_submissions
for each row execute function mathside_private.clear_submitted_draft();

-- ---------------------------------------------------------------------
-- 4. SECURITY CLEANUP
-- ---------------------------------------------------------------------


revoke all on function mathside_private.clear_submitted_draft() from public;

-- V10 upgrade complete.

notify pgrst, 'reload schema';
