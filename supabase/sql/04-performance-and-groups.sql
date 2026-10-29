-- Mathside FRESH SUPABASE INSTALL / 2026-10-28
-- Individual, groups, teams, leader scores and whole-class performance tasks.
-- Run in Supabase SQL Editor in filename order on a BLANK project.

-- =====================================================================
-- Mathside V15 - Performance Tasks + Multiple Solution Pictures
-- Run ONCE after the V13 teacher-comment upgrade.
-- =====================================================================

begin;

-- 1) Assignment work types and Performance Task fields
alter table public.mathside_assignments
  add column if not exists work_type text not null default 'written_work';

alter table public.mathside_assignments
  drop constraint if exists mathside_assignments_work_type_check;
alter table public.mathside_assignments
  add constraint mathside_assignments_work_type_check
  check (work_type in ('written_work','performance_task'));

alter table public.mathside_assignments
  add column if not exists max_points numeric(10,2) not null default 100
  check (max_points >= 0);

alter table public.mathside_assignments
  add column if not exists rubric_path text;

alter table public.mathside_assignments
  add column if not exists image_paths jsonb not null default '[]'::jsonb;

alter table public.mathside_assignments
  drop constraint if exists mathside_assignments_image_paths_array_check;
alter table public.mathside_assignments
  add constraint mathside_assignments_image_paths_array_check
  check (jsonb_typeof(image_paths) = 'array');

update public.mathside_assignments
set image_paths = jsonb_build_array(image_path)
where image_path is not null
  and (image_paths is null or image_paths = '[]'::jsonb);

create index if not exists mathside_assignments_work_type_idx
  on public.mathside_assignments(teacher_id, work_type, created_at desc);

-- 2) Multiple uploaded solution/output pictures
alter table public.mathside_submissions
  add column if not exists proof_paths jsonb not null default '[]'::jsonb;

alter table public.mathside_submissions
  drop constraint if exists mathside_submissions_proof_paths_array_check;
alter table public.mathside_submissions
  add constraint mathside_submissions_proof_paths_array_check
  check (jsonb_typeof(proof_paths) = 'array');

update public.mathside_submissions
set proof_paths = jsonb_build_array(proof_path)
where proof_path is not null
  and (proof_paths is null or proof_paths = '[]'::jsonb);

-- 3) Generic student submission RPC preserving Mathside teacher-approved resubmission.
create or replace function public.mathside_submit_work(
  p_assignment_id uuid,
  p_answers jsonb default '[]'::jsonb,
  p_proof_paths jsonb default '[]'::jsonb
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
  v_paths jsonb := case when jsonb_typeof(coalesce(p_proof_paths,'[]'::jsonb))='array' then coalesce(p_proof_paths,'[]'::jsonb) else '[]'::jsonb end;
  v_first_path text;
  v_path_item text;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not mathside_private.is_student(v_uid) then raise exception 'Only student accounts can submit classwork.'; end if;

  select * into v_assignment
  from public.mathside_assignments
  where id = p_assignment_id and status = 'published';
  if v_assignment.id is null then raise exception 'This activity is closed or archived.'; end if;
  if not mathside_private.student_in_section(v_assignment.section_id, v_uid) then
    raise exception 'This classwork is not assigned to your section.';
  end if;

  if jsonb_array_length(v_paths) < 1 then
    raise exception 'Upload at least one solution or output picture before submitting.';
  end if;
  if jsonb_array_length(v_paths) > 10 then
    raise exception 'Choose up to 10 uploaded pictures for one submission.';
  end if;

  for v_path_item in
    select elem #>> '{}'
    from jsonb_array_elements(v_paths) as supplied_path(elem)
  loop
    if v_path_item is null
       or v_path_item not like v_uid::text || '/' || p_assignment_id::text || '/%' then
      raise exception 'Invalid upload path for this submission.';
    end if;
  end loop;

  select elem #>> '{}'
  into v_first_path
  from jsonb_array_elements(v_paths) as path_item(elem)
  limit 1;

  select * into v_existing
  from public.mathside_submissions
  where assignment_id = p_assignment_id and student_id = v_uid
  for update;

  if v_existing.id is not null then
    if not v_assignment.allow_resubmission then raise exception 'This classwork has already been submitted.'; end if;
    if not coalesce(v_existing.resubmit_allowed,false) then raise exception 'Your teacher has not allowed another attempt yet.'; end if;
    v_submission_id := v_existing.id;
    v_attempt := v_existing.attempt_count + 1;
    delete from public.mathside_submission_answers where submission_id = v_submission_id;
    update public.mathside_submissions
    set status='submitted', proof_path=v_first_path, proof_paths=v_paths,
        auto_score=0, teacher_score=null, feedback=null,
        attempt_count=v_attempt, submitted_at=now(), graded_at=null, graded_by=null,
        resubmit_allowed=false, updated_at=now()
    where id=v_submission_id;
  else
    insert into public.mathside_submissions(assignment_id,student_id,proof_path,proof_paths,status,resubmit_allowed)
    values(p_assignment_id,v_uid,v_first_path,v_paths,'submitted',false)
    returning id into v_submission_id;
  end if;

  for v_answer in
    select value from jsonb_array_elements(coalesce(p_answers,'[]'::jsonb))
  loop
    select q.* into v_question
    from public.mathside_questions q
    where q.id = mathside_private.safe_uuid(v_answer->>'question_id')
      and q.assignment_id = p_assignment_id;
    if v_question.id is null then continue; end if;

    select k.correct_answer into v_key
    from public.mathside_question_keys k where k.question_id=v_question.id;
    v_text := coalesce(v_answer->>'answer','');
    v_correct := length(btrim(coalesce(v_key,''))) > 0 and lower(btrim(v_text)) = lower(btrim(v_key));

    insert into public.mathside_submission_answers(submission_id,question_id,answer_text,is_correct,manual_is_correct,awarded_points)
    values(v_submission_id,v_question.id,v_text,v_correct,null,case when v_correct then v_question.max_points else 0 end);
    if v_correct then v_auto_score := v_auto_score + v_question.max_points; end if;
  end loop;

  update public.mathside_submissions set auto_score=v_auto_score, updated_at=now() where id=v_submission_id;
  return jsonb_build_object('submission_id',v_submission_id,'auto_score',v_auto_score,'attempt_count',v_attempt,'proof_paths',v_paths);
end;
$$;

revoke all on function public.mathside_submit_work(uuid,jsonb,jsonb) from public, anon;
grant execute on function public.mathside_submit_work(uuid,jsonb,jsonb) to authenticated;

-- Backward compatibility for an older cached front end.
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
begin
  return public.mathside_submit_work(
    p_assignment_id,
    coalesce(p_answers,'[]'::jsonb),
    case when p_proof_path is null or btrim(p_proof_path)='' then '[]'::jsonb else jsonb_build_array(p_proof_path) end
  );
end;
$$;

revoke all on function public.mathside_submit_assignment(uuid,jsonb,text) from public, anon;
grant execute on function public.mathside_submit_assignment(uuid,jsonb,text) to authenticated;

-- 4) Review/grade function: Performance Tasks use assignment.max_points.
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
  v_manual_review boolean;
  v_manual_count integer := 0;
  v_manual_score numeric(10,2) := 0;
  v_total numeric(10,2) := 0;
  v_effective_score numeric(10,2);
  v_teacher_comment text;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not mathside_private.is_teacher(v_uid) then raise exception 'Only teachers can review submissions.'; end if;

  select * into v_submission from public.mathside_submissions where id=p_submission_id for update;
  if v_submission.id is null then raise exception 'Submission not found.'; end if;
  select * into v_assignment from public.mathside_assignments where id=v_submission.assignment_id;
  if v_assignment.id is null or v_assignment.teacher_id<>v_uid then raise exception 'You do not own this submission.'; end if;

  if v_assignment.work_type='performance_task' then
    v_total := greatest(0,coalesce(v_assignment.max_points,0));
  else
    select coalesce(sum(q.max_points),0) into v_total from public.mathside_questions q where q.assignment_id=v_assignment.id;
  end if;

  for v_review in select value from jsonb_array_elements(coalesce(p_answer_reviews,'[]'::jsonb))
  loop
    v_question_id := mathside_private.safe_uuid(v_review->>'question_id');
    if v_question_id is null then continue; end if;
    v_manual_review := coalesce((v_review->>'manual_review')::boolean,false);
    v_correct := coalesce((v_review->>'is_correct')::boolean,false);
    v_teacher_comment := nullif(btrim(coalesce(v_review->>'teacher_comment','')),'');
    update public.mathside_submission_answers a
    set manual_is_correct = case when v_manual_review then v_correct else a.manual_is_correct end,
        awarded_points = case when v_manual_review then (case when v_correct then q.max_points else 0 end) else a.awarded_points end,
        teacher_comment = v_teacher_comment
    from public.mathside_questions q
    where a.submission_id=p_submission_id
      and a.question_id=v_question_id
      and q.id=a.question_id
      and q.assignment_id=v_assignment.id;
  end loop;

  select count(*),coalesce(sum(case when coalesce(a.manual_is_correct,a.is_correct,false) then q.max_points else 0 end),0)
  into v_manual_count,v_manual_score
  from public.mathside_submission_answers a
  join public.mathside_questions q on q.id=a.question_id
  where a.submission_id=p_submission_id and a.manual_is_correct is not null;

  if v_assignment.work_type='performance_task' then
    v_effective_score := p_teacher_score;
  elsif v_manual_count>0 then
    select coalesce(sum(case when coalesce(a.manual_is_correct,a.is_correct,false) then q.max_points else 0 end),0)
    into v_effective_score
    from public.mathside_submission_answers a
    join public.mathside_questions q on q.id=a.question_id
    where a.submission_id=p_submission_id;
  else
    v_effective_score := p_teacher_score;
  end if;

  if v_effective_score is not null and (v_effective_score<0 or v_effective_score>v_total) then
    raise exception 'Teacher score must be between 0 and %.',v_total;
  end if;

  update public.mathside_submissions
  set teacher_score=v_effective_score,
      feedback=nullif(btrim(coalesce(p_feedback,'')),''),
      status='graded',graded_at=now(),graded_by=v_uid,updated_at=now()
  where id=p_submission_id;

  return jsonb_build_object('submission_id',p_submission_id,'teacher_score',v_effective_score,'total_points',v_total,'manual_review_count',v_manual_count,'manual_review_score',v_manual_score);
end;
$$;

revoke all on function public.mathside_save_submission_review(uuid,numeric,text,jsonb) from public, anon;
grant execute on function public.mathside_save_submission_review(uuid,numeric,text,jsonb) to authenticated;


commit;


-- Mathside V17 — Answer normalization / auto-check accuracy
-- Run this after 06-v15-performance-multiple-files.sql.

-- Mathside V17 — tolerant math-answer auto-checking.
-- This intentionally normalizes formatting differences only. It does not try to
-- symbolically solve/rearrange arbitrary algebra. Examples treated as equal:
--   \(x^{4}y^{4}\)   x^4y^4   x ^ 4 y ^ 4
--   \(a^6b^2\)       a^6b^2
--   \frac{1}{2}      1/2

