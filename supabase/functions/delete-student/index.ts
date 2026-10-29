import { withSupabase } from 'npm:@supabase/server@1.8.0'

function json(data: unknown, status = 200) {
  return Response.json(data, { status })
}

function validUuid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value)
}

const deleteStudent = withSupabase({ auth: 'user' }, async (req, ctx) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405)
  }

  try {
    const teacherId = String(ctx.userClaims?.id || '')
    if (!validUuid(teacherId)) {
      return json({ error: 'You must be signed in.' }, 401)
    }

    const { data: teacherProfile, error: teacherError } = await ctx.supabase
      .from('mathside_profiles')
      .select('id,role')
      .eq('id', teacherId)
      .single()

    if (teacherError || teacherProfile?.role !== 'teacher') {
      return json({ error: 'Only teacher accounts can manage students.' }, 403)
    }

    const body = await req.json().catch(() => ({}))
    const sectionId = String(body?.section_id || '')
    const studentId = String(body?.student_id || '')
    const deleteAccount = body?.delete_account === true

    if (!validUuid(sectionId) || !validUuid(studentId)) {
      return json({ error: 'A valid class and student are required.' }, 400)
    }

    const { data: section, error: sectionError } = await ctx.supabase
      .from('mathside_sections')
      .select('id,teacher_id,name,grade_level')
      .eq('id', sectionId)
      .eq('teacher_id', teacherId)
      .single()

    if (sectionError || !section) {
      return json({ error: 'Class not found or you do not own it.' }, 403)
    }

    const { data: membership, error: membershipError } = await ctx.supabase
      .from('mathside_section_members')
      .select('section_id,student_id')
      .eq('section_id', sectionId)
      .eq('student_id', studentId)
      .maybeSingle()

    if (membershipError) throw membershipError
    if (!membership) {
      return json({ error: 'This student is no longer in the selected class.' }, 404)
    }

    const { data: student, error: studentError } = await ctx.supabase
      .from('mathside_profiles')
      .select('id,display_name,role,username,created_by_teacher,avatar_path')
      .eq('id', studentId)
      .single()

    if (studentError || !student || student.role !== 'student') {
      return json({ error: 'Student profile not found.' }, 404)
    }

    if (!deleteAccount) {
      const { error: removeError } = await ctx.supabaseAdmin
        .from('mathside_section_members')
        .delete()
        .eq('section_id', sectionId)
        .eq('student_id', studentId)

      if (removeError) throw removeError

      return json({
        ok: true,
        action: 'removed_from_class',
        student: { id: student.id, name: student.display_name, username: student.username },
        section: { id: section.id, name: section.name, grade_level: section.grade_level },
      })
    }

    // Permanent Auth deletion is limited to the teacher who originally
    // created this Mathside student account.
    if (String(student.created_by_teacher || '') !== teacherId) {
      return json({
        error: 'You can remove this student from your class, but only the teacher who created the account can permanently delete it.'
      }, 403)
    }

    // Deleting Auth user cascades through associated Supabase records.
    // Cloudflare R2 objects are not deleted here; cleanup is configured later.
    const { error: deleteError } = await ctx.supabaseAdmin.auth.admin.deleteUser(studentId)
    if (deleteError) throw deleteError
    return json({
      ok: true, action:'account_deleted', deleted_storage_files:0,
      deleted_submission_files:0, deleted_avatar_files:0,
      student:{id:student.id,name:student.display_name,username:student.username},
    })
  } catch (error) {
    console.error('DELETE STUDENT ERROR', error)
    return json({
      error: error instanceof Error ? error.message : 'Could not manage this student account.'
    }, 500)
  }
})

export default { fetch: deleteStudent }
