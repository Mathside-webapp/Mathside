// Mathside secure Cloudflare R2 file confirmation and private read URLs.
// Deploy as "r2-files" with Verify JWT enabled.
// Uses the same four R2_* secrets as the working r2-upload-url function.
import { withSupabase } from 'npm:@supabase/server@1';
import { GetObjectCommand, HeadObjectCommand, S3Client } from 'npm:@aws-sdk/client-s3@3';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const FILE_REF = new RegExp(`^(${UUID})/(${UUID})/r2-(${UUID})\\.(jpg|png|webp)$`, 'i');
const allowedTypes: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const maxImageSize = 10 * 1024 * 1024;

function fail(error: string, status = 400) {
  return Response.json({ error }, { status });
}

export default {
  fetch: withSupabase({ auth: 'user' }, async (request, ctx) => {
    if (request.method !== 'POST') return fail('Use POST', 405);
    let body: { action?: string; proofPath?: string; originalName?: string };
    try { body = await request.json(); }
    catch { return fail('Invalid JSON request'); }
    const userId = ctx.userClaims?.id;
    if (!userId) return fail('Sign in first', 401);
    const proofPath = String(body.proofPath || '');
    const match = FILE_REF.exec(proofPath);
    if (!match) return fail('Invalid Cloudflare file reference');
    const [, ownerId, assignmentId, fileId, extension] = match;
    const objectKey = `assignments/${assignmentId}/${ownerId}/${fileId}.${extension}`;

    const accountId = Deno.env.get('R2_ACCOUNT_ID');
    const accessKeyId = Deno.env.get('R2_ACCESS_KEY_ID');
    const secretAccessKey = Deno.env.get('R2_SECRET_ACCESS_KEY');
    const bucket = Deno.env.get('R2_BUCKET_NAME');
    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
      return fail('Cloudflare storage secrets are missing', 500);
    }
    const r2 = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED'
    });

    if (body.action === 'confirm') {
      if (ownerId.toLowerCase() !== String(userId).toLowerCase()) return fail('Not your uploaded file', 403);
      const originalName = String(body.originalName || '').trim().slice(0, 255);
      if (!originalName) return fail('Original filename is required');
      // Independent authorization even though the upload URL was already checked.
      const { data: assignment } = await ctx.supabase.from('mathside_assignments')
        .select('id,section_id,status,work_type,collaboration_mode')
        .eq('id', assignmentId).maybeSingle();
      if (!assignment || assignment.status !== 'published') return fail('Assignment is not open', 403);
      const { data: profile } = await ctx.supabase.from('mathside_profiles')
        .select('role').eq('id', userId).maybeSingle();
      if (profile?.role !== 'student') return fail('Only student uploads are supported here', 403);
      const { data: membership } = await ctx.supabase.from('mathside_section_members')
        .select('student_id').eq('section_id', assignment.section_id)
        .eq('student_id', userId).maybeSingle();
      if (!membership) return fail('You are not enrolled in this class', 403);
      if (assignment.work_type === 'performance_task' && assignment.collaboration_mode !== 'individual') {
        const { data: leaders } = await ctx.supabaseAdmin.from('mathside_performance_groups')
          .select('id').eq('assignment_id', assignmentId).eq('leader_id', userId).limit(1);
        if (!leaders?.length) return fail('Only the group or class leader can upload', 403);
      }
      try {
        const head = await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
        const size = Number(head.ContentLength || 0);
        const mime = String(head.ContentType || '').toLowerCase();
        if (!size || size > maxImageSize || mime !== allowedTypes[extension.toLowerCase()]) {
          return fail('Uploaded file does not match the permitted image type or size');
        }
        const { error: writeError } = await ctx.supabaseAdmin.from('mathside_file_records')
          .upsert({
            owner_id: userId,
            assignment_id: assignmentId,
            object_key: objectKey,
            original_name: originalName,
            mime_type: mime,
            size_bytes: size,
            provider: 'cloudflare-r2'
          }, { onConflict: 'object_key' });
        if (writeError) {
          console.error('Mathside file metadata insert failed:', writeError);
          return fail('Could not save the file reference in Supabase', 500);
        }
        return Response.json({ confirmed: true, proofPath });
      } catch (error) {
        console.error('R2 file confirmation failed:', error);
        return fail('The uploaded image was not found in Cloudflare R2', 502);
      }
    }

    if (body.action === 'read') {
      // RLS limits both searches to this user and their authorized records.
      const [{ data: metadata, error: metadataError }, { data: accessibleSubmissions, error: submissionError }] =
        await Promise.all([
          ctx.supabase.from('mathside_file_records')
            .select('id').eq('object_key', objectKey).limit(1),
          ctx.supabase.from('mathside_submissions')
            .select('id').contains('proof_paths', JSON.stringify([proofPath])).limit(1)
        ]);
      if (metadataError || submissionError) {
        console.error('File permission lookup failed:', metadataError || submissionError);
        return fail('Could not verify file access', 500);
      }
      if (!metadata?.length && !accessibleSubmissions?.length) return fail('File access denied', 403);
      try {
        const url = await getSignedUrl(
          r2, new GetObjectCommand({ Bucket: bucket, Key: objectKey }), { expiresIn: 120 }
        );
        return Response.json({ url, expiresIn: 120 });
      } catch (error) {
        console.error('R2 read URL signing failed:', error);
        return fail('Could not open this stored image', 500);
      }
    }
    return fail('Action must be confirm or read');
  })
};
