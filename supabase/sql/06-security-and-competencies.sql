-- Mathside FRESH SUPABASE INSTALL / 2026-10-28
-- RLS indexes, privacy-safe student username login, competency tables and RPCs.
-- Run in Supabase SQL Editor in filename order on a BLANK project.

-- Mathside V24 - login-privacy hardening for EXISTING Supabase databases.
-- Safe to re-run; never changes accounts, passwords, usernames, or student records.
-- IMPORTANT: Run only AFTER checking that every current student auth email is
-- <username>@students.mathside.invalid (see SECURITY-GITHUB-PUBLISHING.md).
-- Only one-time manual execution is needed, not a recurring job.

begin;
create or replace function public.mathside_resolve_login(p_username text)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when lower(btrim(coalesce(p_username, ''))) ~ '^[a-z0-9][a-z0-9._-]{1,78}$'
    then lower(btrim(p_username)) || '@students.mathside.invalid'
    else null
  end;
$$;

-- Existing clients that cache an older JS version can still sign in, but
-- cannot infer whether a student username really exists from this RPC.
revoke all on function public.mathside_resolve_login(text) from public;
grant execute on function public.mathside_resolve_login(text) to anon, authenticated;
commit;


begin;
create index if not exists mathside_assignment_drafts_assignment_id_fk_idx on public.mathside_assignment_drafts(assignment_id);
create index if not exists mathside_performance_group_members_student_id_fk_idx on public.mathside_performance_group_members(student_id);
create index if not exists mathside_performance_groups_leader_id_fk_idx on public.mathside_performance_groups(leader_id);
create index if not exists mathside_performance_groups_section_id_fk_idx on public.mathside_performance_groups(section_id);
create index if not exists mathside_performance_participation_ratings_group_id_fk_idx on public.mathside_performance_participation_ratings(group_id);
create index if not exists mathside_performance_participation_ratings_leader_id_fk_idx on public.mathside_performance_participation_ratings(leader_id);
create index if not exists mathside_performance_participation_ratings_member_id_fk_idx on public.mathside_performance_participation_ratings(member_id);
create index if not exists mathside_profiles_created_by_teacher_fk_idx on public.mathside_profiles(created_by_teacher);
create index if not exists mathside_submission_answers_question_id_fk_idx on public.mathside_submission_answers(question_id);
create index if not exists mathside_submissions_graded_by_fk_idx on public.mathside_submissions(graded_by);
commit;


-- Competency tracker exists in current JavaScript but was absent from uploaded SQL.
begin;
create table if not exists public.mathside_ct_competencies (
 id uuid primary key default gen_random_uuid(),
 name text not null check (char_length(btrim(name)) between 1 and 180),
 teacher_id uuid not null references public.mathside_profiles(id) on delete cascade,
 created_at timestamptz not null default now(),
 unique(teacher_id,name)
);
create table if not exists public.mathside_ct_links (
 assignment_id uuid primary key references public.mathside_assignments(id) on delete cascade,
 competency_id uuid not null references public.mathside_ct_competencies(id) on delete cascade,
 teacher_id uuid not null references public.mathside_profiles(id) on delete cascade,
 created_at timestamptz not null default now()
);
create index if not exists mathside_ct_links_competency_idx on public.mathside_ct_links(competency_id);
create table if not exists public.mathside_ct_reviews (
 competency_id uuid not null references public.mathside_ct_competencies(id) on delete cascade,
 student_id uuid not null references public.mathside_profiles(id) on delete cascade,
 teacher_id uuid not null references public.mathside_profiles(id) on delete cascade,
 level text not null,
 reason text,
 reviewed_at timestamptz not null default now(),
 primary key (competency_id,student_id)
);
create index if not exists mathside_ct_reviews_student_idx on public.mathside_ct_reviews(student_id);
alter table public.mathside_ct_competencies enable row level security;
alter table public.mathside_ct_links enable row level security;
alter table public.mathside_ct_reviews enable row level security;
revoke all on public.mathside_ct_competencies, public.mathside_ct_links, public.mathside_ct_reviews from anon, authenticated;
grant select,insert,update,delete on public.mathside_ct_competencies to authenticated;
grant select on public.mathside_ct_links, public.mathside_ct_reviews to authenticated;
create policy ct_teacher_read on public.mathside_ct_competencies for select to authenticated using (
 teacher_id=auth.uid() or exists(select 1 from public.mathside_assignments a
 join public.mathside_section_members m on m.section_id=a.section_id
 join public.mathside_ct_links l on l.assignment_id=a.id
 where l.competency_id=id and m.student_id=auth.uid() and a.status in ('published','archived')));
create policy ct_teacher_insert on public.mathside_ct_competencies for insert to authenticated with check (
 teacher_id=auth.uid() and mathside_private.is_teacher(auth.uid()));
create policy ct_teacher_update on public.mathside_ct_competencies for update to authenticated
 using(teacher_id=auth.uid()) with check(teacher_id=auth.uid());
