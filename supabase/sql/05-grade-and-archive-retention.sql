-- Mathside FRESH SUPABASE INSTALL / 2026-10-28
-- Grade snapshots, progress history and non-destructive archiving (preserves all files).
-- Run in Supabase SQL Editor in filename order on a BLANK project.

-- MATHSIDE FRESH ARCHIVE TABLES AND GRADE RETENTION.
-- For a new Mathside Supabase project only.
-- This migration installs new objects; it does NOT change historical data or
-- archive/delete any existing activities by itself.
BEGIN;

CREATE TABLE IF NOT EXISTS public.mathside_archived_scores (
  assignment_id uuid NOT NULL REFERENCES public.mathside_assignments(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.mathside_profiles(id) ON DELETE CASCADE,
  score numeric NOT NULL CHECK (score >= 0),
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(assignment_id,student_id)
);
CREATE INDEX IF NOT EXISTS mathside_archived_scores_student_idx
  ON public.mathside_archived_scores(student_id);
ALTER TABLE public.mathside_archived_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mathside_archived_scores_teacher_select ON public.mathside_archived_scores;
CREATE POLICY mathside_archived_scores_teacher_select ON public.mathside_archived_scores
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.mathside_assignments a
    WHERE a.id = assignment_id AND a.teacher_id = (SELECT auth.uid())
  ));
REVOKE ALL ON public.mathside_archived_scores FROM PUBLIC, anon;
GRANT SELECT ON public.mathside_archived_scores TO authenticated;

-- No archive storage cleanup queue: all uploaded file references are retained.

CREATE SCHEMA IF NOT EXISTS mathside_private;

-- Non-destructive archive RPC is defined once, at the end of this file.
-- Original destructive archive implementation intentionally excluded.

-- Access is granted after the non-destructive archive function below.
COMMIT;


-- Retain progress history rows alongside complete student submissions.
BEGIN;

CREATE TABLE IF NOT EXISTS public.mathside_submission_history (
  assignment_id uuid NOT NULL REFERENCES public.mathside_assignments(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.mathside_profiles(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('submitted', 'graded')),
  submitted_at timestamptz,
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, student_id)
);
CREATE INDEX IF NOT EXISTS mathside_submission_history_student_idx
  ON public.mathside_submission_history(student_id);
ALTER TABLE public.mathside_submission_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mathside_submission_history_teacher_select
  ON public.mathside_submission_history;
CREATE POLICY mathside_submission_history_teacher_select
  ON public.mathside_submission_history FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.mathside_assignments a
    WHERE a.id = assignment_id AND a.teacher_id = (SELECT auth.uid())
  ));
REVOKE ALL ON public.mathside_submission_history FROM PUBLIC, anon;
GRANT SELECT ON public.mathside_submission_history TO authenticated;

-- Recover historical CHECKED work for which archive scores were preserved.
INSERT INTO public.mathside_submission_history
  (assignment_id, student_id, status, submitted_at, archived_at)
SELECT s.assignment_id, s.student_id, 'graded', NULL, s.archived_at
FROM public.mathside_archived_scores s
ON CONFLICT (assignment_id, student_id) DO UPDATE
  SET status = 'graded',
      archived_at = excluded.archived_at;

-- Legacy destructive archive implementation is intentionally omitted.
-- Original destructive archive implementation intentionally excluded.

-- Access is granted after the non-destructive archive function below.
COMMIT;


-- MATHSIDE CLASS RECORD RETENTION FIX (October 2026)
-- Historical grade snapshot table for archived class-record exports.
-- New fresh project install; no student submissions are deleted.

BEGIN;
CREATE TABLE IF NOT EXISTS public.mathside_class_record_snapshots (
  assignment_id uuid NOT NULL REFERENCES public.mathside_assignments(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.mathside_profiles(id) ON DELETE CASCADE,
  score numeric,
  display_status text CHECK (display_status IS NULL OR display_status IN ('Pending','Not rated')),
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, student_id),
  CONSTRAINT mathside_class_record_snapshot_value_check CHECK
    (score IS NOT NULL OR display_status IN ('Pending','Not rated')),
  CONSTRAINT mathside_class_record_snapshot_nonnegative CHECK
    (score IS NULL OR score >= 0)
);
CREATE INDEX IF NOT EXISTS mathside_class_record_snapshots_student_idx
  ON public.mathside_class_record_snapshots(student_id);
ALTER TABLE public.mathside_class_record_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mathside_class_record_snapshots_teacher_select
  ON public.mathside_class_record_snapshots;
CREATE POLICY mathside_class_record_snapshots_teacher_select
  ON public.mathside_class_record_snapshots FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.mathside_assignments a
    WHERE a.id = assignment_id AND a.teacher_id = (SELECT auth.uid())
  ));
REVOKE ALL ON public.mathside_class_record_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mathside_class_record_snapshots TO authenticated;

-- Existing historical grade snapshots are retained when available.
INSERT INTO public.mathside_class_record_snapshots
  (assignment_id, student_id, score, display_status, archived_at)
