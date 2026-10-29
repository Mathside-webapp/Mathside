import { withSupabase } from 'npm:@supabase/server@1.8.0'

function json(data: unknown, status = 200) {
  return Response.json(data, { status })
}

function validUuid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value)
}

function randomPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const cutoff = 256 - (256 % alphabet.length)
  let value = ''
  while (value.length < 16) {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    for (const byte of bytes) {
      if (byte < cutoff) value += alphabet[byte % alphabet.length]
      if (value.length === 16) break
    }
  }
  return value
}

const resetStudentPasswords = withSupabase({ auth: 'user' }, async (req, ctx) => {
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
      return json({ error: 'Only teacher accounts can reset student passwords.' }, 403)
    }

    const body = await req.json().catch(() => ({}))
    const sectionId = String(body?.section_id || '')

    // V23.4 accepts a teacher-chosen password for each selected learner.
    // Keep the older student_ids format as a fallback so an older cached
    // Mathside client can still reset passwords safely with random values.
    const requestedPasswordMap = new Map<string, string>()
    if (Array.isArray(body?.password_resets)) {
      for (const item of body.password_resets.slice(0, 60)) {
        const studentId = String(item?.student_id || '')
        const password = String(item?.password || '').trim()
        if (!validUuid(studentId)) continue
        requestedPasswordMap.set(studentId, password)
      }
    }

    const legacyStudentIds = [...new Set(
      (Array.isArray(body?.student_ids) ? body.student_ids : [])
        .map((value: unknown) => String(value || ''))
        .filter(validUuid)
    )].slice(0, 60)

    const studentIds = requestedPasswordMap.size
      ? [...requestedPasswordMap.keys()]
      : legacyStudentIds

    if (!validUuid(sectionId) || !studentIds.length) {
      return json({ error: 'A valid class and at least one student are required.' }, 400)
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

    const { data: memberships, error: membershipError } = await ctx.supabase
      .from('mathside_section_members')
      .select('student_id')
      .eq('section_id', sectionId)
      .in('student_id', studentIds)

    if (membershipError) throw membershipError
    const memberIds = new Set((memberships || []).map((item: any) => String(item.student_id || '')))

    const { data: profiles, error: profileError } = await ctx.supabase
      .from('mathside_profiles')
      .select('id,display_name,role,username,gender,created_by_teacher')
      .in('id', studentIds)

    if (profileError) throw profileError
    const profileMap = new Map((profiles || []).map((profile: any) => [String(profile.id), profile]))

    const reset: Array<{ id: string; name: string; gender: string; username: string; temporary_password: string }> = []
    const failures: Array<{ id: string; name: string; error: string }> = []

    for (const studentId of studentIds) {
      const student: any = profileMap.get(studentId)
      const name = String(student?.display_name || 'Student')

      try {
        if (!memberIds.has(studentId)) {
          throw new Error('This student is no longer in the selected class.')
        }
        if (!student || student.role !== 'student') {
          throw new Error('Student profile not found.')
        }
        // Password changes affect the Auth account globally. Only the teacher
        // who originally generated the Mathside student account may reset it.
        if (String(student.created_by_teacher || '') !== teacherId) {
          throw new Error('Only the teacher who created this student account can reset its password.')
        }

        const chosenPassword = requestedPasswordMap.size
          ? String(requestedPasswordMap.get(studentId) || '').trim()
          : randomPassword()

        if (chosenPassword.length < 12 || chosenPassword.length > 72) {
          throw new Error('Password must contain 12 to 72 characters.')
        }

        const { error: updateError } = await ctx.supabaseAdmin.auth.admin.updateUserById(studentId, {
          password: chosenPassword,
        })
        if (updateError) throw updateError

        reset.push({
          id: studentId,
          name,
          gender: String(student.gender || 'Not specified'),
          username: String(student.username || ''),
          temporary_password: chosenPassword,
        })
      } catch (error) {
        failures.push({
          id: studentId,
          name,
          error: error instanceof Error ? error.message : 'Could not reset this password.',
        })
      }
    }

    return json({
      ok: failures.length === 0,
      section: { id: section.id, name: section.name, grade_level: section.grade_level },
      reset,
      failures,
    })
  } catch (error) {
    console.error('RESET STUDENT PASSWORDS ERROR', error)
    return json({
      error: error instanceof Error ? error.message : 'Could not reset student passwords.'
    }, 500)
  }
})

export default { fetch: resetStudentPasswords }
