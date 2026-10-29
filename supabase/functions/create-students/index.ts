import { withSupabase } from 'npm:@supabase/server@1.8.0'

type StudentInput = {
  name?: string
  gender?: string
}

const allowedGenders = new Set(['Female', 'Male', 'Prefer not to say', 'Not specified'])

function json(data: unknown, status = 200) {
  return Response.json(data, { status })
}

function slugifyName(name: string) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 22) || 'student'
}

function randomPassword() {
  // 16 high-entropy, readable characters; never derive credentials from names.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const cutoff = 256 - (256 % alphabet.length);
  let result = '';
  while (result.length < 16) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    for (const value of bytes) {
      if (value < cutoff) result += alphabet[value % alphabet.length];
      if (result.length === 16) break;
    }
  }
  return result;
}

const createStudents = withSupabase({ auth: 'user' }, async (req, ctx) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405)
  }

  try {
    const teacherId = String(ctx.userClaims?.id || '')
    if (!/^[0-9a-f-]{36}$/i.test(teacherId)) {
      return json({ error: 'You must be signed in.' }, 401)
    }

    const { data: teacherProfile, error: teacherProfileError } = await ctx.supabase
      .from('mathside_profiles')
      .select('id,role')
      .eq('id', teacherId)
      .single()

    if (teacherProfileError || teacherProfile?.role !== 'teacher') {
      return json({ error: 'Only teacher accounts can create student accounts.' }, 403)
    }

    const body = await req.json().catch(() => ({}))
    const sectionId = String(body?.section_id || '')
    const rawStudents = Array.isArray(body?.students) ? body.students as StudentInput[] : []

    if (!/^[0-9a-f-]{36}$/i.test(sectionId)) {
      return json({ error: 'A valid class is required.' }, 400)
    }
    if (!rawStudents.length || rawStudents.length > 40) {
      return json({ error: 'Send between 1 and 40 students at a time.' }, 400)
    }

    const { data: section, error: sectionError } = await ctx.supabase
      .from('mathside_sections')
      .select('id,teacher_id,grade_level,name')
      .eq('id', sectionId)
      .eq('teacher_id', teacherId)
      .single()

    if (sectionError || !section) {
      return json({ error: 'Class not found or you do not own it.' }, 403)
    }

    const inputs = rawStudents
      .map(student => ({
        name: String(student?.name || '').trim().slice(0, 120),
        gender: allowedGenders.has(String(student?.gender || ''))
          ? String(student?.gender)
          : 'Not specified',
      }))
      .filter(student => student.name)

    if (!inputs.length) {
      return json({ error: 'Enter at least one student name.' }, 400)
    }

    const created: Array<{ name: string; gender: string; username: string; temporary_password: string }> = []
    const failures: Array<{ name: string; error: string }> = []
    const reserved = new Set<string>()

    for (const input of inputs) {
      let createdAuthId = ''

      try {
        const base = `g${section.grade_level}.${slugifyName(input.name)}`
        let username = base
        let suffix = 2

        while (true) {
          if (reserved.has(username)) {
            username = `${base}${suffix++}`
            continue
          }

          const { data: existing, error: aliasError } = await ctx.supabaseAdmin
            .from('mathside_login_aliases')
            .select('username')
            .eq('username', username)
            .maybeSingle()

          if (aliasError) throw aliasError
          if (!existing) break
          username = `${base}${suffix++}`
        }

        reserved.add(username)
        const temporaryPassword = randomPassword()
        const authEmail = `${username}@students.mathside.invalid`

        // Step 1: Create the Auth user. The database trigger deliberately
        // skips Mathside student profile creation for this internal domain.
        const { data: createdUser, error: createError } = await ctx.supabaseAdmin.auth.admin.createUser({
          email: authEmail,
          password: temporaryPassword,
          email_confirm: true,
          user_metadata: {
            display_name: input.name,
          },
        })

        if (createError || !createdUser?.user) {
          throw createError || new Error('Supabase Auth did not return the new user.')
        }

        createdAuthId = createdUser.user.id

        // Step 2: Put authorization fields in server-controlled app_metadata
        // after the Auth row exists.
        const { error: metadataError } = await ctx.supabaseAdmin.auth.admin.updateUserById(
          createdAuthId,
          {
            app_metadata: {
              mathside_role: 'student',
              username,
              gender: input.gender,
              section_id: section.id,
              created_by_teacher: teacherId,
            },
          },
        )
        if (metadataError) throw metadataError

        // Step 3: Create the Mathside profile explicitly with the admin client.
        const { error: profileError } = await ctx.supabaseAdmin
          .from('mathside_profiles')
          .insert({
            id: createdAuthId,
            display_name: input.name,
            role: 'student',
            username,
            gender: input.gender,
            grade_level: section.grade_level,
            created_by_teacher: teacherId,
          })
        if (profileError) throw profileError

        // Step 4: Join the student to the selected class.
        const { error: memberError } = await ctx.supabaseAdmin
          .from('mathside_section_members')
          .insert({
            section_id: section.id,
            student_id: createdAuthId,
          })
        if (memberError) throw memberError

        // Step 5: Save username -> internal Auth email mapping.
        const { error: aliasInsertError } = await ctx.supabaseAdmin
          .from('mathside_login_aliases')
          .insert({
            username,
            user_id: createdAuthId,
            auth_email: authEmail,
          })
        if (aliasInsertError) throw aliasInsertError

        created.push({
          name: input.name,
          gender: input.gender,
          username,
          temporary_password: temporaryPassword,
        })
      } catch (error) {
        console.error('CREATE STUDENT ERROR', input.name, error)

        // Avoid orphaned Auth accounts if any Mathside database step fails.
        if (createdAuthId) {
          try {
            await ctx.supabaseAdmin.auth.admin.deleteUser(createdAuthId)
          } catch (cleanupError) {
            console.error('CREATE STUDENT CLEANUP ERROR', input.name, cleanupError)
          }
        }

        failures.push({
          name: input.name,
          error: error instanceof Error ? error.message : 'Could not create this account.',
        })
      }
    }

    return json({
      ok: failures.length === 0,
      section: { id: section.id, grade_level: section.grade_level, name: section.name },
      created,
      failures,
    })
  } catch (error) {
    console.error('CREATE STUDENTS FUNCTION ERROR', error)
    return json({
      error: error instanceof Error ? error.message : 'Student account creation failed.',
    }, 500)
  }
})

export default { fetch: createStudents }
