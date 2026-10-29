/**
 * Private Mathside teacher attachments: confirm an R2 upload and issue
 * short-lived download links. Deploy as r2-teacher-files (Verify JWT ON).
 * Uses existing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 * R2_BUCKET_NAME. Never expose R2 credentials to the website.
 */
import { withSupabase } from 'npm:@supabase/server@1';
import { S3Client, HeadObjectCommand, GetObjectCommand } from 'npm:@aws-sdk/client-s3@3';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TEACHER_REF = new RegExp(`^r2-teacher:(assignments/(${UUID})/(${UUID})/(${UUID})\\.(jpg|png|webp|pdf|docx|pptx|xlsx))$`, 'i');
const MIME: Record<string, string> = {
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};
const BYTES_LIMIT = 25 * 1024 * 1024;
const fail = (error: string, status = 400) => Response.json({ error }, { status });

export default {
  fetch: withSupabase({ auth: 'user' }, async (request, ctx) => {
    if (request.method !== 'POST') return fail('Use POST', 405);
    let body: { action?: string; ref?: string; originalName?: string };
    try { body = await request.json(); } catch { return fail('Invalid JSON'); }
    const userId = String(ctx.userClaims?.id || '').toLowerCase();
    if (!userId) return fail('Sign in first', 401);
    const ref = String(body.ref || '');
    const found = TEACHER_REF.exec(ref);
    if (!found) return fail('Invalid teacher attachment reference', 400);
    const [, objectKey, assignmentId, teacherId, , ext] = found;
    const type = MIME[ext.toLowerCase()];

    const accountId = Deno.env.get('R2_ACCOUNT_ID');
    const accessKeyId = Deno.env.get('R2_ACCESS_KEY_ID');
    const secretAccessKey = Deno.env.get('R2_SECRET_ACCESS_KEY');
    const bucket = Deno.env.get('R2_BUCKET_NAME');
    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
      return fail('Cloudflare storage secrets missing', 500);
    }
    const r2 = new S3Client({
      region: 'auto', endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED'
    });

    if (body.action === 'confirm') {
      if (teacherId.toLowerCase() !== userId) return fail('Not your upload', 403);
      const { data: assignment, error: lookupError } = await ctx.supabase
        .from('mathside_assignments').select('id,teacher_id').eq('id', assignmentId).maybeSingle();
      if (lookupError || !assignment || String(assignment.teacher_id).toLowerCase() !== userId) {
        return fail('You do not own this activity', 403);
      }
      const originalName = String(body.originalName || '').trim().slice(0, 255);
      if (!originalName) return fail('Filename required');
      try {
        const head = await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
        const size = Number(head.ContentLength ?? 0);
        const mime = String(head.ContentType || '').toLowerCase();
        if (!size || size > BYTES_LIMIT || mime !== type) {
          return fail('Uploaded file type or size is invalid');
        }
        const { error } = await ctx.supabaseAdmin.from('mathside_file_records').upsert({
          assignment_id: assignmentId, owner_id: userId,
          object_key: objectKey, original_name: originalName,
          mime_type: mime, size_bytes: size, provider: 'cloudflare-r2'
        }, { onConflict: 'object_key' });
        if (error) {
          console.error('Teacher attachment metadata save failed', error);
          return fail('Could not record teacher attachment in Supabase', 500);
        }
        return Response.json({ confirmed: true, ref });
      } catch (error) {
        console.error('R2 teacher HEAD failed', error);
        return fail('Cloudflare did not confirm uploaded attachment', 502);
      }
    }

    if (body.action === 'read') {
      const { data: record, error: recordError } = await ctx.supabaseAdmin
        .from('mathside_file_records').select('owner_id').eq('object_key', objectKey).maybeSingle();
      if (recordError) return fail('Could not verify file metadata', 500);
      if (!record) return fail('Attachment not registered', 404);

      // Teacher owners can preview their own uploads even before publishing.
      let authorized = String(record.owner_id).toLowerCase() === userId && teacherId.toLowerCase() === userId;
      if (!authorized) {
        // Use authenticated RLS, not service-role access, to determine which
        // assignments a student can see. Check actual references, preventing
        // guessing an object key for a different class or unpublished task.
        const { data: profile, error: profileError } = await ctx.supabase
          .from('mathside_profiles').select('role').eq('id', userId).maybeSingle();
        if (profileError || profile?.role !== 'student') return fail('File access denied', 403);
        for (let page = 0; page < 25 && !authorized; page++) {
          const { data: rows, error } = await ctx.supabase.from('mathside_assignments')
            .select('id,image_path,image_paths,rubric_path,status')
            .eq('status', 'published').range(page * 200, page * 200 + 199);
          if (error) {
            console.error('Teacher attachment permission check failed', error);
            return fail('Could not verify assignment access', 500);
          }
          for (const row of rows || []) {
            if (row.image_path === ref || row.rubric_path === ref ||
                (Array.isArray(row.image_paths) && row.image_paths.includes(ref))) {
              authorized = true;
              break;
            }
          }
          if ((rows || []).length < 200) break;
        }
      }
      if (!authorized) return fail('File access denied', 403);
      try {
        const url = await getSignedUrl(
          r2, new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
          { expiresIn: 120 }
        );
        return Response.json({ url, expiresIn: 120 });
      } catch (error) {
        console.error('Teacher attachment read signing failed', error);
        return fail('Could not open the attachment', 500);
      }
    }
    return fail('Action must be confirm or read');
  }),
};

// END OF r2-teacher-files. Paste the complete file, including this line.
