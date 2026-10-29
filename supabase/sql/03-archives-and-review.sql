-- Mathside FRESH SUPABASE INSTALL / 2026-10-28
-- Archive and teacher review RPCs, feedback and resubmissions.
-- Run in Supabase SQL Editor in filename order on a BLANK project.

-- Mathside V12.1 classroom archive + controlled review upgrade
-- Run ONCE after the existing Mathside setup / classroom-feature upgrades.
-- Safe to re-run: columns/functions/policies are created idempotently where possible.

begin;

-- -------------------------------------------------------------------
-- 1. ARCHIVE + REVIEW COLUMNS
-- -------------------------------------------------------------------
alter table public.mathside_sections
  add column if not exists archived_at timestamptz;

alter table public.mathside_assignments
  add column if not exists archived_at timestamptz;

alter table public.mathside_submissions
  add column if not exists resubmit_allowed boolean not null default false;

alter table public.mathside_submission_answers
  add column if not exists manual_is_correct boolean;

create index if not exists mathside_sections_archived_idx
  on public.mathside_sections(teacher_id, archived_at);

create index if not exists mathside_assignments_status_archived_idx
  on public.mathside_assignments(section_id, status, archived_at);

-- -------------------------------------------------------------------
-- 2. STUDENTS MAY READ ARCHIVED ACTIVITIES, BUT MAY NOT SUBMIT TO THEM
-- -------------------------------------------------------------------
drop policy if exists mathside_assignments_select on public.mathside_assignments;
create policy mathside_assignments_select
on public.mathside_assignments
for select
to authenticated
using (
  teacher_id = (select auth.uid())
  or (
    status in ('published','archived')
    and mathside_private.student_in_section(section_id, (select auth.uid()))
  )
);

-- Archived activities remain readable, so students can still review the questions.
drop policy if exists mathside_questions_select on public.mathside_questions;
create policy mathside_questions_select
on public.mathside_questions
for select
to authenticated
using (
  exists (
    select 1
    from public.mathside_assignments a
    where a.id = assignment_id
      and (
        a.teacher_id = (select auth.uid())
        or (
          a.status in ('published','archived')
          and mathside_private.student_in_section(a.section_id, (select auth.uid()))
        )
      )
  )
);

-- File access will be configured through Cloudflare R2 later.

-- -------------------------------------------------------------------
-- 3. CONTROLLED RESUBMISSION
-- -------------------------------------------------------------------
-- Older Mathside builds used a different return type for this signature.
-- PostgreSQL cannot change a function return type with CREATE OR REPLACE,
-- so drop the exact old signature before recreating it. Safe to re-run.
drop function if exists public.mathside_allow_resubmission(uuid);

