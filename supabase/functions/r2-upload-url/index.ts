import { withSupabase } from 'npm:@supabase/server@1';
import { S3Client, PutObjectCommand } from 'npm:@aws-sdk/client-s3@3';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3';

const allowedTypes: Record<string, [string, number]> = {
  'image/jpeg': ['jpg', 10 * 1024 * 1024],
  'image/png': ['png', 10 * 1024 * 1024],
  'image/webp': ['webp', 10 * 1024 * 1024],
  'application/pdf': ['pdf', 25 * 1024 * 1024],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx', 25 * 1024 * 1024],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx', 25 * 1024 * 1024],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx', 25 * 1024 * 1024],
};

function fail(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export default {
  fetch: withSupabase({ auth: 'user' }, async (request, ctx) => {
    if (request.method !== 'POST') return fail('Use POST', 405);

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return fail('Send a JSON request body');
    }

    const userId = ctx.userClaims?.id;
    if (!userId) return fail('Sign in first', 401);

    const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';
    const contentType = typeof body.contentType === 'string' ? body.contentType.trim() : '';
    const sizeBytes = body.sizeBytes;
    const assignmentId = typeof body.assignmentId === 'string' ? body.assignmentId.trim() : '';
    const typeRule = allowedTypes[contentType];

    if (!fileName || fileName.length > 255) return fail('Invalid file name');
    if (!typeRule) return fail('File type not permitted');
    if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > typeRule[1]) {
      return fail(`File exceeds the allowed size for ${contentType}`);
    }
    if (assignmentId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assignmentId)) {
      return fail('Invalid assignment ID');
    }

    const { data: profile, error: profileError } = await ctx.supabase
      .from('mathside_profiles').select('role').eq('id', userId).single();
    if (profileError || !profile) return fail('Account profile not found', 403);

    if (!assignmentId && profile.role !== 'teacher') {
      return fail('Students must upload to an assignment', 403);
    }

    if (assignmentId) {
      const { data: assignment, error } = await ctx.supabase
        .from('mathside_assignments')
        .select('id,section_id,teacher_id,work_type,collaboration_mode,status')
        .eq('id', assignmentId).single();
      if (error || !assignment) return fail('Assignment not available', 403);

      if (profile.role === 'teacher') {
        if (assignment.teacher_id !== userId) return fail('Not your assignment', 403);
      } else {
        if (assignment.status !== 'published') return fail('Assignment not open', 403);
        const { data: member } = await ctx.supabase
          .from('mathside_section_members').select('student_id')
          .eq('section_id', assignment.section_id).eq('student_id', userId).maybeSingle();
        if (!member) return fail('Not enrolled in this classroom', 403);

        if (assignment.work_type === 'performance_task' &&
            assignment.collaboration_mode !== 'individual') {
          const { data: leaderGroup } = await ctx.supabaseAdmin
            .from('mathside_performance_groups').select('id')
            .eq('assignment_id', assignmentId).eq('leader_id', userId).limit(1);
          if (!leaderGroup?.length) return fail('Only the approved group/class leader can upload', 403);
        }
      }
    }

    const accountId = Deno.env.get('R2_ACCOUNT_ID');
    const accessKeyId = Deno.env.get('R2_ACCESS_KEY_ID');
    const secretAccessKey = Deno.env.get('R2_SECRET_ACCESS_KEY');
    const bucket = Deno.env.get('R2_BUCKET_NAME');
    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
      return fail('R2 secrets are not configured', 500);
    }

    // The object key is generated server-side, never supplied by a student.
    const key = `${assignmentId ? `assignments/${assignmentId}` : 'teacher-assets'}/${userId}/${crypto.randomUUID()}.${typeRule[0]}`;
    try {
      const r2 = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true,
        requestChecksumCalculation: 'WHEN_REQUIRED',
      });
      const uploadUrl = await getSignedUrl(
        r2,
        new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
        { expiresIn: 120, signableHeaders: new Set(['content-type']) },
      );
      return Response.json({ uploadUrl, objectKey: key, method: 'PUT', contentType, expiresIn: 120 });
    } catch (error) {
      console.error('R2 URL signing failed:', error);
      return fail('Could not create upload URL', 500);
    }
  }),
};