create or replace function mathside_private.normalize_math_answer(p_value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := lower(btrim(coalesce(p_value, '')));
begin
  if v = '' then return ''; end if;

  -- Remove Mathside/LaTeX display wrappers and spacing-only commands.
  v := replace(v, E'\\(', '');
  v := replace(v, E'\\)', '');
  v := replace(v, E'\\[', '');
  v := replace(v, E'\\]', '');
  v := replace(v, '$', '');
  v := replace(v, E'\\left', '');
  v := replace(v, E'\\right', '');
  v := replace(v, E'\\,', '');
  v := replace(v, E'\\;', '');
  v := replace(v, E'\\:', '');
  v := replace(v, E'\\!', '');

  -- Normalize visually equivalent operator characters/forms.
  v := replace(v, '−', '-');
  v := replace(v, '–', '-');
  v := replace(v, '×', '*');
  v := replace(v, '·', '*');
  v := replace(v, '÷', '/');
  v := replace(v, E'\\times', '*');
  v := replace(v, E'\\cdot', '*');
  v := replace(v, E'\\div', '/');

  -- Common Unicode superscripts, useful when answers are pasted/typed directly.
  v := replace(v, '⁰', '^0');
  v := replace(v, '¹', '^1');
  v := replace(v, '²', '^2');
  v := replace(v, '³', '^3');
  v := replace(v, '⁴', '^4');
  v := replace(v, '⁵', '^5');
  v := replace(v, '⁶', '^6');
  v := replace(v, '⁷', '^7');
  v := replace(v, '⁸', '^8');
  v := replace(v, '⁹', '^9');

  -- MathLive often adds braces while normal typing usually does not.
  -- These rules preserve mathematical grouping while removing simple LaTeX-only braces.
  v := regexp_replace(v, $re$\\mathrm\{([^{}]*)\}$re$, $rep$\1$rep$, 'g');
  v := regexp_replace(v, $re$\\mathit\{([^{}]*)\}$re$, $rep$\1$rep$, 'g');
  v := regexp_replace(v, $re$\\mathbf\{([^{}]*)\}$re$, $rep$\1$rep$, 'g');
  v := regexp_replace(v, $re$\\text\{([^{}]*)\}$re$, $rep$\1$rep$, 'g');

  -- Simple fraction forms: \frac{1}{2} and \dfrac{1}{2} -> 1/2.
  v := regexp_replace(v, $re$\\dfrac\{([^{}]+)\}\{([^{}]+)\}$re$, $rep$\1/\2$rep$, 'g');
  v := regexp_replace(v, $re$\\frac\{([^{}]+)\}\{([^{}]+)\}$re$, $rep$\1/\2$rep$, 'g');

  -- x^{4} -> x^4 and x_{2} -> x_2 for simple contents.
  v := regexp_replace(v, $re$\^\{([^{}]+)\}$re$, $rep$^\1$rep$, 'g');
  v := regexp_replace(v, $re$_\{([^{}]+)\}$re$, $rep$_\1$rep$, 'g');

  -- Whitespace has no scoring significance for short mathematical answers.
  v := regexp_replace(v, '[[:space:]]+', '', 'g');

  return v;
end;
$$;

create or replace function public.mathside_submit_work(
  p_assignment_id uuid,
  p_answers jsonb default '[]'::jsonb,
  p_proof_paths jsonb default '[]'::jsonb
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
  v_paths jsonb := case when jsonb_typeof(coalesce(p_proof_paths,'[]'::jsonb))='array' then coalesce(p_proof_paths,'[]'::jsonb) else '[]'::jsonb end;
  v_first_path text;
  v_path_item text;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not mathside_private.is_student(v_uid) then raise exception 'Only student accounts can submit classwork.'; end if;

  select * into v_assignment
  from public.mathside_assignments
  where id = p_assignment_id and status = 'published';
  if v_assignment.id is null then raise exception 'This activity is closed or archived.'; end if;
  if not mathside_private.student_in_section(v_assignment.section_id, v_uid) then
    raise exception 'This classwork is not assigned to your section.';
  end if;

  if jsonb_array_length(v_paths) < 1 then
    raise exception 'Upload at least one solution or output picture before submitting.';
  end if;
  if jsonb_array_length(v_paths) > 10 then
    raise exception 'Choose up to 10 uploaded pictures for one submission.';
  end if;

  for v_path_item in
    select elem #>> '{}'
    from jsonb_array_elements(v_paths) as supplied_path(elem)
  loop
    if v_path_item is null
       or v_path_item not like v_uid::text || '/' || p_assignment_id::text || '/%' then
      raise exception 'Invalid upload path for this submission.';
    end if;
  end loop;

  select elem #>> '{}'
  into v_first_path
  from jsonb_array_elements(v_paths) as path_item(elem)
  limit 1;

  select * into v_existing
  from public.mathside_submissions
  where assignment_id = p_assignment_id and student_id = v_uid
  for update;

  if v_existing.id is not null then
    if not v_assignment.allow_resubmission then raise exception 'This classwork has already been submitted.'; end if;
    if not coalesce(v_existing.resubmit_allowed,false) then raise exception 'Your teacher has not allowed another attempt yet.'; end if;
    v_submission_id := v_existing.id;
    v_attempt := v_existing.attempt_count + 1;
    delete from public.mathside_submission_answers where submission_id = v_submission_id;
    update public.mathside_submissions
    set status='submitted', proof_path=v_first_path, proof_paths=v_paths,
        auto_score=0, teacher_score=null, feedback=null,
        attempt_count=v_attempt, submitted_at=now(), graded_at=null, graded_by=null,
        resubmit_allowed=false, updated_at=now()
    where id=v_submission_id;
  else
    insert into public.mathside_submissions(assignment_id,student_id,proof_path,proof_paths,status,resubmit_allowed)
    values(p_assignment_id,v_uid,v_first_path,v_paths,'submitted',false)
    returning id into v_submission_id;
  end if;

  for v_answer in
    select value from jsonb_array_elements(coalesce(p_answers,'[]'::jsonb))
  loop
    select q.* into v_question
    from public.mathside_questions q
    where q.id = mathside_private.safe_uuid(v_answer->>'question_id')
      and q.assignment_id = p_assignment_id;
    if v_question.id is null then continue; end if;

    select k.correct_answer into v_key
    from public.mathside_question_keys k where k.question_id=v_question.id;
    v_text := coalesce(v_answer->>'answer','');
    v_correct :=
      length(mathside_private.normalize_math_answer(v_key)) > 0
      and mathside_private.normalize_math_answer(v_text) = mathside_private.normalize_math_answer(v_key);

    insert into public.mathside_submission_answers(submission_id,question_id,answer_text,is_correct,manual_is_correct,awarded_points)
    values(v_submission_id,v_question.id,v_text,v_correct,null,case when v_correct then v_question.max_points else 0 end);
    if v_correct then v_auto_score := v_auto_score + v_question.max_points; end if;
  end loop;

  update public.mathside_submissions set auto_score=v_auto_score, updated_at=now() where id=v_submission_id;
  return jsonb_build_object('submission_id',v_submission_id,'auto_score',v_auto_score,'attempt_count',v_attempt,'proof_paths',v_paths);
end;
$$;

revoke all on function public.mathside_submit_work(uuid,jsonb,jsonb) from public, anon;
grant execute on function public.mathside_submit_work(uuid,jsonb,jsonb) to authenticated;

-- No table changes are required. Existing answer keys are normalized at comparison time.


-- Mathside V18 — safer math answer canonicalization
-- Run after 08-v17-math-answer-normalization.sql.
-- Fixes common MathLive formatting differences, nested fraction/exponent braces,
-- leading equals signs, and simple negative-exponent equivalences.

create or replace function mathside_private.normalize_math_answer(p_value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := lower(btrim(coalesce(p_value, '')));
begin
  if v = '' then return ''; end if;

  -- Remove display wrappers / spacing commands.
  v := replace(v, E'\\(', '');
  v := replace(v, E'\\)', '');
  v := replace(v, E'\\[', '');
  v := replace(v, E'\\]', '');
  v := replace(v, '$', '');
  v := replace(v, E'\\left', '');
  v := replace(v, E'\\right', '');
  v := replace(v, E'\\,', '');
  v := replace(v, E'\\;', '');
  v := replace(v, E'\\:', '');
  v := replace(v, E'\\!', '');

  -- Friendly final-answer tolerance: '=1' and '1' mean the same thing.
  v := regexp_replace(v, '^[[:space:]]*=', '');

  -- Equivalent operator characters.
  v := replace(v, '−', '-');
  v := replace(v, '–', '-');
  v := replace(v, '×', '*');
  v := replace(v, '·', '*');
  v := replace(v, '÷', '/');
  v := replace(v, E'\\times', '*');
  v := replace(v, E'\\cdot', '*');
  v := replace(v, E'\\div', '/');

  -- Unicode superscripts.
  v := replace(v, '⁰', '^0'); v := replace(v, '¹', '^1');
  v := replace(v, '²', '^2'); v := replace(v, '³', '^3');
  v := replace(v, '⁴', '^4'); v := replace(v, '⁵', '^5');
  v := replace(v, '⁶', '^6'); v := replace(v, '⁷', '^7');
  v := replace(v, '⁸', '^8'); v := replace(v, '⁹', '^9');

  -- Strip simple style wrappers.
  v := regexp_replace(v, $re$\\mathrm\{([^{}]*)\}$re$, $rep$\1$rep$, 'g');
  v := regexp_replace(v, $re$\\mathit\{([^{}]*)\}$re$, $rep$\1$rep$, 'g');
  v := regexp_replace(v, $re$\\mathbf\{([^{}]*)\}$re$, $rep$\1$rep$, 'g');
  v := regexp_replace(v, $re$\\text\{([^{}]*)\}$re$, $rep$\1$rep$, 'g');

  -- IMPORTANT: simplify exponent/subscript braces BEFORE fractions. MathLive often
  -- emits \\frac{1}{y^{2}}; doing this first turns it into \\frac{1}{y^2},
  -- which the simple fraction rule below can canonicalize correctly.
  v := regexp_replace(v, $re$\^\{([^{}]+)\}$re$, $rep$^\1$rep$, 'g');
  v := regexp_replace(v, $re$_\{([^{}]+)\}$re$, $rep$_\1$rep$, 'g');

  -- Fractions after exponent-brace simplification.
  v := regexp_replace(v, $re$\\dfrac\{([^{}]+)\}\{([^{}]+)\}$re$, $rep$\1/\2$rep$, 'g');
  v := regexp_replace(v, $re$\\frac\{([^{}]+)\}\{([^{}]+)\}$re$, $rep$\1/\2$rep$, 'g');
  -- A second pass catches fractions exposed by the first pass.
  v := regexp_replace(v, $re$\\dfrac\{([^{}]+)\}\{([^{}]+)\}$re$, $rep$\1/\2$rep$, 'g');
  v := regexp_replace(v, $re$\\frac\{([^{}]+)\}\{([^{}]+)\}$re$, $rep$\1/\2$rep$, 'g');

  -- Remove whitespace before algebraic canonicalization.
  v := regexp_replace(v, '[[:space:]]+', '', 'g');

  -- Simple exponent-law equivalences useful for final answers.
  -- y^-2 / y^(-2) -> 1/y^2
  v := regexp_replace(v, '^([a-z][a-z0-9_]*)\^\(-([0-9]+)\)$', '1/\1^\2');
  v := regexp_replace(v, '^([a-z][a-z0-9_]*)\^-([0-9]+)$', '1/\1^\2');
  -- 1/y^-2 -> y^2
  v := regexp_replace(v, '^1/([a-z][a-z0-9_]*)\^\(-([0-9]+)\)$', '\1^\2');
  v := regexp_replace(v, '^1/([a-z][a-z0-9_]*)\^-([0-9]+)$', '\1^\2');
  -- x^0 factors disappear; x^1 becomes x (simple monomial factors only).
  v := regexp_replace(v, '([a-z][a-z0-9_]*)\^0', '', 'g');
  v := regexp_replace(v, '^([a-z][a-z0-9_]*)\^1$', '\1');
  if v = '' then v := '1'; end if;

  return v;
end;
$$;


-- Mathside V19 — Performance Task teamwork, leaders, and private participation ratings
-- Run after 09-v18-math-autocorrect-canonicalization.sql.

alter table public.mathside_assignments
  add column if not exists collaboration_mode text not null default 'individual';

alter table public.mathside_assignments
  drop constraint if exists mathside_assignments_collaboration_mode_check;
alter table public.mathside_assignments
  add constraint mathside_assignments_collaboration_mode_check
  check (collaboration_mode in ('individual','pair','group'));

alter table public.mathside_assignments
  add column if not exists grouping_creator text not null default 'teacher';

alter table public.mathside_assignments
  drop constraint if exists mathside_assignments_grouping_creator_check;
alter table public.mathside_assignments
  add constraint mathside_assignments_grouping_creator_check
  check (grouping_creator in ('teacher','students'));

alter table public.mathside_assignments
  add column if not exists group_count integer;

alter table public.mathside_assignments
  drop constraint if exists mathside_assignments_group_count_check;
alter table public.mathside_assignments
  add constraint mathside_assignments_group_count_check
  check (group_count is null or group_count between 1 and 100);

create table if not exists public.mathside_performance_groups (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.mathside_assignments(id) on delete cascade,
  section_id uuid not null references public.mathside_sections(id) on delete cascade,
  name text not null,
  leader_id uuid references public.mathside_profiles(id) on delete set null,
  created_by text not null default 'teacher' check (created_by in ('teacher','students')),
  created_at timestamptz not null default now()
);

create index if not exists mathside_performance_groups_assignment_idx
  on public.mathside_performance_groups(assignment_id);

create table if not exists public.mathside_performance_group_members (
  group_id uuid not null references public.mathside_performance_groups(id) on delete cascade,
  assignment_id uuid not null references public.mathside_assignments(id) on delete cascade,
  student_id uuid not null references public.mathside_profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('leader','member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, student_id),
  unique (assignment_id, student_id)
);

create index if not exists mathside_performance_members_assignment_idx
  on public.mathside_performance_group_members(assignment_id, student_id);

create table if not exists public.mathside_performance_participation_ratings (
  assignment_id uuid not null references public.mathside_assignments(id) on delete cascade,
  group_id uuid not null references public.mathside_performance_groups(id) on delete cascade,
  leader_id uuid not null references public.mathside_profiles(id) on delete cascade,
  member_id uuid not null references public.mathside_profiles(id) on delete cascade,
  rating integer not null check (rating between 1 and 5),
  updated_at timestamptz not null default now(),
  primary key (assignment_id, member_id)
);

alter table public.mathside_performance_groups enable row level security;
alter table public.mathside_performance_group_members enable row level security;
alter table public.mathside_performance_participation_ratings enable row level security;

-- Team details are intentionally exposed through the RPC functions below so
-- private leader ratings are never generally readable through the REST table API.
revoke all on public.mathside_performance_groups from anon, authenticated;
revoke all on public.mathside_performance_group_members from anon, authenticated;
revoke all on public.mathside_performance_participation_ratings from anon, authenticated;

create or replace function mathside_private.performance_assignment_teacher(p_assignment_id uuid, p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.mathside_assignments a
    where a.id = p_assignment_id and a.teacher_id = p_uid
  );
$$;

create or replace function mathside_private.student_in_performance_group(p_group_id uuid, p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.mathside_performance_group_members gm
    where gm.group_id = p_group_id and gm.student_id = p_uid
  );
$$;

create or replace function public.mathside_generate_performance_groups(
  p_assignment_id uuid,
  p_group_count integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_assignment public.mathside_assignments;
  v_students uuid[];
  v_student uuid;
  v_total integer := 0;
  v_count integer := 0;
  v_idx integer := 0;
  v_target integer;
  v_group_ids uuid[] := '{}';
  v_group_id uuid;
  v_name text;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  select * into v_assignment from public.mathside_assignments where id = p_assignment_id;
  if v_assignment.id is null then raise exception 'Performance task not found.'; end if;
  if v_assignment.teacher_id <> v_uid or not mathside_private.is_teacher(v_uid) then
    raise exception 'Only the teacher can generate teams.';
  end if;
  if coalesce(v_assignment.work_type,'written_work') <> 'performance_task' then
    raise exception 'This is not a performance task.';
  end if;

  delete from public.mathside_performance_groups where assignment_id = p_assignment_id;
  if coalesce(v_assignment.collaboration_mode,'individual') = 'individual' then
    return jsonb_build_object('groups',0,'students',0);
  end if;

  select coalesce(array_agg(sm.student_id order by p.display_name, sm.student_id), '{}'), count(*)
    into v_students, v_total
  from public.mathside_section_members sm
  join public.mathside_profiles p on p.id = sm.student_id
  where sm.section_id = v_assignment.section_id;

  if v_total = 0 then return jsonb_build_object('groups',0,'students',0); end if;

  if v_assignment.collaboration_mode = 'pair' then
    v_count := ceil(v_total / 2.0)::integer;
  else
    v_count := coalesce(p_group_count, v_assignment.group_count, 1);
    v_count := greatest(1, least(v_total, v_count));
  end if;

  for v_idx in 1..v_count loop
    v_name := case when v_assignment.collaboration_mode = 'pair' then 'Pair ' else 'Group ' end || v_idx::text;
    insert into public.mathside_performance_groups(assignment_id,section_id,name,created_by)
    values(p_assignment_id,v_assignment.section_id,v_name,'teacher')
    returning id into v_group_id;
    v_group_ids := array_append(v_group_ids,v_group_id);
  end loop;

  v_idx := 0;
  foreach v_student in array v_students loop
    v_target := mod(v_idx, v_count) + 1;
    v_group_id := v_group_ids[v_target];
    insert into public.mathside_performance_group_members(group_id,assignment_id,student_id,role)
    values(v_group_id,p_assignment_id,v_student,case when v_idx < v_count then 'leader' else 'member' end);
    if v_idx < v_count then
      update public.mathside_performance_groups set leader_id = v_student where id = v_group_id;
    end if;
    v_idx := v_idx + 1;
  end loop;

  return jsonb_build_object('groups',v_count,'students',v_total);
end;
$$;

create or replace function public.mathside_get_performance_team(
  p_assignment_id uuid,
  p_student_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_assignment public.mathside_assignments;
  v_student_id uuid;
  v_group public.mathside_performance_groups;
  v_members jsonb := '[]'::jsonb;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  select * into v_assignment from public.mathside_assignments where id = p_assignment_id;
  if v_assignment.id is null then raise exception 'Performance task not found.'; end if;

  if p_student_id is not null and p_student_id <> v_uid then
    if v_assignment.teacher_id <> v_uid then raise exception 'You cannot view this team.'; end if;
    v_student_id := p_student_id;
  else
    v_student_id := v_uid;
    if v_assignment.teacher_id <> v_uid and not mathside_private.student_in_section(v_assignment.section_id, v_uid) then
      raise exception 'This performance task is not assigned to you.';
    end if;
  end if;

  if coalesce(v_assignment.collaboration_mode,'individual') = 'individual' then
    return jsonb_build_object(
      'mode','individual','grouping_creator',coalesce(v_assignment.grouping_creator,'teacher'),
      'group_count',v_assignment.group_count,'group',null,'leader_id',null,
      'is_leader',false,'members','[]'::jsonb
    );
  end if;

  select g.* into v_group
  from public.mathside_performance_group_members gm
  join public.mathside_performance_groups g on g.id = gm.group_id
  where gm.assignment_id = p_assignment_id and gm.student_id = v_student_id
  limit 1;

  if v_group.id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id,
      'display_name', p.display_name,
      'role', gm.role
    ) order by case when gm.role='leader' then 0 else 1 end, p.display_name), '[]'::jsonb)
    into v_members
    from public.mathside_performance_group_members gm
    join public.mathside_profiles p on p.id = gm.student_id
    where gm.group_id = v_group.id;
  end if;

  return jsonb_build_object(
    'mode',coalesce(v_assignment.collaboration_mode,'individual'),
    'grouping_creator',coalesce(v_assignment.grouping_creator,'teacher'),
    'group_count',v_assignment.group_count,
    'group',case when v_group.id is null then null else jsonb_build_object('id',v_group.id,'name',v_group.name) end,
    'leader_id',v_group.leader_id,
    'is_leader',v_group.leader_id = v_uid,
    'members',v_members
  );
end;
$$;

create or replace function public.mathside_get_available_groupmates(p_assignment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_assignment public.mathside_assignments;
  v_total integer := 0;
  v_max_members integer := 2;
  v_students jsonb := '[]'::jsonb;
begin
  if v_uid is null or not mathside_private.is_student(v_uid) then raise exception 'Student account required.'; end if;
  select * into v_assignment from public.mathside_assignments where id=p_assignment_id and status='published';
  if v_assignment.id is null then raise exception 'Performance task not found.'; end if;
  if coalesce(v_assignment.work_type,'written_work') <> 'performance_task'
     or coalesce(v_assignment.collaboration_mode,'individual') = 'individual'
     or coalesce(v_assignment.grouping_creator,'teacher') <> 'students' then
    raise exception 'Student-created teams are not enabled for this task.';
  end if;
  if not mathside_private.student_in_section(v_assignment.section_id,v_uid) then raise exception 'This task is not assigned to you.'; end if;
  if exists(select 1 from public.mathside_performance_group_members where assignment_id=p_assignment_id and student_id=v_uid) then
    return jsonb_build_object('students','[]'::jsonb,'max_members',2);
  end if;

  select count(*) into v_total from public.mathside_section_members where section_id=v_assignment.section_id;
  if v_assignment.collaboration_mode='pair' then
    v_max_members := 2;
  else
    v_max_members := greatest(2, ceil(v_total::numeric / greatest(1,coalesce(v_assignment.group_count,1)))::integer);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'display_name',p.display_name) order by p.display_name),'[]'::jsonb)
  into v_students
  from public.mathside_section_members sm
  join public.mathside_profiles p on p.id=sm.student_id
  where sm.section_id=v_assignment.section_id
    and sm.student_id<>v_uid
    and not exists(
      select 1 from public.mathside_performance_group_members gm
      where gm.assignment_id=p_assignment_id and gm.student_id=sm.student_id
    );

  return jsonb_build_object('students',v_students,'max_members',v_max_members);
end;
$$;

create or replace function public.mathside_create_student_performance_team(
  p_assignment_id uuid,
  p_member_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_assignment public.mathside_assignments;
  v_total integer := 0;
  v_max_members integer := 2;
  v_selected integer := coalesce(array_length(p_member_ids,1),0);
  v_member uuid;
  v_group_id uuid;
  v_group_number integer;
  v_name text;
begin
  if v_uid is null or not mathside_private.is_student(v_uid) then raise exception 'Student account required.'; end if;
  select * into v_assignment from public.mathside_assignments where id=p_assignment_id and status='published';
  if v_assignment.id is null then raise exception 'Performance task not found.'; end if;
  if coalesce(v_assignment.grouping_creator,'teacher') <> 'students' or coalesce(v_assignment.collaboration_mode,'individual')='individual' then
    raise exception 'Student-created teams are not enabled for this task.';
  end if;
  if not mathside_private.student_in_section(v_assignment.section_id,v_uid) then raise exception 'This task is not assigned to you.'; end if;
  if exists(select 1 from public.mathside_performance_group_members where assignment_id=p_assignment_id and student_id=v_uid) then
    raise exception 'You already belong to a team for this task.';
  end if;

  select count(*) into v_total from public.mathside_section_members where section_id=v_assignment.section_id;
  if v_assignment.collaboration_mode='pair' then
    v_max_members := 2;
    if v_selected <> 1 then raise exception 'Choose exactly one classmate for your pair.'; end if;
  else
    v_max_members := greatest(2, ceil(v_total::numeric / greatest(1,coalesce(v_assignment.group_count,1)))::integer);
    if v_selected < 1 or v_selected > v_max_members-1 then
      raise exception 'Choose between 1 and % classmates for this group.', v_max_members-1;
    end if;
  end if;

  foreach v_member in array p_member_ids loop
    if v_member = v_uid then raise exception 'You are already included as the team leader.'; end if;
    if not exists(select 1 from public.mathside_section_members where section_id=v_assignment.section_id and student_id=v_member) then
      raise exception 'One selected student is not available for this team.';
    end if;
    if exists(select 1 from public.mathside_performance_group_members where assignment_id=p_assignment_id and student_id=v_member) then
      raise exception 'One selected student already belongs to another team.';
    end if;
  end loop;

  select count(*)+1 into v_group_number from public.mathside_performance_groups where assignment_id=p_assignment_id;
  v_name := case when v_assignment.collaboration_mode='pair' then 'Pair ' else 'Group ' end || v_group_number::text;
  insert into public.mathside_performance_groups(assignment_id,section_id,name,leader_id,created_by)
  values(p_assignment_id,v_assignment.section_id,v_name,v_uid,'students') returning id into v_group_id;
  insert into public.mathside_performance_group_members(group_id,assignment_id,student_id,role)
  values(v_group_id,p_assignment_id,v_uid,'leader');
  foreach v_member in array p_member_ids loop
    insert into public.mathside_performance_group_members(group_id,assignment_id,student_id,role)
    values(v_group_id,p_assignment_id,v_member,'member');
  end loop;
  return jsonb_build_object('group_id',v_group_id,'name',v_name);
end;
$$;

create or replace function public.mathside_save_participation_ratings(
  p_assignment_id uuid,
  p_group_id uuid,
  p_ratings jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_item jsonb;
  v_member uuid;
  v_rating integer;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not exists(
    select 1 from public.mathside_performance_groups g
    where g.id=p_group_id and g.assignment_id=p_assignment_id and g.leader_id=v_uid
  ) then raise exception 'Only the team leader can save participation ratings.'; end if;

  for v_item in select value from jsonb_array_elements(coalesce(p_ratings,'[]'::jsonb)) loop
    begin v_member := (v_item->>'member_id')::uuid; exception when others then raise exception 'Invalid member rating.'; end;
    v_rating := (v_item->>'rating')::integer;
    if v_rating not between 1 and 5 then raise exception 'Ratings must be from 1 to 5.'; end if;
    if v_member=v_uid or not exists(select 1 from public.mathside_performance_group_members where group_id=p_group_id and student_id=v_member) then
      raise exception 'Invalid team member rating.';
    end if;
    insert into public.mathside_performance_participation_ratings(assignment_id,group_id,leader_id,member_id,rating,updated_at)
    values(p_assignment_id,p_group_id,v_uid,v_member,v_rating,now())
    on conflict(assignment_id,member_id) do update set
      group_id=excluded.group_id, leader_id=excluded.leader_id, rating=excluded.rating, updated_at=now();
  end loop;
end;
$$;

create or replace function public.mathside_get_participation_ratings(
  p_assignment_id uuid,
  p_group_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_allowed boolean := false;
  v_data jsonb := '[]'::jsonb;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  select (
    a.teacher_id=v_uid or g.leader_id=v_uid
  ) into v_allowed
  from public.mathside_performance_groups g
  join public.mathside_assignments a on a.id=g.assignment_id
  where g.id=p_group_id and g.assignment_id=p_assignment_id;
  if not coalesce(v_allowed,false) then raise exception 'These participation ratings are private.'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'member_id',r.member_id,
    'display_name',p.display_name,
    'rating',r.rating
  ) order by p.display_name),'[]'::jsonb)
  into v_data
  from public.mathside_performance_participation_ratings r
  join public.mathside_profiles p on p.id=r.member_id
  where r.assignment_id=p_assignment_id and r.group_id=p_group_id;
  return v_data;
end;
$$;

-- If the teacher changes the collaboration setup, remove old team records so
-- they cannot conflict with the new setup. Teacher-generated teams are rebuilt
-- by mathside_generate_performance_groups immediately after save.
create or replace function mathside_private.reset_performance_groups_on_setup_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.collaboration_mode is distinct from new.collaboration_mode
     or old.grouping_creator is distinct from new.grouping_creator
     or old.group_count is distinct from new.group_count then
    delete from public.mathside_performance_groups where assignment_id=new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists mathside_performance_setup_reset on public.mathside_assignments;
create trigger mathside_performance_setup_reset
after update of collaboration_mode, grouping_creator, group_count on public.mathside_assignments
for each row execute function mathside_private.reset_performance_groups_on_setup_change();

-- Replace the submission RPC so collaborative performance-task output can only
-- be submitted by the saved team leader. Individual activities keep their
-- existing behavior and math auto-correct normalization.
create or replace function public.mathside_submit_work(
  p_assignment_id uuid,
  p_answers jsonb default '[]'::jsonb,
  p_proof_paths jsonb default '[]'::jsonb
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
  v_paths jsonb := case when jsonb_typeof(coalesce(p_proof_paths,'[]'::jsonb))='array' then coalesce(p_proof_paths,'[]'::jsonb) else '[]'::jsonb end;
  v_first_path text;
  v_path_item text;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if not mathside_private.is_student(v_uid) then raise exception 'Only student accounts can submit classwork.'; end if;

  select * into v_assignment
  from public.mathside_assignments
  where id = p_assignment_id and status = 'published';
  if v_assignment.id is null then raise exception 'This activity is closed or archived.'; end if;
  if not mathside_private.student_in_section(v_assignment.section_id, v_uid) then
    raise exception 'This classwork is not assigned to your section.';
  end if;

  if coalesce(v_assignment.work_type,'written_work')='performance_task'
     and coalesce(v_assignment.collaboration_mode,'individual') <> 'individual'
     and not exists(
       select 1 from public.mathside_performance_groups g
       where g.assignment_id=p_assignment_id and g.leader_id=v_uid
     ) then
    raise exception 'Only your team leader can submit this performance task.';
  end if;

  if jsonb_array_length(v_paths) < 1 then raise exception 'Upload at least one solution or output picture before submitting.'; end if;
  if jsonb_array_length(v_paths) > 10 then raise exception 'Choose up to 10 uploaded pictures for one submission.'; end if;

  for v_path_item in select elem #>> '{}' from jsonb_array_elements(v_paths) as supplied_path(elem) loop
    if v_path_item is null or v_path_item not like v_uid::text || '/' || p_assignment_id::text || '/%' then
      raise exception 'Invalid upload path for this submission.';
    end if;
  end loop;

  select elem #>> '{}' into v_first_path from jsonb_array_elements(v_paths) as path_item(elem) limit 1;

  select * into v_existing from public.mathside_submissions
  where assignment_id = p_assignment_id and student_id = v_uid for update;

  if v_existing.id is not null then
    if not v_assignment.allow_resubmission then raise exception 'This classwork has already been submitted.'; end if;
    if not coalesce(v_existing.resubmit_allowed,false) then raise exception 'Your teacher has not allowed another attempt yet.'; end if;
    v_submission_id := v_existing.id;
    v_attempt := v_existing.attempt_count + 1;
    delete from public.mathside_submission_answers where submission_id = v_submission_id;
    update public.mathside_submissions
    set status='submitted', proof_path=v_first_path, proof_paths=v_paths,
        auto_score=0, teacher_score=null, feedback=null,
        attempt_count=v_attempt, submitted_at=now(), graded_at=null, graded_by=null,
        resubmit_allowed=false, updated_at=now()
    where id=v_submission_id;
  else
    insert into public.mathside_submissions(assignment_id,student_id,proof_path,proof_paths,status,resubmit_allowed)
    values(p_assignment_id,v_uid,v_first_path,v_paths,'submitted',false)
    returning id into v_submission_id;
  end if;

  for v_answer in select value from jsonb_array_elements(coalesce(p_answers,'[]'::jsonb)) loop
    select q.* into v_question from public.mathside_questions q
    where q.id = mathside_private.safe_uuid(v_answer->>'question_id') and q.assignment_id = p_assignment_id;
    if v_question.id is null then continue; end if;
    select k.correct_answer into v_key from public.mathside_question_keys k where k.question_id=v_question.id;
    v_text := coalesce(v_answer->>'answer','');
    v_correct := length(mathside_private.normalize_math_answer(v_key)) > 0
      and mathside_private.normalize_math_answer(v_text) = mathside_private.normalize_math_answer(v_key);
    insert into public.mathside_submission_answers(submission_id,question_id,answer_text,is_correct,manual_is_correct,awarded_points)
    values(v_submission_id,v_question.id,v_text,v_correct,null,case when v_correct then v_question.max_points else 0 end);
    if v_correct then v_auto_score := v_auto_score + v_question.max_points; end if;
  end loop;

  update public.mathside_submissions set auto_score=v_auto_score, updated_at=now() where id=v_submission_id;
  return jsonb_build_object('submission_id',v_submission_id,'auto_score',v_auto_score,'attempt_count',v_attempt,'proof_paths',v_paths);
end;
$$;

revoke all on function public.mathside_generate_performance_groups(uuid,integer) from public, anon;
revoke all on function public.mathside_get_performance_team(uuid,uuid) from public, anon;
revoke all on function public.mathside_get_available_groupmates(uuid) from public, anon;
revoke all on function public.mathside_create_student_performance_team(uuid,uuid[]) from public, anon;
revoke all on function public.mathside_save_participation_ratings(uuid,uuid,jsonb) from public, anon;
revoke all on function public.mathside_get_participation_ratings(uuid,uuid) from public, anon;
revoke all on function public.mathside_submit_work(uuid,jsonb,jsonb) from public, anon;

grant execute on function public.mathside_generate_performance_groups(uuid,integer) to authenticated;
grant execute on function public.mathside_get_performance_team(uuid,uuid) to authenticated;
grant execute on function public.mathside_get_available_groupmates(uuid) to authenticated;
grant execute on function public.mathside_create_student_performance_team(uuid,uuid[]) to authenticated;
grant execute on function public.mathside_save_participation_ratings(uuid,uuid,jsonb) to authenticated;
grant execute on function public.mathside_get_participation_ratings(uuid,uuid) to authenticated;
grant execute on function public.mathside_submit_work(uuid,jsonb,jsonb) to authenticated;


-- Mathside Step 6.9.7
-- Allow a teacher to reuse/enroll students from any class they own, active or archived.
-- Keeps the existing RPC name so older deployed clients stay compatible.

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
  if v_source.id = v_target.id then raise exception 'Choose a different source class.'; end if;
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


-- Mathside v21 — Teacher-selected leaders for teacher-created Performance Task teams.
-- Run once after 10-v19-performance-teamwork.sql.

create or replace function public.mathside_set_performance_group_leaders(
  p_assignment_id uuid,
  p_leaders jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_assignment public.mathside_assignments;
  v_item jsonb;
  v_group_id uuid;
  v_group_name text;
  v_leader_id uuid;
  v_updated integer := 0;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  select * into v_assignment from public.mathside_assignments where id = p_assignment_id;
  if v_assignment.id is null then raise exception 'Performance task not found.'; end if;
  if v_assignment.teacher_id <> v_uid or not mathside_private.is_teacher(v_uid) then
    raise exception 'Only the teacher can choose team leaders.';
  end if;
  if coalesce(v_assignment.work_type,'written_work') <> 'performance_task' then
    raise exception 'This is not a performance task.';
  end if;
  if coalesce(v_assignment.grouping_creator,'teacher') <> 'teacher' then
    raise exception 'Leaders can be assigned here only for teacher-created teams.';
  end if;
  if jsonb_typeof(coalesce(p_leaders,'[]'::jsonb)) <> 'array' then
    raise exception 'Leader choices must be an array.';
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(p_leaders,'[]'::jsonb)) loop
    v_group_name := nullif(trim(v_item->>'group_name'),'');
    begin
      v_leader_id := nullif(v_item->>'leader_id','')::uuid;
    exception when others then
      raise exception 'Invalid leader selection.';
    end;
    if v_group_name is null or v_leader_id is null then
      raise exception 'Every group needs a leader.';
    end if;

    select g.id into v_group_id
    from public.mathside_performance_groups g
    where g.assignment_id = p_assignment_id and g.name = v_group_name
    limit 1;
    if v_group_id is null then raise exception 'Team % was not found.', v_group_name; end if;

    if not exists (
      select 1 from public.mathside_performance_group_members gm
      where gm.group_id = v_group_id and gm.student_id = v_leader_id
    ) then
      raise exception 'The selected leader must belong to %.', v_group_name;
    end if;

    update public.mathside_performance_group_members
      set role = case when student_id = v_leader_id then 'leader' else 'member' end
      where group_id = v_group_id;
    update public.mathside_performance_groups
      set leader_id = v_leader_id
      where id = v_group_id;
    v_updated := v_updated + 1;
  end loop;

  return jsonb_build_object('updated_groups',v_updated);
end;
$$;

grant execute on function public.mathside_set_performance_group_leaders(uuid,jsonb) to authenticated;


-- Mathside v22 — Student-created teams with teacher-selected leaders.
-- Run once after 10-v19-performance-teamwork.sql and 12-v21-performance-team-leader-choice.sql.

-- Students may form their own teams, but the creator is no longer automatically
-- made the leader. The teacher chooses the leader after the team is formed.
create or replace function public.mathside_create_student_performance_team(
  p_assignment_id uuid,
  p_member_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_assignment public.mathside_assignments;
  v_total integer := 0;
  v_max_members integer := 2;
  v_selected integer := coalesce(array_length(p_member_ids,1),0);
  v_member uuid;
  v_group_id uuid;
  v_group_number integer;
  v_name text;
begin
  if v_uid is null or not mathside_private.is_student(v_uid) then raise exception 'Student account required.'; end if;
  select * into v_assignment from public.mathside_assignments where id=p_assignment_id and status='published';
  if v_assignment.id is null then raise exception 'Performance task not found.'; end if;
  if coalesce(v_assignment.grouping_creator,'teacher') <> 'students' or coalesce(v_assignment.collaboration_mode,'individual')='individual' then
    raise exception 'Student-created teams are not enabled for this task.';
  end if;
  if not mathside_private.student_in_section(v_assignment.section_id,v_uid) then raise exception 'This task is not assigned to you.'; end if;
  if exists(select 1 from public.mathside_performance_group_members where assignment_id=p_assignment_id and student_id=v_uid) then
    raise exception 'You already belong to a team for this task.';
  end if;

  select count(*) into v_total from public.mathside_section_members where section_id=v_assignment.section_id;
  if v_assignment.collaboration_mode='pair' then
    v_max_members := 2;
    if v_selected <> 1 then raise exception 'Choose exactly one classmate for your pair.'; end if;
  else
    v_max_members := greatest(2, ceil(v_total::numeric / greatest(1,coalesce(v_assignment.group_count,1)))::integer);
    if v_selected < 1 or v_selected > v_max_members-1 then
      raise exception 'Choose between 1 and % classmates for this group.', v_max_members-1;
    end if;
  end if;

  foreach v_member in array p_member_ids loop
    if v_member = v_uid then raise exception 'You are already included in your team.'; end if;
    if not exists(select 1 from public.mathside_section_members where section_id=v_assignment.section_id and student_id=v_member) then
      raise exception 'One selected student is not available for this team.';
    end if;
    if exists(select 1 from public.mathside_performance_group_members where assignment_id=p_assignment_id and student_id=v_member) then
      raise exception 'One selected student already belongs to another team.';
    end if;
  end loop;

  select count(*)+1 into v_group_number from public.mathside_performance_groups where assignment_id=p_assignment_id;
  v_name := case when v_assignment.collaboration_mode='pair' then 'Pair ' else 'Group ' end || v_group_number::text;

  insert into public.mathside_performance_groups(assignment_id,section_id,name,leader_id,created_by)
  values(p_assignment_id,v_assignment.section_id,v_name,null,'students') returning id into v_group_id;

  insert into public.mathside_performance_group_members(group_id,assignment_id,student_id,role)
  values(v_group_id,p_assignment_id,v_uid,'member');

  foreach v_member in array p_member_ids loop
    insert into public.mathside_performance_group_members(group_id,assignment_id,student_id,role)
    values(v_group_id,p_assignment_id,v_member,'member');
  end loop;

  return jsonb_build_object('group_id',v_group_id,'name',v_name,'leader_id',null);
end;
$$;

-- Allow the teacher to select leaders for either teacher-created or
-- student-created teams. Accept group_id (preferred) or group_name.
create or replace function public.mathside_set_performance_group_leaders(
  p_assignment_id uuid,
  p_leaders jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_assignment public.mathside_assignments;
  v_item jsonb;
  v_group_id uuid;
  v_group_name text;
  v_leader_id uuid;
  v_updated integer := 0;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  select * into v_assignment from public.mathside_assignments where id = p_assignment_id;
  if v_assignment.id is null then raise exception 'Performance task not found.'; end if;
  if v_assignment.teacher_id <> v_uid or not mathside_private.is_teacher(v_uid) then
    raise exception 'Only the teacher can choose team leaders.';
  end if;
  if coalesce(v_assignment.work_type,'written_work') <> 'performance_task' then
    raise exception 'This is not a performance task.';
  end if;
  if jsonb_typeof(coalesce(p_leaders,'[]'::jsonb)) <> 'array' then
    raise exception 'Leader choices must be an array.';
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(p_leaders,'[]'::jsonb)) loop
    v_group_id := null;
    v_group_name := nullif(trim(v_item->>'group_name'),'');
    begin
      if nullif(v_item->>'group_id','') is not null then
        v_group_id := (v_item->>'group_id')::uuid;
      end if;
      v_leader_id := nullif(v_item->>'leader_id','')::uuid;
    exception when others then
      raise exception 'Invalid team or leader selection.';
    end;

    if v_leader_id is null then raise exception 'Every selected team needs a leader.'; end if;

    if v_group_id is not null then
      select g.id, g.name into v_group_id, v_group_name
      from public.mathside_performance_groups g
      where g.id = v_group_id and g.assignment_id = p_assignment_id
      limit 1;
    elsif v_group_name is not null then
      select g.id into v_group_id
      from public.mathside_performance_groups g
      where g.assignment_id = p_assignment_id and g.name = v_group_name
      limit 1;
    else
      raise exception 'A team was not identified.';
    end if;

    if v_group_id is null then raise exception 'The selected team was not found.'; end if;

    if not exists (
      select 1 from public.mathside_performance_group_members gm
      where gm.group_id = v_group_id and gm.student_id = v_leader_id
    ) then
      raise exception 'The selected leader must belong to %.', coalesce(v_group_name,'the team');
    end if;

    update public.mathside_performance_group_members
      set role = case when student_id = v_leader_id then 'leader' else 'member' end
      where group_id = v_group_id;

    update public.mathside_performance_groups
      set leader_id = v_leader_id
      where id = v_group_id;

    v_updated := v_updated + 1;
  end loop;

  return jsonb_build_object('updated_groups',v_updated);
end;
$$;

-- Teacher-only team roster for choosing leaders after students form teams.
create or replace function public.mathside_get_performance_groups_for_teacher(
  p_assignment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_assignment public.mathside_assignments;
  v_groups jsonb;
  v_ungrouped jsonb;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  select * into v_assignment from public.mathside_assignments where id = p_assignment_id;
  if v_assignment.id is null then raise exception 'Performance task not found.'; end if;
  if v_assignment.teacher_id <> v_uid or not mathside_private.is_teacher(v_uid) then
    raise exception 'Only the teacher can view all teams.';
  end if;

  select coalesce(jsonb_agg(group_row order by group_row->>'name'),'[]'::jsonb)
    into v_groups
  from (
    select jsonb_build_object(
      'id', g.id,
      'name', g.name,
      'leader_id', g.leader_id,
      'created_by', g.created_by,
      'members', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id,
            'display_name', p.display_name,
            'role', gm.role
          ) order by p.display_name, p.id
        )
        from public.mathside_performance_group_members gm
        join public.mathside_profiles p on p.id = gm.student_id
        where gm.group_id = g.id
      ),'[]'::jsonb)
    ) as group_row
    from public.mathside_performance_groups g
    where g.assignment_id = p_assignment_id
  ) q;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id,
      'display_name', p.display_name
    ) order by p.display_name, p.id),'[]'::jsonb)
    into v_ungrouped
  from public.mathside_section_members sm
  join public.mathside_profiles p on p.id = sm.student_id
  where sm.section_id = v_assignment.section_id
    and not exists (
      select 1
      from public.mathside_performance_group_members gm
      where gm.assignment_id = p_assignment_id and gm.student_id = sm.student_id
    );

  return jsonb_build_object(
    'groups', coalesce(v_groups,'[]'::jsonb),
    'ungrouped', coalesce(v_ungrouped,'[]'::jsonb)
  );