create function public.mathside_allow_resubmission(p_submission_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_submission public.mathside_submissions;
  v_assignment public.mathside_assignments;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not mathside_private.is_teacher(v_uid) then raise exception 'Only teachers can allow resubmission.'; end if;

  select * into v_submission
  from public.mathside_submissions
  where id = p_submission_id
  for update;

  if v_submission.id is null then raise exception 'Submission not found.'; end if;

  select * into v_assignment
  from public.mathside_assignments
  where id = v_submission.assignment_id;

  if v_assignment.id is null or v_assignment.teacher_id <> v_uid then
    raise exception 'You do not own this activity.';
  end if;
  if v_assignment.status <> 'published' then raise exception 'Archived or closed activities cannot accept another submission.'; end if;
  if not v_assignment.allow_resubmission then raise exception 'Resubmission is not enabled for this activity.'; end if;

  update public.mathside_submissions
  set resubmit_allowed = true,
      updated_at = now()
  where id = p_submission_id;

  -- Notifications have been removed; no message is enqueued.
  return true;
end;
$$;

revoke all on function public.mathside_allow_resubmission(uuid) from public, anon;
grant execute on function public.mathside_allow_resubmission(uuid) to authenticated;

-- -------------------------------------------------------------------
-- 4. MANUAL ANSWER REVIEW + SCORE RECOMPUTE
-- -------------------------------------------------------------------
create or replace function public.mathside_save_submission_review(
  p_submission_id uuid,
  p_teacher_score numeric default null,
  p_feedback text default null,
  p_answer_reviews jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_submission public.mathside_submissions;
  v_assignment public.mathside_assignments;
  v_review jsonb;
  v_question_id uuid;
  v_correct boolean;
  v_manual_count integer := 0;
  v_manual_score numeric(10,2) := 0;
  v_total numeric(10,2) := 0;
  v_effective_score numeric(10,2);
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not mathside_private.is_teacher(v_uid) then raise exception 'Only teachers can review submissions.'; end if;

  select * into v_submission
  from public.mathside_submissions
  where id = p_submission_id
  for update;
  if v_submission.id is null then raise exception 'Submission not found.'; end if;

  select * into v_assignment
  from public.mathside_assignments
  where id = v_submission.assignment_id;
  if v_assignment.id is null or v_assignment.teacher_id <> v_uid then raise exception 'You do not own this submission.'; end if;

  select coalesce(sum(q.max_points),0) into v_total
  from public.mathside_questions q
  where q.assignment_id = v_assignment.id;

  for v_review in select value from jsonb_array_elements(coalesce(p_answer_reviews,'[]'::jsonb))
  loop
    v_question_id := mathside_private.safe_uuid(v_review->>'question_id');
    if v_question_id is null then continue; end if;
    v_correct := coalesce((v_review->>'is_correct')::boolean,false);

    update public.mathside_submission_answers a
    set manual_is_correct = v_correct,
        awarded_points = case when v_correct then q.max_points else 0 end
    from public.mathside_questions q
    where a.submission_id = p_submission_id
      and a.question_id = v_question_id
      and q.id = a.question_id
      and q.assignment_id = v_assignment.id;
  end loop;

  select count(*), coalesce(sum(case when coalesce(a.manual_is_correct,a.is_correct,false) then q.max_points else 0 end),0)
  into v_manual_count, v_manual_score
  from public.mathside_submission_answers a
  join public.mathside_questions q on q.id = a.question_id
  where a.submission_id = p_submission_id
    and a.manual_is_correct is not null;

  if v_manual_count > 0 then
    -- If at least one answer was manually reviewed, use the recomputed answer-level score.
    select coalesce(sum(case when coalesce(a.manual_is_correct,a.is_correct,false) then q.max_points else 0 end),0)
    into v_effective_score
    from public.mathside_submission_answers a
    join public.mathside_questions q on q.id = a.question_id
    where a.submission_id = p_submission_id;
  else
    v_effective_score := p_teacher_score;
  end if;

  if v_effective_score is not null and (v_effective_score < 0 or v_effective_score > v_total) then
    raise exception 'Teacher score must be between 0 and %.', v_total;
  end if;

  update public.mathside_submissions
  set teacher_score = v_effective_score,
      feedback = nullif(btrim(coalesce(p_feedback,'')),''),
      status = 'graded',
      graded_at = now(),
      graded_by = v_uid,
      updated_at = now()
  where id = p_submission_id;

  return jsonb_build_object(
    'submission_id', p_submission_id,
    'teacher_score', v_effective_score,
    'auto_score', v_submission.auto_score,
    'manual_review', v_manual_count > 0
  );
end;
$$;

revoke all on function public.mathside_save_submission_review(uuid,numeric,text,jsonb) from public, anon;
grant execute on function public.mathside_save_submission_review(uuid,numeric,text,jsonb) to authenticated;

-- -------------------------------------------------------------------
-- 5. SUBMIT / RESUBMIT: IMAGE REQUIRED + ONE TEACHER-APPROVED RETRY
-- -------------------------------------------------------------------
create or replace function public.mathside_submit_assignment(
  p_assignment_id uuid,
  p_answers jsonb,
  p_proof_path text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_assignment public.mathside_assignments;
  v_existing public.mathside_submissions;
  v_submission_id uuid;
  v_auto_score numeric(10,2) := 0;
  v_attempt integer := 1;
  v_answer jsonb;
  v_question public.mathside_questions;
  v_key text;
  v_text text;
  v_correct boolean;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not mathside_private.is_student(v_uid) then raise exception 'Only student accounts can submit assignments.'; end if;
  if nullif(btrim(coalesce(p_proof_path,'')),'') is null then raise exception 'Upload a clear solution image before submitting.'; end if;

  select * into v_assignment
  from public.mathside_assignments
  where id = p_assignment_id
    and status = 'published';
  if v_assignment.id is null then raise exception 'This activity is closed or archived.'; end if;
  if not mathside_private.student_in_section(v_assignment.section_id, v_uid) then raise exception 'This activity is not assigned to your section.'; end if;

  select * into v_existing
  from public.mathside_submissions
  where assignment_id = p_assignment_id
    and student_id = v_uid
  for update;

  if v_existing.id is not null then
    if not v_assignment.allow_resubmission then raise exception 'This activity has already been submitted.'; end if;
    if not coalesce(v_existing.resubmit_allowed,false) then raise exception 'Your teacher has not allowed another attempt yet.'; end if;

    v_submission_id := v_existing.id;
    v_attempt := v_existing.attempt_count + 1;
    delete from public.mathside_submission_answers where submission_id = v_submission_id;
    update public.mathside_submissions
    set status = 'submitted',
        proof_path = p_proof_path,
        auto_score = 0,
        teacher_score = null,
        feedback = null,
        attempt_count = v_attempt,
        submitted_at = now(),
        graded_at = null,
        graded_by = null,
        resubmit_allowed = false,
        updated_at = now()
    where id = v_submission_id;
  else
    insert into public.mathside_submissions(assignment_id,student_id,proof_path,status,resubmit_allowed)
    values(p_assignment_id,v_uid,p_proof_path,'submitted',false)
    returning id into v_submission_id;
  end if;

  for v_answer in select value from jsonb_array_elements(coalesce(p_answers,'[]'::jsonb))
  loop
    select q.* into v_question
    from public.mathside_questions q
    where q.id = mathside_private.safe_uuid(v_answer->>'question_id')
      and q.assignment_id = p_assignment_id;
    if v_question.id is null then continue; end if;

    select k.correct_answer into v_key
    from public.mathside_question_keys k
    where k.question_id = v_question.id;
    v_text := coalesce(v_answer->>'answer','');
    v_correct := length(btrim(coalesce(v_key,''))) > 0 and lower(btrim(v_text)) = lower(btrim(v_key));

    insert into public.mathside_submission_answers(submission_id,question_id,answer_text,is_correct,manual_is_correct,awarded_points)
    values(v_submission_id,v_question.id,v_text,v_correct,null,case when v_correct then v_question.max_points else 0 end);
    if v_correct then v_auto_score := v_auto_score + v_question.max_points; end if;
  end loop;

  update public.mathside_submissions set auto_score = v_auto_score, updated_at = now() where id = v_submission_id;

  return jsonb_build_object('submission_id',v_submission_id,'auto_score',v_auto_score,'attempt_count',v_attempt);
end;
$$;

revoke all on function public.mathside_submit_assignment(uuid,jsonb,text) from public, anon;
grant execute on function public.mathside_submit_assignment(uuid,jsonb,text) to authenticated;

-- -------------------------------------------------------------------
-- 6. CLEAR ONE STUDENT SUBMISSION (TEACHER ONLY)
-- -------------------------------------------------------------------
create or replace function public.mathside_clear_submission(p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_submission public.mathside_submissions;
  v_assignment public.mathside_assignments;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not mathside_private.is_teacher(v_uid) then raise exception 'Only teachers can clear submissions.'; end if;

  select * into v_submission from public.mathside_submissions where id = p_submission_id for update;
  if v_submission.id is null then raise exception 'Submission not found.'; end if;
  select * into v_assignment from public.mathside_assignments where id = v_submission.assignment_id;
  if v_assignment.id is null or v_assignment.teacher_id <> v_uid then raise exception 'You do not own this submission.'; end if;

  delete from public.mathside_submissions where id = p_submission_id;
  return jsonb_build_object('submission_id',p_submission_id,'proof_path',v_submission.proof_path,'student_id',v_submission.student_id,'assignment_id',v_submission.assignment_id);
end;
$$;

revoke all on function public.mathside_clear_submission(uuid) from public, anon;
grant execute on function public.mathside_clear_submission(uuid) to authenticated;

-- -------------------------------------------------------------------
-- 7. ARCHIVE CLASS + REUSE EXISTING STUDENT ACCOUNTS
-- -------------------------------------------------------------------
create or replace function public.mathside_import_archived_students(
  p_source_section_id uuid,
  p_target_section_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_source public.mathside_sections;
  v_target public.mathside_sections;
  v_count integer := 0;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not mathside_private.is_teacher(v_uid) then raise exception 'Only teachers can reuse class rosters.'; end if;

  select * into v_source from public.mathside_sections where id = p_source_section_id;
  select * into v_target from public.mathside_sections where id = p_target_section_id;
  if v_source.id is null or v_target.id is null then raise exception 'Class not found.'; end if;
  if v_source.teacher_id <> v_uid or v_target.teacher_id <> v_uid then raise exception 'You can only reuse students from your own classes.'; end if;
  if v_source.archived_at is null then raise exception 'The source class must be archived first.'; end if;
  if v_target.archived_at is not null then raise exception 'The target class is archived.'; end if;

  insert into public.mathside_section_members(section_id,student_id)
  select p_target_section_id, m.student_id
  from public.mathside_section_members m
  where m.section_id = p_source_section_id
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mathside_import_archived_students(uuid,uuid) from public, anon;
grant execute on function public.mathside_import_archived_students(uuid,uuid) to authenticated;

create or replace function public.mathside_archive_class(p_section_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_section public.mathside_sections;
  v_activity_count integer;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not mathside_private.is_teacher(v_uid) then raise exception 'Only teachers can archive classes.'; end if;

  select * into v_section from public.mathside_sections where id = p_section_id for update;
  if v_section.id is null then raise exception 'Class not found.'; end if;
  if v_section.teacher_id <> v_uid then raise exception 'You do not own this class.'; end if;
  if v_section.archived_at is not null then raise exception 'This class is already archived.'; end if;

  select count(*) into v_activity_count from public.mathside_assignments where section_id = p_section_id;
  -- Normally the frontend has already removed activities through the delete-assignment
  -- Edge Function so Storage files are cleaned too. This delete is a final safety net.
  delete from public.mathside_assignments where section_id = p_section_id;
  update public.mathside_sections set archived_at = now() where id = p_section_id;

  return jsonb_build_object('section_id',p_section_id,'activities_removed',v_activity_count);
end;
$$;

revoke all on function public.mathside_archive_class(uuid) from public, anon;
grant execute on function public.mathside_archive_class(uuid) to authenticated;

commit;


-- Mathside V13 upgrade
-- Adds per-question teacher comments and refreshes the submission review RPC.

alter table if exists public.mathside_submission_answers
  add column if not exists teacher_comment text;

create or replace function public.mathside_save_submission_review(
  p_submission_id uuid,
  p_teacher_score numeric default null,
  p_feedback text default null,
  p_answer_reviews jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_submission public.mathside_submissions;
  v_assignment public.mathside_assignments;
  v_review jsonb;
  v_question_id uuid;
  v_correct boolean;
  v_manual_count integer := 0;
  v_manual_score numeric(10,2) := 0;
  v_total numeric(10,2) := 0;
  v_effective_score numeric(10,2);
  v_teacher_comment text;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not mathside_private.is_teacher(v_uid) then raise exception 'Only teachers can review submissions.'; end if;

  select * into v_submission
  from public.mathside_submissions
  where id = p_submission_id
  for update;
  if v_submission.id is null then raise exception 'Submission not found.'; end if;

  select * into v_assignment
  from public.mathside_assignments
  where id = v_submission.assignment_id;
  if v_assignment.id is null or v_assignment.teacher_id <> v_uid then raise exception 'You do not own this submission.'; end if;

  select coalesce(sum(q.max_points),0) into v_total
  from public.mathside_questions q
  where q.assignment_id = v_assignment.id;

  for v_review in select value from jsonb_array_elements(coalesce(p_answer_reviews,'[]'::jsonb))
  loop
    v_question_id := mathside_private.safe_uuid(v_review->>'question_id');
    if v_question_id is null then continue; end if;
    v_correct := coalesce((v_review->>'is_correct')::boolean,false);
    v_teacher_comment := nullif(btrim(coalesce(v_review->>'teacher_comment','')),'');

    update public.mathside_submission_answers a
    set manual_is_correct = v_correct,
        awarded_points = case when v_correct then q.max_points else 0 end,
        teacher_comment = v_teacher_comment
    from public.mathside_questions q
    where a.submission_id = p_submission_id
      and a.question_id = v_question_id
      and q.id = a.question_id
      and q.assignment_id = v_assignment.id;
  end loop;

  select count(*), coalesce(sum(case when coalesce(a.manual_is_correct,a.is_correct,false) then q.max_points else 0 end),0)
  into v_manual_count, v_manual_score
  from public.mathside_submission_answers a
  join public.mathside_questions q on q.id = a.question_id
  where a.submission_id = p_submission_id
    and a.manual_is_correct is not null;

  if v_manual_count > 0 then
    select coalesce(sum(case when coalesce(a.manual_is_correct,a.is_correct,false) then q.max_points else 0 end),0)
    into v_effective_score
    from public.mathside_submission_answers a
    join public.mathside_questions q on q.id = a.question_id
    where a.submission_id = p_submission_id;
  else
    v_effective_score := p_teacher_score;
  end if;

  if v_effective_score is not null and (v_effective_score < 0 or v_effective_score > v_total) then
    raise exception 'Teacher score must be between 0 and %.', v_total;
  end if;

  update public.mathside_submissions
  set teacher_score = v_effective_score,
      feedback = nullif(btrim(coalesce(p_feedback,'')),'') ,
      status = 'graded',
      graded_at = now(),
      graded_by = v_uid,
      updated_at = now()
  where id = p_submission_id;

  return jsonb_build_object(
    'submission_id', p_submission_id,
    'teacher_score', v_effective_score,
    'total_points', v_total,
    'manual_review_count', v_manual_count,
    'manual_review_score', v_manual_score
  );
end;
$$;

revoke all on function public.mathside_save_submission_review(uuid,numeric,text,jsonb) from public, anon;
grant execute on function public.mathside_save_submission_review(uuid,numeric,text,jsonb) to authenticated;

notify pgrst, 'reload schema';
