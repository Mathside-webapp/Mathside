-- Mathside supplemental fix for websites that already ran 01-accounts-core.sql.
-- Adds the field written by the Mathside assignment form.
-- Safe to run on the new Supabase project without deleting data.
BEGIN;
ALTER TABLE public.mathside_assignments
  ADD COLUMN IF NOT EXISTS shuffle_questions boolean NOT NULL DEFAULT false;
COMMIT;
NOTIFY pgrst, 'reload schema';