end;
$$;

revoke all on function public.mathside_create_student_performance_team(uuid,uuid[]) from public, anon;
revoke all on function public.mathside_set_performance_group_leaders(uuid,jsonb) from public, anon;
revoke all on function public.mathside_get_performance_groups_for_teacher(uuid) from public, anon;

grant execute on function public.mathside_create_student_performance_team(uuid,uuid[]) to authenticated;
grant execute on function public.mathside_set_performance_group_leaders(uuid,jsonb) to authenticated;
grant execute on function public.mathside_get_performance_groups_for_teacher(uuid) to authenticated;


create or replace function public.mathside_set_teacher_performance_groups(
  p_assignment_id uuid,
  p_groups jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_assignment public.mathside_assignments;
  v_section_students uuid[] := '{}'::uuid[];
  v_seen uuid[] := '{}'::uuid[];
  v_group_members uuid[] := '{}'::uuid[];
  v_group_names text[] := '{}'::text[];
  v_group jsonb;
  v_member_text text;
  v_member uuid;
  v_leader uuid;
  v_group_id uuid;
  v_name text;
  v_total integer := 0;
  v_expected_groups integer := 0;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  select * into v_assignment from public.mathside_assignments where id = p_assignment_id;
  if v_assignment.id is null then raise exception 'Performance task not found.'; end if;
  if v_assignment.teacher_id <> v_uid or not mathside_private.is_teacher(v_uid) then
    raise exception 'Only the teacher can save performance groups.';
  end if;
  if coalesce(v_assignment.work_type, 'written_work') <> 'performance_task' then
    raise exception 'This is not a performance task.';
  end if;
  if coalesce(v_assignment.collaboration_mode, 'individual') = 'individual'
     or coalesce(v_assignment.grouping_creator, 'teacher') <> 'teacher' then
    raise exception 'Teacher-created pair or group mode is required.';
  end if;
  if jsonb_typeof(coalesce(p_groups, '[]'::jsonb)) <> 'array' then
    raise exception 'Groups must be an array.';
  end if;
  select coalesce(array_agg(sm.student_id order by sm.student_id), '{}'::uuid[]), count(*)
    into v_section_students, v_total
  from public.mathside_section_members sm
  where sm.section_id = v_assignment.section_id;
  if v_total = 0 then
    delete from public.mathside_performance_groups where assignment_id = p_assignment_id;
    return jsonb_build_object('groups', 0, 'students', 0);
  end if;
  if coalesce(v_assignment.collaboration_mode, 'individual') = 'pair' then
    v_expected_groups := ceil(v_total / 2.0)::integer;
  else
    v_expected_groups := greatest(1, least(v_total, coalesce(v_assignment.group_count, 1)));
  end if;
  if jsonb_array_length(p_groups) <> v_expected_groups then
    raise exception 'Expected % groups but received %.', v_expected_groups, jsonb_array_length(p_groups);
  end if;
  for v_group in select value from jsonb_array_elements(p_groups) loop
    v_name := nullif(btrim(v_group->>'name'), '');
    if v_name is null then raise exception 'Every group needs a name.'; end if;
    if v_name = any(v_group_names) then raise exception 'Duplicate group name: %.', v_name; end if;
    v_group_names := array_append(v_group_names, v_name);
    if jsonb_typeof(v_group->'member_ids') <> 'array' or jsonb_array_length(v_group->'member_ids') = 0 then
      raise exception '% must contain at least one learner.', v_name;
    end if;
    begin
      v_leader := nullif(v_group->>'leader_id', '')::uuid;
    exception when others then
      raise exception 'Invalid leader for %.', v_name;
    end;
    if v_leader is null then raise exception 'Choose a leader for %.', v_name; end if;
    v_group_members := '{}'::uuid[];
    for v_member_text in select value from jsonb_array_elements_text(v_group->'member_ids') loop
      begin
        v_member := v_member_text::uuid;
      exception when others then
        raise exception 'Invalid learner in %.', v_name;
      end;
      if not (v_member = any(v_section_students)) then raise exception 'A learner in % is no longer enrolled in this class.', v_name; end if;
      if v_member = any(v_seen) then raise exception 'A learner appears in more than one group.'; end if;
      v_seen := array_append(v_seen, v_member);
      v_group_members := array_append(v_group_members, v_member);
    end loop;
    if not (v_leader = any(v_group_members)) then raise exception 'The selected leader must belong to %.', v_name; end if;
  end loop;
  if cardinality(v_seen) <> v_total then raise exception 'Every enrolled learner must appear in exactly one group.'; end if;
  delete from public.mathside_performance_groups where assignment_id = p_assignment_id;
  for v_group in select value from jsonb_array_elements(p_groups) loop
    v_name := btrim(v_group->>'name');
    v_leader := (v_group->>'leader_id')::uuid;
    insert into public.mathside_performance_groups(assignment_id, section_id, name, created_by, leader_id)
    values(p_assignment_id, v_assignment.section_id, v_name, 'teacher', v_leader)
    returning id into v_group_id;
    for v_member_text in select value from jsonb_array_elements_text(v_group->'member_ids') loop
      v_member := v_member_text::uuid;
      insert into public.mathside_performance_group_members(group_id, assignment_id, student_id, role)
      values(v_group_id, p_assignment_id, v_member, case when v_member = v_leader then 'leader' else 'member' end);
    end loop;
  end loop;
  return jsonb_build_object('groups', jsonb_array_length(p_groups), 'students', v_total);
end;
$$;
revoke all on function public.mathside_set_teacher_performance_groups(uuid,jsonb) from public, anon;
grant execute on function public.mathside_set_teacher_performance_groups(uuid,jsonb) to authenticated;


-- Mathside V24.19: class-based performance projects.
-- Run AFTER existing Mathside SQL migrations 01-19 in Supabase SQL Editor.
-- Before running: back up your database. Do not re-run old schema setup files afterward.
-- Does not remove older assignments, student submissions, scores, or history.
begin;

alter table public.mathside_assignments
  drop constraint if exists mathside_assignments_collaboration_mode_check;
alter table public.mathside_assignments
  add constraint mathside_assignments_collaboration_mode_check
  check (collaboration_mode in ('individual','pair','group','class'));

alter table public.mathside_submissions
  add column if not exists is_class_mirror boolean not null default false;
alter table public.mathside_submissions
  add column if not exists class_video_url text;
alter table public.mathside_submissions
  add column if not exists class_project_url text;

create table if not exists public.mathside_class_score_overrides (
  assignment_id uuid not null references public.mathside_assignments(id) on delete cascade,
  student_id uuid not null references public.mathside_profiles(id) on delete cascade,
  score numeric(10,2) not null check (score >= 0),
  changed_by uuid not null references public.mathside_profiles(id),
  changed_at timestamptz not null default now(),
  primary key (assignment_id, student_id)
);
alter table public.mathside_class_score_overrides enable row level security;
revoke all on public.mathside_class_score_overrides from anon, authenticated;

-- Keep past work safe: a task with submissions may not be converted to or from
-- whole-class collaboration, which would otherwise reassign scores.
create or replace function mathside_private.protect_class_assignment_setup()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (old.collaboration_mode = 'class' or new.collaboration_mode = 'class')
     and (old.collaboration_mode is distinct from new.collaboration_mode
          or old.grouping_creator is distinct from new.grouping_creator
          or old.group_count is distinct from new.group_count
          or old.section_id is distinct from new.section_id
          or old.work_type is distinct from new.work_type)
     and exists (select 1 from public.mathside_submissions s where s.assignment_id = old.id) then
    raise exception 'Cannot change the class project setup after students have submitted. Existing scores are protected.';
  end if;
  return new;
end; $$;
drop trigger if exists mathside_protect_class_assignment_setup on public.mathside_assignments;
create trigger mathside_protect_class_assignment_setup
before update of collaboration_mode, grouping_creator, group_count, section_id, work_type
on public.mathside_assignments
for each row execute function mathside_private.protect_class_assignment_setup();

-- Prevent deleting the sole class team after the representative submits.
-- Deleting the entire assignment intentionally still cascades when the teacher
-- explicitly deletes the entire task.
create or replace function mathside_private.protect_class_team_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.mathside_assignments a
             where a.id = old.assignment_id and a.collaboration_mode = 'class')
     and exists (select 1 from public.mathside_submissions s
                 where s.assignment_id=old.assignment_id and s.student_id=old.leader_id
                 and not s.is_class_mirror) then
    raise exception 'This class has already submitted. The class team cannot be rebuilt.';
  end if;
  return old;