create policy ct_teacher_delete on public.mathside_ct_competencies for delete to authenticated using(teacher_id=auth.uid());
create policy ct_links_read on public.mathside_ct_links for select to authenticated using (
 teacher_id=auth.uid() or exists(select 1 from public.mathside_assignments a
 join public.mathside_section_members m on m.section_id=a.section_id
 where a.id=assignment_id and m.student_id=auth.uid() and a.status in ('published','archived')));
create policy ct_reviews_read on public.mathside_ct_reviews for select to authenticated using (
 student_id=auth.uid() or teacher_id=auth.uid());

-- Assign competencies only to the current teacher's own activities.
create or replace function public.mathside_ct_assign_competency(
 p_assignment_ids uuid[], p_competency_id uuid default null
) returns integer language plpgsql security definer set search_path = '' as $$
declare v_total integer;
begin
 if auth.uid() is null or not mathside_private.is_teacher(auth.uid()) then raise exception 'Teacher required'; end if;
 if coalesce(cardinality(p_assignment_ids),0) = 0 or cardinality(p_assignment_ids) > 200 then raise exception 'Select 1-200 activities'; end if;
 select count(*) into v_total from public.mathside_assignments
 where id=any(p_assignment_ids) and teacher_id=auth.uid();
 if v_total<> (select count(distinct x) from unnest(p_assignment_ids) t(x)) then
  raise exception 'One or more activities are not yours'; end if;
 if p_competency_id is not null and not exists (
   select 1 from public.mathside_ct_competencies where id=p_competency_id and teacher_id=auth.uid())
 then raise exception 'Competency not found or not owned'; end if;
 delete from public.mathside_ct_links where assignment_id=any(p_assignment_ids) and teacher_id=auth.uid();
 if p_competency_id is not null then
  insert into public.mathside_ct_links(assignment_id,competency_id,teacher_id)
  select distinct x,p_competency_id,auth.uid() from unnest(p_assignment_ids) t(x);
 end if;
 return v_total;
end; $$;
revoke all on function public.mathside_ct_assign_competency(uuid[],uuid) from public,anon;
grant execute on function public.mathside_ct_assign_competency(uuid[],uuid) to authenticated;

create or replace function public.mathside_ct_delete_competency(p_competency_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
 if not exists(select 1 from public.mathside_ct_competencies
   where id=p_competency_id and teacher_id=auth.uid()) then
  raise exception 'Competency not found or not owned'; end if;
 delete from public.mathside_ct_competencies where id=p_competency_id and teacher_id=auth.uid();
 return true;
end; $$;
revoke all on function public.mathside_ct_delete_competency(uuid) from public,anon;
grant execute on function public.mathside_ct_delete_competency(uuid) to authenticated;

-- Returns only the signed-in student's progress. The website can compute
-- percentages from its already-loaded assignments if no scored work exists.
create or replace function public.mathside_ct_my_progress()
returns jsonb language sql stable security definer set search_path = '' as $$
with eligible as (
 select distinct c.id, c.name
 from public.mathside_ct_competencies c
 join public.mathside_ct_links l on l.competency_id=c.id
 join public.mathside_assignments a on a.id=l.assignment_id
 join public.mathside_section_members m on m.section_id=a.section_id
 where m.student_id=auth.uid() and a.status in ('published','archived')
), sums as (
 select c.id, count(a.id) as total,
  count(s.id) filter (where s.status='graded') as assessed,
  coalesce(sum(coalesce(s.teacher_score,s.auto_score,0)) filter(where s.status='graded'),0) earned,
  coalesce(sum(a.max_points) filter(where s.status='graded'),0) possible,
  coalesce(jsonb_agg(jsonb_build_object('title',a.title,'score',coalesce(s.teacher_score,s.auto_score),
    'max',a.max_points,'archived',a.status='archived') order by a.created_at)
    filter(where s.status='graded'),'[]'::jsonb) history
 from eligible c
 join public.mathside_ct_links l on l.competency_id=c.id
 join public.mathside_assignments a on a.id=l.assignment_id
 join public.mathside_section_members m on m.section_id=a.section_id and m.student_id=auth.uid()
 left join public.mathside_submissions s on s.assignment_id=a.id and s.student_id=auth.uid()
 where a.status in ('published','archived')
 group by c.id
)
select coalesce(jsonb_agg(jsonb_build_object(
 'id',e.id,'name',e.name,'total_activities',s.total,'assessed_activities',s.assessed,
 'percent',case when s.possible>0 then round(100*s.earned/s.possible) else null end,
 'history',s.history,'teacher_level',r.level,'teacher_reason',r.reason)
 order by e.name),'[]'::jsonb)
from eligible e join sums s on s.id=e.id
left join public.mathside_ct_reviews r on r.competency_id=e.id and r.student_id=auth.uid();
$$;
revoke all on function public.mathside_ct_my_progress() from public,anon;
grant execute on function public.mathside_ct_my_progress() to authenticated;
commit;

notify pgrst, 'reload schema';
