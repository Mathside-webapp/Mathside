-- Mathside FRESH SUPABASE INSTALL / 2026-10-28
-- Private Cloudflare R2 file object references; R2 upload integration comes later.
-- Run in Supabase SQL Editor in filename order on a BLANK project.

-- Metadata ONLY. Files remain in Cloudflare R2; no Supabase Storage buckets.
begin;
create table public.mathside_file_records (
 id uuid primary key default gen_random_uuid(),
 assignment_id uuid references public.mathside_assignments(id) on delete set null,
 submission_id uuid references public.mathside_submissions(id) on delete set null,
 owner_id uuid not null references public.mathside_profiles(id) on delete cascade,
 object_key text not null unique check (length(object_key) between 1 and 1024),
 original_name text not null,
 mime_type text,
 size_bytes bigint check (size_bytes is null or size_bytes between 0 and 1073741824),
 provider text not null default 'cloudflare-r2' check(provider='cloudflare-r2'),
 uploaded_at timestamptz not null default now()
);
create index mathside_file_records_owner_idx on public.mathside_file_records(owner_id,uploaded_at desc);
create index mathside_file_records_assignment_idx on public.mathside_file_records(assignment_id);
create index mathside_file_records_submission_idx on public.mathside_file_records(submission_id);
alter table public.mathside_file_records enable row level security;
revoke all on public.mathside_file_records from public,anon,authenticated;
grant select on public.mathside_file_records to authenticated;
create policy file_records_read on public.mathside_file_records for select to authenticated
using (owner_id=auth.uid() or exists (
 select 1 from public.mathside_assignments a where a.id=assignment_id and a.teacher_id=auth.uid()
) or exists (
 select 1 from public.mathside_submissions s
 join public.mathside_assignments a on a.id=s.assignment_id
 where s.id=submission_id and a.teacher_id=auth.uid()
));
-- Actual object validation, writes, signed URLs and deletes are server-side
-- tasks for the future Cloudflare Edge Function. Do not allow browser INSERTs.
commit;

notify pgrst, 'reload schema';