end; $$;
drop trigger if exists mathside_protect_class_team_delete on public.mathside_performance_groups;
create trigger mathside_protect_class_team_delete
before delete on public.mathside_performance_groups
for each row execute function mathside_private.protect_class_team_delete();

-- Prevent the class representative being changed once a class submission exists;
-- otherwise the original submission could become detached from its section.
create or replace function mathside_private.protect_class_representative()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.leader_id is distinct from new.leader_id
     and exists (
       select 1 from public.mathside_assignments a
       where a.id = new.assignment_id and a.collaboration_mode = 'class'
     )
     and exists (
       select 1 from public.mathside_submissions s
       where s.assignment_id = new.assignment_id and not s.is_class_mirror
     ) then
    raise exception 'The class representative cannot be changed after the class has submitted. Archive this task and create a new one if needed.';
  end if;
  return new;
end; $$;
drop trigger if exists mathside_protect_class_representative on public.mathside_performance_groups;
create trigger mathside_protect_class_representative
before update of leader_id on public.mathside_performance_groups
for each row execute function mathside_private.protect_class_representative();

-- A single representative submission becomes a read-only record for each learner.
-- The main submission remains the ONLY one shown in the teacher review inbox;
-- mirrored records are visible to students and counted in exports and competencies.
create or replace function mathside_private.sync_class_submission()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_assignment public.mathside_assignments;
  v_leader uuid;