SELECT s.assignment_id, s.student_id, s.score, NULL, s.archived_at
FROM public.mathside_archived_scores s
ON CONFLICT (assignment_id, student_id) DO NOTHING;

-- The frontend checks this RPC before archiving classrooms.
-- In particular, installing the new JS without running the SQL blocks archive.
CREATE OR REPLACE FUNCTION public.mathside_class_record_retention_version()
RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT 'class-record-retention-v1'::text;
$$;
REVOKE ALL ON FUNCTION public.mathside_class_record_retention_version() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mathside_class_record_retention_version() TO authenticated;

-- Legacy destructive archive implementation is intentionally omitted.
-- Original destructive archive implementation intentionally excluded.

-- Access is granted after the non-destructive archive function below.
COMMIT;


-- MATHSIDE Student Grade History Visibility (run ONCE in Supabase SQL Editor)
-- Prerequisite: mathside_submission_history and mathside_archived_scores exist.
-- This DOES NOT archive, delete, or modify any student submissions/grades.
-- Only the owning student can SELECT their own saved history/score rows.
-- Students see archived assignment metadata and questions ONLY if that
-- student actually has a retained submission or score for that activity.
BEGIN;

ALTER TABLE public.mathside_archived_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mathside_submission_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mathside_archived_scores_student_select
  ON public.mathside_archived_scores;
CREATE POLICY mathside_archived_scores_student_select
  ON public.mathside_archived_scores
  FOR SELECT TO authenticated
  USING (student_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS mathside_submission_history_student_select
  ON public.mathside_submission_history;
CREATE POLICY mathside_submission_history_student_select
  ON public.mathside_submission_history
  FOR SELECT TO authenticated
  USING (student_id = (SELECT auth.uid()));

GRANT SELECT ON public.mathside_archived_scores TO authenticated;
GRANT SELECT ON public.mathside_submission_history TO authenticated;

-- A private SECURITY DEFINER check avoids circular RLS checks.
CREATE OR REPLACE FUNCTION mathside_private.student_has_archived_result(p_assignment uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS '
  SELECT (auth.uid() IS NOT NULL) AND (
    EXISTS (SELECT 1 FROM public.mathside_submission_history h
            WHERE h.assignment_id = p_assignment AND h.student_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.mathside_archived_scores s
               WHERE s.assignment_id = p_assignment AND s.student_id = auth.uid())
  );
';
REVOKE ALL ON FUNCTION mathside_private.student_has_archived_result(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mathside_private.student_has_archived_result(uuid) TO authenticated;

DROP POLICY IF EXISTS mathside_assignments_student_archived_result
  ON public.mathside_assignments;
CREATE POLICY mathside_assignments_student_archived_result
  ON public.mathside_assignments
  FOR SELECT TO authenticated
  USING (
    status = 'archived'
    AND (SELECT auth.uid()) IS NOT NULL
    AND mathside_private.student_has_archived_result(id)
  );

-- Total points remain visible for previously graded written work.
-- Answer keys, deleted responses, and student-uploaded files remain private.
DROP POLICY IF EXISTS mathside_questions_student_archived_result
  ON public.mathside_questions;
CREATE POLICY mathside_questions_student_archived_result
  ON public.mathside_questions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.mathside_assignments a
      WHERE a.id = assignment_id
        AND a.status = 'archived'
        AND mathside_private.student_has_archived_result(a.id)
    )
  );

COMMIT;

-- Verify policies exist (this is not an impersonation test).
SELECT tablename, policyname
FROM pg_catalog.pg_policies
WHERE schemaname = 'public' AND policyname IN (
  'mathside_archived_scores_student_select',
  'mathside_submission_history_student_select',
  'mathside_assignments_student_archived_result',
  'mathside_questions_student_archived_result'
)
ORDER BY tablename, policyname;

-- The previous archive RPC deleted students' work and attachments. For this
-- fresh deployment we keep submissions and answers intact in all circumstances.
create or replace function public.mathside_archive_assignments_clean(p_assignment_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_total integer;
  v_ids uuid[];
begin
  if auth.uid() is null or not mathside_private.is_teacher(auth.uid()) then
    raise exception 'Teacher login required';
  end if;
  select array_agg(distinct x) into v_ids from unnest(p_assignment_ids) t(x) where x is not null;
  if v_ids is null or cardinality(v_ids) > 200 then
    raise exception 'Select between 1 and 200 assignments';
  end if;
  select count(*) into v_total from public.mathside_assignments
  where id=any(v_ids) and teacher_id=auth.uid() and status <> 'archived';
  if v_total <> cardinality(v_ids) then
    raise exception 'Some activities do not belong to this teacher or are already archived';
  end if;
  update public.mathside_assignments
  set status='archived',archived_at=now(),updated_at=now()
  where id=any(v_ids) and teacher_id=auth.uid();
  return jsonb_build_object('archived',v_total,'deleted_submissions',0,'files_queued',0);
end; $$;
revoke all on function public.mathside_archive_assignments_clean(uuid[]) from public, anon;
grant execute on function public.mathside_archive_assignments_clean(uuid[]) to authenticated;

notify pgrst, 'reload schema';