begin
  if new.is_class_mirror then return new; end if;
  select * into v_assignment from public.mathside_assignments where id=new.assignment_id;
  if v_assignment.id is null or v_assignment.work_type <> 'performance_task'
      or v_assignment.collaboration_mode <> 'class' then return new; end if;
  select leader_id into v_leader from public.mathside_performance_groups where assignment_id=new.assignment_id limit 1;
  if v_leader is null or new.student_id <> v_leader then return new; end if;

  if tg_op = 'UPDATE' then
    if new.submitted_at is distinct from old.submitted_at and new.status='submitted' then
      delete from public.mathside_class_score_overrides where assignment_id=new.assignment_id;
    end if;
  end if;

  insert into public.mathside_submissions (
    assignment_id, student_id, status, proof_path, proof_paths, auto_score, teacher_score,
    feedback, attempt_count, submitted_at, graded_at, graded_by, updated_at,
    resubmit_allowed, is_class_mirror, class_video_url, class_project_url
  )
  select new.assignment_id, sm.student_id, new.status, new.proof_path, new.proof_paths,
    new.auto_score,
    case when new.status = 'graded' then coalesce(ov.score,new.teacher_score) else null end,
    new.feedback, new.attempt_count, new.submitted_at, new.graded_at, new.graded_by, now(),
    false, true, new.class_video_url, new.class_project_url
  from public.mathside_section_members sm
  left join public.mathside_class_score_overrides ov
    on ov.assignment_id = new.assignment_id and ov.student_id = sm.student_id
  where sm.section_id = v_assignment.section_id and sm.student_id <> v_leader
  on conflict (assignment_id, student_id) do update
    set status=excluded.status,
        proof_path=excluded.proof_path,
        proof_paths=excluded.proof_paths,
        auto_score=excluded.auto_score,
        teacher_score=excluded.teacher_score,
        feedback=excluded.feedback,
        attempt_count=excluded.attempt_count,
        submitted_at=excluded.submitted_at,
        graded_at=excluded.graded_at,
        graded_by=excluded.graded_by,
        updated_at=now(),
        resubmit_allowed=false,
        is_class_mirror=true,
        class_video_url=excluded.class_video_url,
        class_project_url=excluded.class_project_url;
  return new;
end; $$;
drop trigger if exists mathside_sync_class_submission on public.mathside_submissions;
create trigger mathside_sync_class_submission
  after insert or update of status, proof_paths, proof_path, teacher_score, feedback,
    submitted_at, graded_at, resubmit_allowed, class_video_url, class_project_url
  on public.mathside_submissions
  for each row execute function mathside_private.sync_class_submission();

-- New enrollments get the class project record if the project was already submitted.
create or replace function mathside_private.backfill_class_submission_for_enrollment()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.mathside_submissions (
    assignment_id, student_id, status, proof_path, proof_paths, auto_score,
    teacher_score, feedback, attempt_count, submitted_at, graded_at, graded_by,
    resubmit_allowed, is_class_mirror, class_video_url, class_project_url
  )
  select a.id, new.student_id, rep.status, rep.proof_path, rep.proof_paths, rep.auto_score,
    coalesce(ov.score, rep.teacher_score), rep.feedback, rep.attempt_count,
    rep.submitted_at, rep.graded_at, rep.graded_by, false, true,
    rep.class_video_url, rep.class_project_url
  from public.mathside_assignments a
  join public.mathside_performance_groups g on g.assignment_id=a.id
  join public.mathside_submissions rep on rep.assignment_id=a.id and rep.student_id=g.leader_id
  left join public.mathside_class_score_overrides ov on ov.assignment_id=a.id and ov.student_id=new.student_id
  where a.section_id=new.section_id and a.collaboration_mode='class' and a.work_type='performance_task'
    and new.student_id<>g.leader_id
  on conflict (assignment_id,student_id) do nothing;
  return new;
end; $$;
drop trigger if exists mathside_backfill_class_submission on public.mathside_section_members;
create trigger mathside_backfill_class_submission
  after insert on public.mathside_section_members
  for each row execute function mathside_private.backfill_class_submission_for_enrollment();

-- Only the active class representative can attach video / project links.
create or replace function public.mathside_save_class_submission_links(
  p_assignment_id uuid, p_video_url text default null, p_project_url text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_video text := nullif(btrim(p_video_url),''); v_project text := nullif(btrim(p_project_url),'');
begin
  if v_uid is null or not mathside_private.is_student(v_uid) then raise exception 'Sign in as a student first.'; end if;
  if (v_video is not null and (length(v_video)>2048 or v_video !~* '^https://[^[:space:]/]+')) or
     (v_project is not null and (length(v_project)>2048 or v_project !~* '^https://[^[:space:]/]+')) then
    raise exception 'Video and project URLs must use HTTPS.';
  end if;
  if not exists (
    select 1 from public.mathside_assignments a
    join public.mathside_performance_groups g on g.assignment_id=a.id
    where a.id=p_assignment_id and a.work_type='performance_task' and a.collaboration_mode='class'
      and g.leader_id=v_uid and a.status='published'
  ) then raise exception 'Only the class representative can save project links.'; end if;
  update public.mathside_submissions s
    set class_video_url=v_video, class_project_url=v_project
    where s.assignment_id=p_assignment_id and s.student_id=v_uid and not s.is_class_mirror;
  if not found then raise exception 'Submit the class project before adding links.'; end if;
  return jsonb_build_object('ok',true);
end; $$;
revoke all on function public.mathside_save_class_submission_links(uuid,text,text) from public,anon;
grant execute on function public.mathside_save_class_submission_links(uuid,text,text) to authenticated;

-- Teacher reads the full section roster, base grade and any overrides.
create or replace function public.mathside_get_class_scores(p_assignment_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_assignment public.mathside_assignments; v_leader uuid; v_score numeric(10,2); v_members jsonb;
begin
  select * into v_assignment from public.mathside_assignments where id=p_assignment_id;
  if v_assignment.id is null or v_assignment.teacher_id is distinct from v_uid or
     not mathside_private.is_teacher(v_uid) or v_assignment.collaboration_mode <> 'class' then
    raise exception 'Only the owning teacher can view these class scores.';
  end if;
  select g.leader_id into v_leader from public.mathside_performance_groups g where g.assignment_id=p_assignment_id limit 1;
  select s.teacher_score into v_score from public.mathside_submissions s
   where s.assignment_id=p_assignment_id and s.student_id=v_leader;
  select coalesce(jsonb_agg(jsonb_build_object(
     'id',p.id,'display_name',p.display_name,'score',s.teacher_score,'override',ov.score,
     'representative', p.id=v_leader
   ) order by p.display_name), '[]'::jsonb)
    into v_members
  from public.mathside_section_members sm
  join public.mathside_profiles p on p.id=sm.student_id
  left join public.mathside_submissions s on s.assignment_id=p_assignment_id and s.student_id=sm.student_id
  left join public.mathside_class_score_overrides ov on ov.assignment_id=p_assignment_id and ov.student_id=sm.student_id
  where sm.section_id=v_assignment.section_id;
  return jsonb_build_object('base_score',v_score,'max_points',v_assignment.max_points,'students',v_members);
end; $$;
revoke all on function public.mathside_get_class_scores(uuid) from public,anon;
grant execute on function public.mathside_get_class_scores(uuid) to authenticated;

-- NULL score removes the special adjustment; a numeric score replaces it.
create or replace function public.mathside_set_class_scores(p_assignment_id uuid, p_scores jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_assignment public.mathside_assignments;
  v_leader uuid; v_rep_score numeric(10,2);
  v_row jsonb; v_student uuid; v_score numeric(10,2);
  v_seen uuid[] := '{}'::uuid[]; v_count integer := 0;
begin
  select * into v_assignment from public.mathside_assignments where id=p_assignment_id for update;
  if v_assignment.id is null or v_assignment.teacher_id is distinct from v_uid or
     not mathside_private.is_teacher(v_uid) or v_assignment.collaboration_mode <> 'class' then
    raise exception 'Only the owning teacher can adjust class scores.';
  end if;
  select g.leader_id into v_leader from public.mathside_performance_groups g where g.assignment_id=p_assignment_id limit 1;
  select s.teacher_score into v_rep_score from public.mathside_submissions s
    where s.assignment_id=p_assignment_id and s.student_id=v_leader and s.status='graded';
  if v_rep_score is null then raise exception 'Grade the class representative submission first.'; end if;
  if jsonb_typeof(p_scores) <> 'array' or jsonb_array_length(p_scores)>500 then raise exception 'Invalid class scores payload.'; end if;
  for v_row in select value from jsonb_array_elements(p_scores) loop
    begin v_student := (v_row->>'student_id')::uuid; exception when others then raise exception 'Invalid learner identifier.'; end;
    if v_student is null or v_student = any(v_seen) then raise exception 'Duplicate or missing learner in adjustments.'; end if;
    v_seen := array_append(v_seen, v_student);
    if v_student=v_leader then raise exception 'Adjust the representative score through the main class score.'; end if;
    if not exists (select 1 from public.mathside_section_members where section_id=v_assignment.section_id and student_id=v_student) then
      raise exception 'Student is not enrolled in this section.';
    end if;
    begin v_score := nullif(v_row->>'score','')::numeric(10,2);
    exception when others then raise exception 'Invalid score value.'; end;
    if v_score is not null and (v_score<0 or v_score>v_assignment.max_points) then
      raise exception 'Scores must be between zero and the task total.';
    end if;
    if v_score is null then
      delete from public.mathside_class_score_overrides where assignment_id=p_assignment_id and student_id=v_student;
    else
      insert into public.mathside_class_score_overrides(assignment_id,student_id,score,changed_by)
      values(p_assignment_id,v_student,v_score,v_uid)
      on conflict(assignment_id,student_id) do update set
        score=excluded.score,changed_by=excluded.changed_by,changed_at=now();
    end if;
    update public.mathside_submissions
      set teacher_score=coalesce(v_score,v_rep_score)
      where assignment_id=p_assignment_id and student_id=v_student and is_class_mirror;
    v_count := v_count+1;
  end loop;
  return jsonb_build_object('updated',v_count);
end; $$;
revoke all on function public.mathside_set_class_scores(uuid,jsonb) from public,anon;
grant execute on function public.mathside_set_class_scores(uuid,jsonb) to authenticated;


commit;


-- Mathside V24.23: Whole-class participation ratings (1-5), matching Group mode.
-- Run AFTER 20-performance-whole-class.sql and 21-fix-class-storage-permissions.sql.
-- Existing Group and Pair scoring behavior is unchanged.
-- Rating 5 => -0, 4 => -2, 3 => -3, 2 => -4, 1 => -5 points.
-- Teacher-entered class score overrides take precedence over leader ratings.
begin;

-- A private, reusable calculation for the actual student score displayed in
-- Mathside student view, competency tracker, teacher review and Excel exports.
create or replace function mathside_private.class_member_score(
  p_assignment_id uuid, p_member_id uuid, p_representative_score numeric
) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare
  v_override numeric(10,2);
  v_rating integer;
begin
  select score into v_override
  from public.mathside_class_score_overrides
  where assignment_id = p_assignment_id and student_id = p_member_id;
  if found then return v_override; end if;
  if p_representative_score is null then return null; end if;

  select r.rating into v_rating
  from public.mathside_performance_participation_ratings r
  join public.mathside_performance_groups g
    on g.id = r.group_id and g.assignment_id = p_assignment_id
  join public.mathside_performance_group_members gm
    on gm.group_id = g.id and gm.student_id = r.member_id
  where r.assignment_id = p_assignment_id
    and r.member_id = p_member_id
    and r.leader_id = g.leader_id;

  if v_rating is null then return null; end if;
  return greatest(0, p_representative_score - case v_rating
    when 5 then 0 when 4 then 2 when 3 then 3 when 2 then 4 when 1 then 5
    else 0 end);
end;
$$;
revoke all on function mathside_private.class_member_score(uuid,uuid,numeric) from public, anon, authenticated;

-- The representative submits once. Mirrors represent every other learner's
-- own graded record (including the participation deduction), not duplicate
-- submissions in the teacher's review inbox.
create or replace function mathside_private.sync_class_submission()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_assignment public.mathside_assignments;
  v_leader uuid;
begin
  if new.is_class_mirror then return new; end if;
  select * into v_assignment from public.mathside_assignments where id = new.assignment_id;
  if v_assignment.id is null or v_assignment.work_type <> 'performance_task'
      or v_assignment.collaboration_mode <> 'class' then return new; end if;
  select leader_id into v_leader from public.mathside_performance_groups
    where assignment_id = new.assignment_id limit 1;
  if v_leader is null or new.student_id <> v_leader then return new; end if;

  if tg_op = 'UPDATE' then
    if new.submitted_at is distinct from old.submitted_at and new.status = 'submitted' then
      delete from public.mathside_class_score_overrides where assignment_id = new.assignment_id;
    end if;
  end if;

  insert into public.mathside_submissions (
    assignment_id, student_id, status, proof_path, proof_paths, auto_score, teacher_score,
    feedback, attempt_count, submitted_at, graded_at, graded_by, updated_at,
    resubmit_allowed, is_class_mirror, class_video_url, class_project_url
  )
  select new.assignment_id, sm.student_id, new.status, new.proof_path, new.proof_paths,
    new.auto_score,
    case when new.status = 'graded' then
      mathside_private.class_member_score(new.assignment_id, sm.student_id, new.teacher_score)
    else null end,
    new.feedback, new.attempt_count, new.submitted_at, new.graded_at, new.graded_by, now(),
    false, true, new.class_video_url, new.class_project_url
  from public.mathside_section_members sm
  where sm.section_id = v_assignment.section_id and sm.student_id <> v_leader
  on conflict (assignment_id, student_id) do update
    set status = excluded.status,
        proof_path = excluded.proof_path,
        proof_paths = excluded.proof_paths,
        auto_score = excluded.auto_score,
        teacher_score = excluded.teacher_score,
        feedback = excluded.feedback,
        attempt_count = excluded.attempt_count,
        submitted_at = excluded.submitted_at,
        graded_at = excluded.graded_at,
        graded_by = excluded.graded_by,
        updated_at = now(),
        resubmit_allowed = false,
        is_class_mirror = true,
        class_video_url = excluded.class_video_url,
        class_project_url = excluded.class_project_url;
  return new;
end;
$$;

-- Preserve the same rating RPC used by Group Mode. New class-only safeguards:
-- every active class member (except the representative) must be rated;
-- archived assignments cannot be modified; only the selected representative
-- may rate their own section. Ratings can be saved separately after submit.
create or replace function public.mathside_save_participation_ratings(
  p_assignment_id uuid, p_group_id uuid, p_ratings jsonb
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_assignment public.mathside_assignments;
  v_item jsonb;
  v_member uuid;
  v_rating integer;
  v_seen uuid[] := '{}'::uuid[];
  v_expected integer;
  v_representative_score numeric(10,2);
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  select * into v_assignment from public.mathside_assignments
    where id = p_assignment_id for update;
  if v_assignment.id is null then raise exception 'Performance task not found.'; end if;
  if not exists (
    select 1 from public.mathside_performance_groups g
    where g.id = p_group_id and g.assignment_id = p_assignment_id
      and g.section_id = v_assignment.section_id and g.leader_id = v_uid
  ) then raise exception 'Only the selected team leader can rate members.'; end if;
  if jsonb_typeof(coalesce(p_ratings, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_ratings, '[]'::jsonb)) > 500 then
    raise exception 'Invalid participation rating list.';
  end if;

  if v_assignment.collaboration_mode = 'class' then
    if v_assignment.status <> 'published' or not mathside_private.is_student(v_uid)
       or not mathside_private.student_in_section(v_assignment.section_id, v_uid) then
      raise exception 'Class participation ratings cannot be changed for this task.';
    end if;
    select count(*) into v_expected
    from public.mathside_performance_group_members gm
    where gm.group_id = p_group_id and gm.student_id <> v_uid;
    if jsonb_array_length(coalesce(p_ratings, '[]'::jsonb)) <> v_expected then
      raise exception 'Rate every class member before saving.';
    end if;
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(p_ratings, '[]'::jsonb)) loop
    begin
      v_member := (v_item->>'member_id')::uuid;
      v_rating := (v_item->>'rating')::integer;
    exception when others then raise exception 'Invalid member rating.'; end;
    if v_rating not between 1 and 5 then raise exception 'Ratings must be from 1 to 5.'; end if;
    if v_member is null or v_member = v_uid or v_member = any(v_seen) or
       not exists (select 1 from public.mathside_performance_group_members gm
                   where gm.group_id = p_group_id and gm.assignment_id = p_assignment_id
                     and gm.student_id = v_member) then
      raise exception 'Invalid or repeated team member rating.';
    end if;
    if v_assignment.collaboration_mode = 'class' and
       not mathside_private.student_in_section(v_assignment.section_id, v_member) then
      raise exception 'A rated learner is not enrolled in this section.';
    end if;
    v_seen := array_append(v_seen, v_member);
    insert into public.mathside_performance_participation_ratings
      (assignment_id, group_id, leader_id, member_id, rating, updated_at)
    values (p_assignment_id, p_group_id, v_uid, v_member, v_rating, now())
    on conflict (assignment_id, member_id) do update set
      group_id = excluded.group_id, leader_id = excluded.leader_id,
      rating = excluded.rating, updated_at = now();
  end loop;

  -- A leader can update a rating while the task is active. Refresh existing
  -- graded mirrors immediately, without overwriting a teacher override.
  if v_assignment.collaboration_mode = 'class' then
    select s.teacher_score into v_representative_score
    from public.mathside_submissions s
    where s.assignment_id = p_assignment_id and s.student_id = v_uid
      and s.status = 'graded' and not s.is_class_mirror;
    if found and v_representative_score is not null then
      update public.mathside_submissions s
      set teacher_score = mathside_private.class_member_score(
            p_assignment_id, s.student_id, v_representative_score),
          updated_at = now()
      where s.assignment_id = p_assignment_id and s.is_class_mirror;
    end if;
  end if;
end;
$$;
revoke all on function public.mathside_save_participation_ratings(uuid,uuid,jsonb) from public,anon;
grant execute on function public.mathside_save_participation_ratings(uuid,uuid,jsonb) to authenticated;

-- Later enrollment of a class member must use the same participation logic.
create or replace function mathside_private.backfill_class_submission_for_enrollment()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.mathside_submissions (
    assignment_id, student_id, status, proof_path, proof_paths, auto_score, teacher_score,
    feedback, attempt_count, submitted_at, graded_at, graded_by, updated_at,
    resubmit_allowed, is_class_mirror, class_video_url, class_project_url
  )
  select a.id, new.student_id, rep.status, rep.proof_path, rep.proof_paths, rep.auto_score,
    case when rep.status = 'graded' then
      mathside_private.class_member_score(a.id, new.student_id, rep.teacher_score)
    else null end,
    rep.feedback, rep.attempt_count, rep.submitted_at, rep.graded_at,
    rep.graded_by, now(), false, true, rep.class_video_url, rep.class_project_url
  from public.mathside_assignments a
  join public.mathside_performance_groups g on g.assignment_id = a.id
  join public.mathside_submissions rep
    on rep.assignment_id = a.id and rep.student_id = g.leader_id
  where a.section_id = new.section_id and a.collaboration_mode = 'class'
    and a.work_type = 'performance_task' and new.student_id <> g.leader_id
  on conflict (assignment_id,student_id) do nothing;
  return new;
end;
$$;

-- Only the owning teacher sees scores, the underlying private ratings,
-- and whether an individual override has been entered.
create or replace function public.mathside_get_class_scores(p_assignment_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_assignment public.mathside_assignments;
  v_leader uuid;
  v_score numeric(10,2);
  v_members jsonb;
begin
  select * into v_assignment from public.mathside_assignments where id = p_assignment_id;
  if v_assignment.id is null or v_assignment.teacher_id is distinct from v_uid or
     not mathside_private.is_teacher(v_uid) or v_assignment.collaboration_mode <> 'class' then
    raise exception 'Only the owning teacher can view these class scores.';
  end if;
  select g.leader_id into v_leader from public.mathside_performance_groups g
    where g.assignment_id = p_assignment_id limit 1;
  select s.teacher_score into v_score from public.mathside_submissions s
    where s.assignment_id = p_assignment_id and s.student_id = v_leader;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'display_name', p.display_name, 'score', s.teacher_score,
    'override', ov.score, 'rating', r.rating,
    'representative', p.id = v_leader
  ) order by p.display_name), '[]'::jsonb) into v_members
  from public.mathside_section_members sm
  join public.mathside_profiles p on p.id = sm.student_id
  left join public.mathside_submissions s
    on s.assignment_id = p_assignment_id and s.student_id = sm.student_id
  left join public.mathside_class_score_overrides ov
    on ov.assignment_id = p_assignment_id and ov.student_id = sm.student_id
  left join public.mathside_performance_participation_ratings r
    on r.assignment_id = p_assignment_id and r.member_id = sm.student_id
  where sm.section_id = v_assignment.section_id;
  return jsonb_build_object('base_score', v_score,
    'max_points', v_assignment.max_points, 'students', v_members);
end;
$$;
revoke all on function public.mathside_get_class_scores(uuid) from public,anon;
grant execute on function public.mathside_get_class_scores(uuid) to authenticated;

-- Explicit teacher adjustments still win over the leader's rating; clearing
-- an adjustment returns the learner to the participation-calculated score.
create or replace function public.mathside_set_class_scores(p_assignment_id uuid, p_scores jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_assignment public.mathside_assignments;
  v_leader uuid;
  v_rep_score numeric(10,2);
  v_row jsonb;
  v_student uuid;
  v_score numeric(10,2);
  v_seen uuid[] := '{}'::uuid[];
  v_count integer := 0;
begin
  select * into v_assignment from public.mathside_assignments
    where id = p_assignment_id for update;
  if v_assignment.id is null or v_assignment.teacher_id is distinct from v_uid or
     not mathside_private.is_teacher(v_uid) or v_assignment.collaboration_mode <> 'class' then
    raise exception 'Only the owning teacher can adjust class scores.';
  end if;
  select g.leader_id into v_leader from public.mathside_performance_groups g
    where g.assignment_id = p_assignment_id limit 1;
  select s.teacher_score into v_rep_score from public.mathside_submissions s
    where s.assignment_id = p_assignment_id and s.student_id = v_leader
      and s.status = 'graded';
  if v_rep_score is null then raise exception 'Grade the class representative submission first.'; end if;
  if jsonb_typeof(p_scores) <> 'array' or jsonb_array_length(p_scores) > 500 then
    raise exception 'Invalid class scores payload.';
  end if;
  for v_row in select value from jsonb_array_elements(p_scores) loop
    begin v_student := (v_row->>'student_id')::uuid;
    exception when others then raise exception 'Invalid learner identifier.'; end;
    if v_student is null or v_student = any(v_seen) then
      raise exception 'Duplicate or missing learner in adjustments.';
    end if;
    v_seen := array_append(v_seen, v_student);
    if v_student = v_leader then raise exception 'Adjust the representative score in the main class grade.'; end if;
    if not exists (select 1 from public.mathside_section_members
                   where section_id = v_assignment.section_id and student_id = v_student) then
      raise exception 'Student is not enrolled in this section.';
    end if;
    begin v_score := nullif(v_row->>'score','')::numeric(10,2);
    exception when others then raise exception 'Invalid score value.'; end;
    if v_score is not null and (v_score < 0 or v_score > v_assignment.max_points) then
      raise exception 'Scores must be between zero and the task total.';
    end if;
    if v_score is null then
      delete from public.mathside_class_score_overrides
      where assignment_id = p_assignment_id and student_id = v_student;
    else
      insert into public.mathside_class_score_overrides (assignment_id,student_id,score,changed_by)
      values(p_assignment_id,v_student,v_score,v_uid)
      on conflict(assignment_id,student_id) do update
        set score = excluded.score, changed_by = excluded.changed_by,
            changed_at = now();
    end if;
    update public.mathside_submissions
       set teacher_score = mathside_private.class_member_score(
             p_assignment_id,v_student,v_rep_score), updated_at = now()
     where assignment_id = p_assignment_id and student_id = v_student
       and is_class_mirror;
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('updated',v_count);
end;
$$;
revoke all on function public.mathside_set_class_scores(uuid,jsonb) from public,anon;
grant execute on function public.mathside_set_class_scores(uuid,jsonb) to authenticated;

-- Upgrade previously graded class tasks without requiring resubmission.
update public.mathside_submissions s
   set teacher_score = mathside_private.class_member_score(
         s.assignment_id, s.student_id, rep.teacher_score),
       updated_at = now()
  from public.mathside_performance_groups g,
       public.mathside_submissions rep,
       public.mathside_assignments a
 where s.assignment_id = a.id
   and a.collaboration_mode = 'class'
   and g.assignment_id = a.id
   and rep.assignment_id = a.id
   and rep.student_id = g.leader_id
   and rep.status = 'graded'
   and s.is_class_mirror;

commit;
notify pgrst, 'reload schema';


-- Mathside V24.22 - fix "permission denied for table mathside_performance_groups"
-- for Class Performance Task proof uploads / proof reads.
-- Run in Supabase SQL Editor AFTER migration 20-performance-whole-class.sql.
-- Safe to rerun. Does not grant direct SELECT on the private teams table.
-- Does not change submissions, scores, storage files, or team membership.
begin;

-- Keep the team tables private, as originally required by teamwork migration 10.
-- A SECURITY DEFINER helper makes only the yes/no leader check available to
-- Storage RLS; callers never query or see the underlying team table.
create or replace function mathside_private.is_class_submission_representative(
  p_assignment_id uuid, p_student_id uuid
) returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_student_id is not null and exists (
    select 1
    from public.mathside_assignments a
    join public.mathside_performance_groups g on g.assignment_id = a.id
    where a.id = p_assignment_id
      and a.work_type = 'performance_task'
      and a.collaboration_mode = 'class'
      and g.leader_id = p_student_id
      and mathside_private.student_in_section(a.section_id, p_student_id)
  );
$$;

-- A classmate may view the chosen representative's proof, even after the
-- task is archived. Students cannot view other sections' proof by this rule.
create or replace function mathside_private.can_read_class_submission_proof(
  p_assignment_id uuid, p_file_owner_id uuid, p_viewer_id uuid
) returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_viewer_id is not null and p_file_owner_id is not null and exists (
    select 1
    from public.mathside_assignments a
    join public.mathside_performance_groups g on g.assignment_id = a.id
    where a.id = p_assignment_id
      and a.work_type = 'performance_task'
      and a.collaboration_mode = 'class'
      and g.leader_id = p_file_owner_id
      and mathside_private.student_in_section(a.section_id, p_viewer_id)
  );
$$;

revoke all on function mathside_private.is_class_submission_representative(uuid, uuid) from public, anon;
revoke all on function mathside_private.can_read_class_submission_proof(uuid, uuid, uuid) from public, anon;
grant execute on function mathside_private.is_class_submission_representative(uuid, uuid) to authenticated;
grant execute on function mathside_private.can_read_class_submission_proof(uuid, uuid, uuid) to authenticated;


commit;

notify pgrst, 'reload schema';
